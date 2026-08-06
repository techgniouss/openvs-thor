/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpToolset } from '../mcp/manager';
import { SUBAGENT_PREAMBLE } from '../persona/prompts';
import { stripThinking } from '../persona/thinking';
import { TodoItem, UPDATE_TODOS_TOOL, parseTodoUpdate } from '../persona/todos';
import { extractTextToolCalls } from '../providers/toolCalls';
import { AgentStep, CONTINUE_PROMPT, ChatProvider, ChatMessage, ToolCall, ToolSpec, endsInRepeatLoop, isAbortError, isTransientProviderError } from '../providers/types';
import { CACHED_COMPACT_TRIGGER, COMPACT_TRIGGER, canCompact, compactMessages, compactionThreshold, shouldCompact } from './compaction';
import { estimateMessagesTokens, estimateToolsTokens, isContextLengthError, parseTokenLimit, trimMessages } from './context';
import { Guardrails, autoApproves, loadGuardrails, resolveWorkspacePath } from './guardrails';
import { AGENT_TOOLS, ASK_USER_TOOL, AskOption, MAX_ASK_OPTIONS, READ_ONLY_TOOL_NAMES, SPAWN_SUBAGENT_TOOL, ToolApprover, VerifyCommand, asBoolean, asString, commandTextOf, detectVerificationCommands, executeTool, isVerificationCommand } from './tools';

const MCP_PREFIX = 'mcp__';

/**
 * Why a run ended. Every terminal path maps onto one of these so the UI can always
 * tell the user *why* it stopped — a run that just goes quiet is a bug, not an outcome.
 */
export type StopReason = 'done' | 'limit' | 'truncated' | 'filtered' | 'refused' | 'stalled' | 'error';

/** The outcome of {@link AgentRunner.run}. */
export interface RunResult {
	readonly reason: StopReason;
	/** Human-readable explanation shown to the user for non-`done` outcomes. */
	readonly detail?: string;
}

/**
 * How many consecutive max-token cutoffs are auto-resumed before giving up. These
 * rounds deliberately don't consume the step budget: being cut off mid-sentence is
 * the model making progress, not the model spending a turn.
 */
const MAX_TRUNCATION_ROUNDS = 8;

/**
 * How far past `maxSteps` a Full Auto run may extend itself before stopping for good.
 *
 * Under `yolo` the user has already said they don't want to be asked, so stopping a
 * half-finished task at the cap just to collect the word "continue" is a prompt in all but
 * name. The ceiling is what keeps that from becoming an unbounded loop: a model that
 * cannot finish in two budgets is not going to finish in three, and the run has to end
 * somewhere that isn't the user's token bill. Stricter policies keep the plain cap —
 * there, being asked is the point.
 *
 * Two rather than five because the step count is the wrong unit for the cost: with the
 * default 100-step budget a factor of five authorised 500 model calls, each re-sending the
 * whole conversation, on a task the model had already failed to finish twice over. The
 * wall-clock ceiling ({@link DEFAULT_MAX_RUN_MS}) bounds the other axis.
 */
const AUTO_EXTEND_FACTOR = 2;

/**
 * Wall-clock ceiling for one top-level run, in ms.
 *
 * The step budget bounds how many times the model is asked, not how long the asking takes,
 * and those two came apart badly on queued free tiers: the transport allows 150s to first
 * byte with one retry, the loop then re-asks a failed step three times, and a single step
 * can burn a quarter of an hour without the step counter moving at all. Thirty minutes is
 * far longer than any task that is actually progressing and short enough that a run which
 * has stopped progressing is handed back rather than left grinding. `continue` resumes.
 */
const DEFAULT_MAX_RUN_MS = 30 * 60 * 1_000;

/**
 * Estimated-token ceiling for the conversation sent each step. Well under the window of
 * every current tool-capable model, leaving room for the estimate being approximate and
 * for the model's own reply.
 */
const DEFAULT_CONTEXT_TOKENS = 120_000;

/** Floor for the adaptive budget, so repeated shrinking can't starve the conversation. */
const MIN_CONTEXT_TOKENS = 8_000;

/**
 * Floor once a backend has stated its own per-request ceiling. The normal floor is an
 * assumption about what a conversation needs; a stated ceiling is a fact about what the
 * backend will accept, and holding 8k against a stated 8k guarantees every later step is
 * rejected too. Below this there is no room for even one file, so the run should fail
 * loudly rather than crawl.
 */
const MIN_STATED_CONTEXT_TOKENS = 1_000;

/**
 * Share of a stated per-request ceiling left for the model's reply, and the floor under it.
 *
 * The ceiling covers prompt *and* reserved output: Groq counted a 5k prompt plus the
 * default 8192 `max_tokens` as 13,155 against a limit of 8,000, so trimming the
 * conversation alone can never get under it — the reply reservation has to come down too.
 */
const STATED_OUTPUT_SHARE = 0.25;
const MIN_OUTPUT_TOKENS = 512;

/** Fraction of a stated ceiling actually spent, since our token count is an estimate. */
const STATED_LIMIT_SHARE = 0.9;

/**
 * Consecutive summarizer failures tolerated before compaction is abandoned for the run.
 * More than one because a single failure is usually a rate limit or a network blip, and
 * giving up on the first would forfeit compaction for the rest of a long run.
 */
const MAX_SUMMARIZER_FAILURES = 2;

/**
 * How many consecutive empty replies are retried before the run gives up. A step with
 * neither text nor a tool call is never an answer — it means the turn was lost (gateway
 * cut the stream after its terminal event, an empty completion, a reasoning-only reply
 * whose visible text never arrived). Like truncation, these rounds don't consume the
 * step budget: no work was done, so no budget was spent.
 */
const MAX_EMPTY_ROUNDS = 3;

/**
 * How many times a step is re-asked after a *transient* provider failure — a dropped
 * stream, a 5xx, a gateway that timed out queueing the request.
 *
 * Without this the run simply threw: the conversation being worked on lives only in
 * `run`'s local `messages`, so one flaky socket twenty steps into a task destroyed every
 * file read and command result gathered so far, and the user's only recovery was to type
 * "continue" into a chat that no longer remembered any of it. The provider layer already
 * retries the HTTP request itself; this is the layer above, covering failures that only
 * become visible once the stream has started. Like truncation and empty replies, these
 * rounds don't consume the step budget — no work was done, so none was spent.
 */
const MAX_STEP_RETRIES = 3;

/** Backoff before re-asking a step, by retry index. Short: the transport already backed off. */
const STEP_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * How many times the *same* call (same tool, same arguments) may fail before the loop
 * stops running it and tells the model to change approach.
 *
 * A model that cannot get a tool to work re-sends the identical call indefinitely —
 * the same bad path, the same missing binary, the same failing edit — burning the step
 * budget on an outcome that is already known. Three attempts is enough for a genuinely
 * flaky operation (a file mid-save, a busy port) and short of a loop the user notices.
 */
const MAX_IDENTICAL_FAILURES = 3;

/**
 * The continuation round from which the resume prompt also tells the model to change
 * tactics. Past this point "continue where you stopped" is demonstrably not working —
 * the model is writing one enormous answer (or thinking without ever emitting a visible
 * turn) and will keep being cut at the same place until the round cap kills the run.
 */
const TRUNCATION_BRAKE_ROUND = 3;

/** Appended to {@link CONTINUE_PROMPT} once continuations stop paying off. */
const TRUNCATION_BRAKE_PROMPT =
	'\n\nYou have now been cut off several times in a row, so stop writing one long answer. '
	+ 'Do the work in small steps with your tools instead: make ONE tool call now — write or '
	+ 'edit a single file, or run a single command — and keep any prose to a sentence or two.';

/**
 * Injected when a step produces prose but no tool call. Models routinely narrate a
 * next action ("now I'll update the config") without performing it; treating that as
 * "finished" was the main cause of runs stopping mid-task. One nudge per quiet
 * stretch — if the model stays quiet after being asked, it really is done.
 */
const COMPLETION_CHECK_PROMPT =
	'Before you finish: if the task is fully complete and verified, reply with a brief final ' +
	'summary of what changed. If ANY part remains — files still to edit, commands still to run, ' +
	'unchecked items on your checklist, or a next step you just described — do it now with your ' +
	'tools instead of summarizing. Do not stop to ask whether to continue; if you truly need a ' +
	'decision from the user, call ask_user instead of describing the question.';

/**
 * How many times each reason may push the model back to work within one quiet stretch.
 *
 * One each. Every nudge is a full round trip at the most expensive moment of the run —
 * the conversation is at its longest and the model has already stopped working — so the
 * second attempt at the same reason costs more than almost any step that did real work.
 * A model that ignores a reminder quoting its own outstanding checklist item is not going
 * to comply the second time it is quoted; the first ask is the one that pays. All counters
 * reset whenever the model does real tool work, so a long task is never capped overall.
 */
const NUDGE_LIMITS: Record<string, number> = { todos: 1, verify: 1, generic: 1 };

/**
 * Injected when the model stops while its own checklist still has open items. Models
 * routinely declare victory with half their plan outstanding; quoting the list back is
 * far more effective than a generic "are you done?", and it also restores a checklist
 * that compaction may have summarized away.
 */
function unfinishedTodoPrompt(items: TodoItem[]): string {
	const open = items.filter(t => t.status !== 'completed');
	const rendered = open.map(t => `- [${t.status}] ${t.content}`).join('\n');
	return 'You stopped, but your own checklist still has open items:\n'
		+ `${rendered}\n\n`
		+ 'Either finish them now with your tools, or — if one is genuinely no longer needed — call '
		+ 'update_todos to correct the list and say why. Do not end the task with items outstanding.';
}

/**
 * Injected when the model wrote to the workspace and then stopped without ever running a
 * verification command. "It should compile" is not evidence, and handing back an
 * unverified change is the failure the user notices.
 *
 * `commands` are the ones this workspace actually offers, so the nudge names something
 * real instead of gesturing at "the tests". The gate does not fire at all when the list
 * is empty — see {@link AgentRunner.completionNudge}.
 */
function verifyPrompt(commands: VerifyCommand[]): string {
	// A command belonging to another workspace folder carries the cwd the model has to pass;
	// without it the model would run the first folder's build and report the change verified.
	const rendered = commands
		.map(c => c.cwd ? `\`${c.command}\` (with cwd: "${c.cwd}")` : `\`${c.command}\``)
		.join(' or ');
	return 'You changed files in this run but never ran a command to check them. Run '
		+ `${rendered} with run_command now and fix anything it reports. `
		+ 'Do not summarize the work as finished until it passes.';
}

/**
 * Injected after an empty reply. Deliberately short and concrete: the previous request
 * is unchanged, so the most likely fix is simply asking again for the next action.
 */
const EMPTY_REPLY_PROMPT =
	'Your last reply arrived empty. Continue the task from where you left off: state the ' +
	'next action and take it with your tools now.';

export interface AgentCallbacks {
	/** A new model step is beginning (open a fresh streaming bubble). */
	onStepStart(): void;
	/** A streamed narration delta for the current step. */
	onToken(delta: string): void;
	/** The current step finished producing text (authoritative full content). */
	onStepEnd(content: string): void;
	/** A tool call is about to run. */
	onToolStart(call: ToolCall): void;
	/** A tool call finished. */
	onToolEnd(call: ToolCall, result: string, isError: boolean): void;
	/** An out-of-band note (e.g. reaching the step limit). */
	onNote(text: string): void;
	/** The agent replaced its visible task checklist (top-level agent only). */
	onTodos?(items: TodoItem[]): void;
}

interface AgentParams {
	model: string;
	apiKey: string;
	baseUrl: string;
	maxTokens: number;
	signal: AbortSignal;
}

/** Shared, run-wide caps so nested sub-agents can't multiply cost without bound. */
interface SubagentBudget {
	spawned: number;
}

interface AgentOptions {
	guardrails?: Guardrails;
	/** Nesting depth (0 = the top-level agent). */
	depth?: number;
	/** Shared spawn counter across the whole run. */
	budget?: SubagentBudget;
	/** Read-only sub-agents get only inspection tools and can't spawn or write. */
	readOnly?: boolean;
	/** Connected MCP servers whose tools are offered alongside the built-ins. */
	mcp?: McpToolset;
	/**
	 * Drains user steering messages typed while the run is in flight. Checked before
	 * each step; returned texts are injected as user turns so the model course-corrects
	 * without the run being restarted.
	 */
	steering?: () => string[];
	/** Estimated-token ceiling for the conversation sent each step. 0 disables trimming. */
	maxContextTokens?: number;
	/**
	 * Upper bound on the reply reservation, below whatever the user configured. Set only by
	 * a parent that has already learned a backend's per-request ceiling the hard way — a
	 * sub-agent inheriting the shrunken conversation budget but not the shrunken reply
	 * reservation would re-earn the same rejection on its first step.
	 */
	maxOutputTokens?: number;
	/** Model context window in tokens; enables auto-compaction at 70% of it. 0/absent disables compaction. */
	contextWindow?: number;
	/**
	 * How many leading seed messages compaction must preserve verbatim. The seed is
	 * `[system, attached context?, the request, …]`, so without this compaction would
	 * keep the context blob and summarize away the request. See `compactMessages`.
	 */
	keepHead?: number;
	/**
	 * Backoff before each retry of a failed step, in ms. Injectable so the retry paths can
	 * be tested without the suite sleeping through the real schedule — the alternative is
	 * a unit test that costs twelve seconds of wall clock to assert on control flow.
	 * Defaults to {@link STEP_RETRY_DELAYS_MS}.
	 */
	retryDelaysMs?: readonly number[];
	/**
	 * Wall-clock ceiling for the whole run, in ms. 0 disables it. Defaults to
	 * {@link DEFAULT_MAX_RUN_MS}. Sub-agents inherit the parent's remaining time rather
	 * than a fresh budget — see {@link AgentRunner.runSubagent}.
	 */
	maxRunMs?: number;
	/**
	 * Emit a per-step timing/size note. Off by default: on a healthy run it is noise, but
	 * it is the only way to tell a run that is slow because the prompt is huge from one
	 * that is slow because the provider is queueing.
	 */
	traceTiming?: boolean;
	/** Reads the clock. Injectable so the wall-clock ceiling is testable without sleeping. */
	now?: () => number;
}

/**
 * Runs the autonomous agent loop: repeatedly asks the model what to do, executes any
 * requested tools (with approval + guardrails for side effects), and feeds the results
 * back until the model stops or the step budget is exhausted. The model may also call
 * `spawn_subagent` to delegate focused subtasks to nested agents — read-only research
 * sub-agents can run in parallel; write-capable ones run sequentially.
 */
export class AgentRunner {
	private readonly guardrails: Guardrails;
	private readonly depth: number;
	private readonly budget: SubagentBudget;
	private readonly readOnly: boolean;
	private readonly mcp?: McpToolset;
	private readonly steering?: () => string[];
	private readonly contextWindow: number;
	private readonly keepHead?: number;
	private readonly retryDelaysMs: readonly number[];
	private readonly maxRunMs: number;
	private readonly traceTiming: boolean;
	/**
	 * Share of the window at which this run compacts. Derived from the provider, because
	 * whether compaction is worth doing early depends entirely on whether a long prompt is
	 * expensive — which is a property of the backend, not of the conversation.
	 */
	private readonly compactTrigger: number;
	private readonly now: () => number;
	/** When this run started, so the wall-clock ceiling and the closing summary agree on elapsed. */
	private startedAt = 0;
	/** Largest prompt this run sent, in estimated tokens — the number that explains a slow run. */
	private peakPromptTokens = 0;
	/** Estimated tokens in the most recently sent prompt, for the per-step timing trace. */
	private lastPromptTokens = 0;
	/** Set once compacting stops paying for itself, so the run doesn't re-summarize every few steps. */
	private compactionExhausted = false;
	/** Consecutive summarizer failures; reset by any success, so a one-off blip isn't terminal. */
	private summarizerFailures = 0;
	private contextBudget: number;
	/** The model's latest checklist, so completion can be checked against its own plan. */
	private todos: TodoItem[] = [];
	/** True once this run wrote to the workspace with no successful verification run since. */
	private unverifiedWrites = false;
	/**
	 * Commands that ran successfully since the last write. Kept because whether a command
	 * counts as verification can only be judged fully against the workspace's own detected
	 * commands, and that probe is async while the bookkeeping is not.
	 */
	private ranCommands: string[] = [];
	/** How often each completion-nudge reason has fired in the current quiet stretch. */
	private readonly nudgeCounts = new Map<string, number>();
	/**
	 * Read-only calls already answered since the workspace (or the transcript) last
	 * changed, keyed by {@link repeatKey}. Cleared by anything that can invalidate a
	 * result — a write, a command, an MCP call, a sub-agent, a compaction.
	 */
	private readonly answeredReads = new Set<string>();
	/**
	 * Consecutive failures per {@link repeatKey}, so a call that cannot work is stopped
	 * rather than retried forever. Cleared wholesale by any successful tool call — the
	 * thing that was blocking it may be exactly what that call just fixed.
	 */
	private readonly failedCalls = new Map<string, number>();
	/** Memoized workspace probe for verification commands; undefined until first needed. */
	private verifyCommands?: Promise<VerifyCommand[]>;
	/** Memoized estimate of what the tool schemas add to every request. */
	private toolTokens?: number;
	/** Reply ceiling adopted after a backend named a per-request token limit; unset until then. */
	private outputCap?: number;
	/** Floor under the adaptive budget; lowered once a backend names a ceiling of its own. */
	private contextFloor = MIN_CONTEXT_TOKENS;

	constructor(
		private readonly provider: ChatProvider,
		private readonly approver: ToolApprover,
		private readonly maxSteps: number,
		opts?: AgentOptions,
	) {
		this.guardrails = opts?.guardrails ?? loadGuardrails();
		this.depth = opts?.depth ?? 0;
		this.budget = opts?.budget ?? { spawned: 0 };
		this.readOnly = opts?.readOnly ?? false;
		this.mcp = opts?.mcp;
		this.steering = opts?.steering;
		this.contextBudget = opts?.maxContextTokens ?? DEFAULT_CONTEXT_TOKENS;
		this.outputCap = opts?.maxOutputTokens;
		if (this.outputCap) {
			// The inherited budget was derived from a stated ceiling; the normal floor would
			// silently raise it back over that ceiling before the first request.
			this.contextFloor = MIN_STATED_CONTEXT_TOKENS;
		}
		this.contextWindow = opts?.contextWindow ?? 0;
		this.keepHead = opts?.keepHead;
		this.retryDelaysMs = opts?.retryDelaysMs?.length ? opts.retryDelaysMs : STEP_RETRY_DELAYS_MS;
		this.compactTrigger = provider.info.cachesPrompts ? CACHED_COMPACT_TRIGGER : COMPACT_TRIGGER;
		this.maxRunMs = opts?.maxRunMs ?? DEFAULT_MAX_RUN_MS;
		this.traceTiming = opts?.traceTiming ?? false;
		this.now = opts?.now ?? Date.now;
	}

	/**
	 * Forgets every cached read, so the next one goes back to disk.
	 *
	 * Called when the workspace changed from outside the run — the user saving a file the
	 * agent had already read. Without it the repeat-read guard answers a legitimate re-read
	 * with "nothing has changed since", which is then simply false: the model is refused the
	 * one call that would have shown it the edit it is being asked to work with.
	 */
	invalidateReads(): void {
		this.answeredReads.clear();
	}

	/** The tools offered this run: read-only set for research sub-agents; otherwise the full set, plus delegation and any MCP tools. */
	private tools(): ToolSpec[] {
		if (this.readOnly) {
			const readTools = AGENT_TOOLS.filter(t => READ_ONLY_TOOL_NAMES.includes(t.name));
			// The top-level read-only loop is Ask/Plan, where the user is present and a
			// clarifying question is often the right move. Research sub-agents are not
			// (nobody is watching them), so they never get it.
			return this.depth === 0 ? [...readTools, ASK_USER_TOOL] : readTools;
		}
		const base = [...AGENT_TOOLS];
		if (this.depth === 0) {
			base.push(UPDATE_TODOS_TOOL, ASK_USER_TOOL);
		}
		if (this.depth < this.guardrails.maxSubagentDepth && this.budget.spawned < this.guardrails.maxSubagents) {
			base.push(SPAWN_SUBAGENT_TOOL);
		}
		if (this.mcp) {
			base.push(...this.mcp.tools());
		}
		return base;
	}

	async run(seed: ChatMessage[], params: AgentParams, callbacks: AgentCallbacks): Promise<RunResult> {
		if (!this.provider.runAgentStep) {
			throw new Error(`${this.provider.info.label} does not support Agent mode.`);
		}
		this.startedAt = this.now();
		try {
			return await this.loop(seed, params, callbacks);
		} finally {
			// In `finally` so an aborted or thrown run still reports what it cost. Sub-agents
			// stay silent: their notes are already relayed through the parent's transcript,
			// and a summary per delegate would bury the one that matters. So does the
			// read-only Ask/Plan loop — a line of run accounting under every answer to a
			// question is noise, and none of the costs it reports are news there.
			if (this.depth === 0 && !this.readOnly) {
				callbacks.onNote(this.runSummary());
			}
		}
	}

	/** One line of run accounting: how long it took, and how big the prompt got. */
	private runSummary(): string {
		const seconds = Math.round((this.now() - this.startedAt) / 1_000);
		const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
		return `Run finished in ${elapsed}; largest prompt sent was ~${Math.round(this.peakPromptTokens / 1_000)}k tokens. `
			+ 'A large prompt is what makes each step slow on providers without prompt caching — '
			+ 'lower "openvsChat.agent.maxContextTokens" to force earlier compaction.';
	}

	/** Whether the run has used up its wall-clock allowance. */
	private outOfTime(): boolean {
		return this.maxRunMs > 0 && this.now() - this.startedAt >= this.maxRunMs;
	}

	private async loop(seed: ChatMessage[], params: AgentParams, callbacks: AgentCallbacks): Promise<RunResult> {
		const messages: ChatMessage[] = [...seed];
		let truncationRounds = 0;
		let emptyRounds = 0;
		let stepRetries = 0;
		// Text carried across a max-token cutoff, plus how many provisional turns hold it in
		// `messages`. The pieces are rejoined before the next step is judged, so a response
		// the limit cut in half is read as the one answer the model meant to write.
		let carry = '';
		let carryTurns = 0;
		// Full Auto extends itself rather than stopping to be told "continue"; every other
		// policy stops at the cap. Sub-agents never extend: their budget is a share of their
		// parent's, and letting each one quintuple it multiplies out across a whole tree.
		const extends_ = this.depth === 0 && this.guardrails.approval === 'yolo';
		const stepCeiling = extends_ ? this.maxSteps * AUTO_EXTEND_FACTOR : this.maxSteps;
		// Budgets already announced, so the notice lands once per extension rather than
		// once per step past the cap.
		let extensions = 0;

		for (let step = 0; step < stepCeiling;) {
			if (params.signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			// Checked per step rather than per second: cutting a run off mid-tool-call would
			// leave a half-applied edit, and the point is to stop starting new work, not to
			// interrupt work in progress.
			if (this.outOfTime()) {
				return {
					reason: 'limit',
					detail: `The run hit its ${Math.round(this.maxRunMs / 60_000)}-minute ceiling after ${step} steps with the task unfinished. `
						+ 'Send "continue" to keep going, or raise "openvsChat.agent.maxRunMinutes".',
				};
			}
			// Extending silently would leave a run that looks stuck at 100 steps indistinguishable
			// from one quietly burning five times the budget, so each extension says so once.
			const budgetsUsed = Math.floor(step / this.maxSteps);
			if (budgetsUsed > extensions) {
				extensions = budgetsUsed;
				callbacks.onNote(`Past the ${this.maxSteps}-step budget (${step} steps in, extension ${extensions} of ${AUTO_EXTEND_FACTOR - 1}) — Full Auto keeps going. Press Stop to end the run.`);
			}

			// Course corrections typed while the previous step ran enter the loop here.
			// They go in *before* any provisional continuation turns, not after: the
			// truncation path below removes that block by index from the tail, so appending
			// here would have it delete the steering message and the resume prompt instead,
			// leaving the half-written answer stranded in the history — the user's correction
			// silently discarded and the transcript corrupted in the same move.
			const steered = this.steering?.() ?? [];
			if (steered.length) {
				messages.splice(messages.length - carryTurns, 0,
					...steered.map(note => ({ role: 'user' as const, content: note })));
			}

			// Compact ahead of the hard budget: replace old middle turns with a summary
			// once past the trigger share of the model's window, so the model keeps a
			// coherent task memory instead of trim markers.
			// `canCompact` is checked separately from the result: "not enough middle yet"
			// is transient and resolves as the run grows, so it must never be mistaken for
			// a failure — doing so used to disable compaction for a whole run at step 0.
			// Never mid-continuation: the provisional turns below are spliced back out by
			// index, and summarizing them away would also throw out the half-written answer.
			if (this.contextWindow && !this.compactionExhausted && !carryTurns
				&& shouldCompact(messages, this.contextWindow, this.contextBudget, this.compactTrigger, this.toolOverhead())
				&& canCompact(messages, this.keepHead)) {
				const compacted = await this.compact(messages, params);
				if (compacted) {
					this.summarizerFailures = 0;
					messages.splice(0, messages.length, ...compacted.messages);
					// Summarizing replaces the turns that held those results, so "you already
					// read that, scroll up" stops being true — the model may legitimately
					// need to read it again.
					this.answeredReads.clear();
					callbacks.onNote(`Compacted the conversation (~${Math.round(compacted.before / 1000)}k → ~${Math.round(compacted.after / 1000)}k tokens).`);
					// Give up only when the protected head ALONE is over the threshold —
					// nothing further can shrink it, so summarizing again would buy nothing.
					// Judging by the post-compaction total instead would misfire whenever the
					// verbatim recent turns are merely bulky: those roll into the compactable
					// middle within a step or two, and compacting them does pay off.
					const head = messages.slice(0, this.keepHead ?? 0);
					if (estimateMessagesTokens(head) >= compactionThreshold(this.contextWindow, this.contextBudget, this.compactTrigger)) {
						this.compactionExhausted = true;
						callbacks.onNote('The conversation is still near the context limit after compacting — older tool output will be trimmed from here on.');
					}
				} else if (++this.summarizerFailures >= MAX_SUMMARIZER_FAILURES) {
					// Persistent failure (not a one-off rate limit), so stop paying for it.
					this.compactionExhausted = true;
				}
			}

			callbacks.onStepStart();
			const startedStep = this.now();
			let raw: AgentStep;
			try {
				raw = await this.step(messages, params, callbacks);
			} catch (err) {
				// An abort is the user's decision and belongs to the caller. The signal is
				// checked as well as the error shape: whatever a runtime chooses to throw on
				// cancellation, a run whose signal is aborted was cancelled — and misreading
				// that as a provider failure would pop an error toast when the user pressed
				// Stop, which is the one outcome they explicitly asked for.
				if (params.signal.aborted || isAbortError(err)) {
					throw new DOMException('Aborted', 'AbortError');
				}
				const message = err instanceof Error ? err.message : String(err);
				// The bubble opened by onStepStart has to be closed either way, or the UI keeps
				// streaming a step that will never arrive. Empty content discards whatever the
				// failed attempt streamed — the retry re-streams it from the start.
				callbacks.onStepEnd('');
				if (!isTransientProviderError(message) || stepRetries >= MAX_STEP_RETRIES) {
					// Ending with a result rather than throwing keeps everything the run
					// accomplished on screen and says plainly why it stopped.
					return {
						reason: 'error',
						detail: stepRetries
							? `The provider kept failing after ${stepRetries} retries, so the run stopped with the task unfinished: ${message}`
							: `The run stopped because the provider failed: ${message}`,
					};
				}
				const delayMs = this.retryDelaysMs[Math.min(stepRetries, this.retryDelaysMs.length - 1)];
				stepRetries++;
				callbacks.onNote(`${message} — retrying step (${stepRetries}/${MAX_STEP_RETRIES}) in ${Math.round(delayMs / 1000)}s…`);
				await delay(delayMs, params.signal);
				continue;
			}
			// The step arrived, so earlier failures were a blip rather than a broken provider.
			stepRetries = 0;
			if (this.traceTiming) {
				const secs = ((this.now() - startedStep) / 1_000).toFixed(1);
				callbacks.onNote(`step ${step + 1}: ${secs}s · ~${Math.round(this.lastPromptTokens / 1_000)}k prompt tokens · ${raw.toolCalls.length} tool call(s)`);
			}
			callbacks.onStepEnd(raw.content);

			// Rejoin the halves of a response the token limit split before judging it. A tool
			// call the model wrote as text (`<tool_call>…`, a fenced JSON object) parses in
			// neither half alone, so without this the model re-writes the same call every
			// continuation round, gets cut at the same place, and the run dies on the round
			// cap having done nothing — the "kept hitting its output limit" dead end.
			const result = carry ? this.recoverTextToolCalls({ ...raw, content: carry + raw.content }) : raw;

			// A provider-side block ends the run, but must never be mistaken for success.
			if (result.finishReason === 'filtered' || result.finishReason === 'refused') {
				return {
					reason: result.finishReason,
					detail: result.finishReason === 'filtered'
						? 'The provider blocked this response with its content filter. Rephrase the request or switch models.'
						: 'The model refused to continue with this request.',
				};
			}

			// Cut off by the token limit mid-answer: resume where it stopped. This is the
			// model making progress, so it doesn't spend a step of the budget.
			if (!result.toolCalls.length && result.truncated) {
				// A model stuck emitting the same line runs out of output budget doing it, which
				// looks exactly like an answer clipped mid-sentence. Resuming it just buys the
				// loop another budget, once per round — so a repeat ends the run instead.
				if (endsInRepeatLoop(result.content)) {
					return {
						reason: 'stalled',
						detail: 'The model fell into repeating itself until it ran out of output budget, so the run stopped rather than resuming it. Send "continue" to retry, or switch models.',
					};
				}
				if (truncationRounds >= MAX_TRUNCATION_ROUNDS) {
					return {
						reason: 'truncated',
						detail: `The model kept hitting its output limit after ${MAX_TRUNCATION_ROUNDS} continuations — it is writing one very long answer instead of working in steps. Raise "openvsChat.maxTokens", ask for a smaller piece of work, or switch to a model that uses tools.`,
					};
				}
				truncationRounds++;
				// The partial answer stays in the conversation so the model can resume it, but
				// as ONE provisional turn rebuilt from the joined text each round — stacking a
				// fragment per round would leave the pieces unjoinable for the recovery above.
				messages.splice(messages.length - carryTurns, carryTurns);
				carry = result.content;
				// An empty assistant turn is never recorded: several backends reject one.
				const provisional: ChatMessage[] = carry.trim() ? [{ role: 'assistant', content: carry }] : [];
				const resume = truncationRounds >= TRUNCATION_BRAKE_ROUND
					? CONTINUE_PROMPT + TRUNCATION_BRAKE_PROMPT
					: CONTINUE_PROMPT;
				provisional.push({ role: 'user', content: resume });
				messages.push(...provisional);
				carryTurns = provisional.length;
				continue;
			}

			// The cutoff resolved (or never happened): the provisional turns give way to the
			// single whole assistant turn recorded below.
			if (carryTurns) {
				messages.splice(messages.length - carryTurns, carryTurns);
				carry = '';
				carryTurns = 0;
			}
			truncationRounds = 0;

			// An assistant turn with neither text nor tool calls carries nothing, and several
			// backends reject an empty assistant message outright — so it is never recorded.
			// Whitespace-only counts as empty here and below, so the two stay in agreement:
			// treating "\n" as content while the retry path treats it as empty would reset
			// the empty counter on every round and loop forever.
			const productive = !!result.content.trim() || result.toolCalls.length > 0;
			if (productive) {
				messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });
				// The turn arrived, so any earlier empty replies were a transient blip.
				emptyRounds = 0;
			}

			if (!result.toolCalls.length) {
				// No text AND no tool call is a lost turn, not a finished answer. Ending the
				// run here is what made the chat go blank mid-task — the webview drops the
				// empty bubble and `done` says nothing, so the user sees the work simply
				// vanish. Ask again a few times, then stop with an explanation.
				if (!result.content.trim()) {
					if (emptyRounds >= MAX_EMPTY_ROUNDS) {
						return {
							reason: 'stalled',
							detail: `The model returned ${emptyRounds + 1} empty replies in a row, so the run stopped with the task unfinished. This is usually a provider hiccup — send "continue" to resume, or switch models.`,
						};
					}
					emptyRounds++;
					callbacks.onNote('The model returned an empty reply — asking it to continue.');
					messages.push({ role: 'user', content: EMPTY_REPLY_PROMPT });
					continue;
				}
				// In write-capable Agent mode, prose with no tool call usually means the model
				// described a next action instead of taking it, abandoned its own checklist,
				// or never verified what it wrote — push back before believing it's done.
				// Read-only Ask/Plan and research sub-agents legitimately end with a prose
				// answer, so they finish immediately (no wasted round).
				const nudge = await this.completionNudge();
				if (nudge) {
					step++;
					messages.push({ role: 'user', content: nudge });
					continue;
				}
				return { reason: 'done' };
			}

			// Real tool work means the model is engaged again: let every nudge reason arm
			// itself afresh for the next quiet stretch.
			this.nudgeCounts.clear();
			step++;

			const outcomes = await this.runTools(result.toolCalls, params, callbacks);
			for (const { call, result: toolResult } of outcomes) {
				// A tool result must never be empty or whitespace-only: Anthropic rejects such
				// a `tool_result` block outright (HTTP 400), which killed the whole run over a
				// zero-byte file or an MCP tool that legitimately returned nothing. Reading the
				// result as "the tool produced no output" is both true and safe everywhere.
				messages.push({
					role: 'tool',
					content: toolResult.trim() ? toolResult : `(${call.name} returned no output)`,
					toolCallId: call.id,
				});
			}
		}

		return {
			reason: 'limit',
			detail: extends_
				? `Reached the hard ceiling of ${stepCeiling} steps — Full Auto already extended the ${this.maxSteps}-step limit ${AUTO_EXTEND_FACTOR}× on its own. Send "continue" to keep going, or raise "openvsChat.agent.maxSteps".`
				: `Reached the ${this.maxSteps}-step limit. Send "continue" to keep going, or raise "openvsChat.agent.maxSteps".`,
		};
	}

	/**
	 * The message to push back at a model that produced prose and no tool call, or
	 * undefined when the run should genuinely be allowed to finish.
	 *
	 * Checked in order of how badly the run would be misreported as complete: open
	 * checklist items first (the model abandoned its own plan), then unverified writes
	 * (it changed code and never checked it), then the generic "did you actually finish"
	 * catch. Each reason is capped by {@link MAX_NUDGES_PER_REASON} per quiet stretch so
	 * a model that will not comply still terminates.
	 */
	private async completionNudge(): Promise<string | undefined> {
		if (this.readOnly) {
			return undefined;
		}
		// A specific reason short-circuits: once it is spent the run is allowed to end,
		// rather than falling through to the generic prompt for one more round. Having
		// already been chased about a concrete obligation twice, "are you sure you're
		// done?" adds nothing but another request.
		if (this.todos.some(t => t.status !== 'completed')) {
			return this.takeNudge('todos') ? unfinishedTodoPrompt(this.todos) : undefined;
		}
		if (this.unverifiedWrites) {
			// No verification command in this workspace means there is nothing to demand.
			// Nudging anyway would be nagging the model about an impossibility, and it
			// would learn to answer with a plausible-sounding excuse — so fall through to
			// the ordinary "are you actually finished?" instead of inventing a chore.
			const commands = await this.verificationCommands();
			if (!commands.length) {
				return this.takeNudge('generic') ? COMPLETION_CHECK_PROMPT : undefined;
			}
			// The name-shape test is a heuristic and cannot know a project's own conventions.
			// A command the workspace itself advertises counts even when the shape test
			// missed it, so a run that verified exactly as asked is never nagged for it.
			if (this.ranCommands.some(ran => commands.some(c => ran.includes(c.command)))) {
				this.unverifiedWrites = false;
			} else {
				return this.takeNudge('verify') ? verifyPrompt(commands) : undefined;
			}
		}
		return this.takeNudge('generic') ? COMPLETION_CHECK_PROMPT : undefined;
	}

	/** The workspace's verification commands, probed at most once per run. */
	private async verificationCommands(): Promise<VerifyCommand[]> {
		if (!this.verifyCommands) {
			this.verifyCommands = detectVerificationCommands().catch(() => []);
		}
		return this.verifyCommands;
	}

	/** Consumes one nudge allowance for `reason`, or returns false when it is spent. */
	private takeNudge(reason: keyof typeof NUDGE_LIMITS): boolean {
		const used = this.nudgeCounts.get(reason) ?? 0;
		if (used >= NUDGE_LIMITS[reason]) {
			return false;
		}
		this.nudgeCounts.set(reason, used + 1);
		return true;
	}

	/**
	 * Tracks whether the workspace has been changed without a subsequent successful
	 * *verification* run. Writes set the flag; a build/test/lint/type-check that exits
	 * cleanly clears it. A failed command deliberately leaves it set — a red build is
	 * exactly the state the model must not walk away from.
	 *
	 * Only a command that plausibly checks the code counts. Clearing on any successful
	 * command made the gate trivially — and unknowingly — bypassable: a model that wrote
	 * three files and then ran `git status` had "verified" them, which is the precise
	 * failure the gate exists to catch.
	 */
	private recordVerificationState(call: ToolCall, isError: boolean): void {
		if (isError) {
			return;
		}
		if (call.name === 'write_file' || call.name === 'edit_file') {
			this.unverifiedWrites = true;
			// Commands that ran *before* this write prove nothing about it.
			this.ranCommands = [];
		} else if (call.name === 'run_command') {
			const command = commandTextOf(call.args);
			this.ranCommands.push(command);
			if (isVerificationCommand(command)) {
				this.unverifiedWrites = false;
			}
			// `isReadOnly` is optional at runtime on purpose: a toolset that predates it
			// should make the run cautious, not crash it mid-step.
		} else if (call.name.startsWith(MCP_PREFIX) && this.mcp?.isReadOnly?.(call.name) !== true) {
			// An MCP server can edit files too. Only a tool the server itself declared
			// read-only is exempt; anything unannotated has to count as a change, or a
			// run that did all its work through an MCP filesystem server would sail past
			// the verification gate untouched.
			this.unverifiedWrites = true;
		}
	}

	/**
	 * Puts one {@link ASK_USER_TOOL} call to the user and returns their answer as the
	 * tool result. Bad arguments come back as an error result rather than throwing, so a
	 * malformed call costs one step instead of the whole run.
	 */
	private async askUser(call: ToolCall): Promise<{ result: string; isError: boolean }> {
		const question = asString(call.args.question ?? call.args.prompt ?? call.args.text).trim();
		if (!question) {
			return { result: 'ask_user requires a non-empty "question".', isError: true };
		}
		// Every entry is parsed before trimming, so the surplus shown to the user is the
		// real remainder rather than whatever happened to follow the cut.
		const parsed = parseAskOptions(call.args.options ?? call.args.choices ?? call.args.answers);
		const options = parsed.slice(0, MAX_ASK_OPTIONS);
		if (options.length < 2) {
			return {
				result: `ask_user needs at least 2 distinct "options" (each with a "label"), at most ${MAX_ASK_OPTIONS}. `
					+ 'If there is no real choice to offer, do the work instead of asking.',
				isError: true,
			};
		}
		// Extra options are trimmed rather than rejected — re-asking would cost a step for
		// a question the user can already answer — but nothing is hidden from either side.
		// The user sees the surplus as text they can type; the model is told its choice
		// was trimmed, so it doesn't assume the answer came from the full set.
		const surplus = parsed.slice(options.length).map(o => o.label);
		const dropped = surplus.length
			? ` (note: you offered ${parsed.length} options; only the first ${options.length} were shown as buttons, so keep to ${MAX_ASK_OPTIONS})`
			: '';
		const answer = (await this.approver.ask({
			question,
			options,
			multiSelect: asBoolean(call.args.multiSelect),
			detail: surplus.length ? `Also offered, type to choose: ${surplus.join(' · ')}` : undefined,
		})).trim();
		return answer
			? { result: `The user answered: ${answer}${dropped}`, isError: false }
			: { result: `The user dismissed the question without answering. Proceed with the most reasonable option and say which you chose.${dropped}`, isError: false };
	}

	/**
	 * Asks the model for one step, keeping the conversation inside the context budget.
	 * If the provider still rejects it as too big, the budget is cut and the step is
	 * retried once — a run should shed old file dumps rather than die on a 400.
	 *
	 * How far it is cut depends on what the rejection said. A ceiling the backend named
	 * outright is adopted verbatim (see {@link adoptRequestCeiling}); otherwise the budget
	 * is halved, which is the best guess available when the backend only says "too long".
	 */
	private async step(
		messages: ChatMessage[],
		params: AgentParams,
		callbacks: AgentCallbacks,
	): Promise<AgentStep> {
		// The tool schemas ride along with every request, so the conversation only gets what
		// is left of the budget after them. Floored, so a huge MCP toolset degrades into a
		// short conversation rather than into no conversation at all.
		const ask = (budget: number) => this.provider.runAgentStep!({
			// Measured after trimming, so the figure is what the provider was actually asked
			// to read rather than what the run is holding.
			messages: this.measured(trimMessages(messages, Math.max(this.contextFloor, budget - this.toolOverhead()))),
			tools: this.tools(),
			model: params.model,
			apiKey: params.apiKey,
			baseUrl: params.baseUrl,
			maxTokens: Math.min(params.maxTokens, this.outputCap ?? params.maxTokens),
			signal: params.signal,
			onToken: delta => callbacks.onToken(delta),
			onNotice: text => callbacks.onNote(text),
		});
		try {
			return this.recoverTextToolCalls(await ask(this.contextBudget));
		} catch (err) {
			if (!(err instanceof Error) || !isContextLengthError(err.message)) {
				throw err;
			}
			// The estimate was optimistic for this model; keep the smaller budget for the
			// rest of the run so every later step stays inside the real limit.
			const stated = parseTokenLimit(err.message);
			if (stated) {
				this.adoptRequestCeiling(stated, params.maxTokens);
				callbacks.onNote(`The provider caps a request at ${stated} tokens — reducing the reply limit to ${this.outputCap} and trimming older tool output, then retrying.`);
			} else {
				this.contextBudget = Math.max(this.contextFloor, Math.floor(this.contextBudget / 2));
				callbacks.onNote(`The conversation outgrew the model's context window — trimming older tool output and retrying.`);
			}
			return this.recoverTextToolCalls(await ask(this.contextBudget));
		}
	}

	/**
	 * Re-derives the run's budgets from a per-request token ceiling the backend named.
	 *
	 * Both halves of the request are charged against that one number, so both have to move:
	 * the reply reservation is cut to a share of the ceiling (never *up* — a stated ceiling
	 * is not a licence to ask for more output than the user configured), and the conversation
	 * gets what is left. Kept for the rest of the run, since the ceiling is a property of the
	 * account and model rather than of this one step.
	 */
	private adoptRequestCeiling(limit: number, configuredOutput: number): void {
		const usable = Math.floor(limit * STATED_LIMIT_SHARE);
		this.outputCap = Math.max(MIN_OUTPUT_TOKENS, Math.min(configuredOutput, Math.floor(usable * STATED_OUTPUT_SHARE)));
		this.contextFloor = MIN_STATED_CONTEXT_TOKENS;
		this.contextBudget = Math.max(this.contextFloor, usable - this.outputCap);
	}

	/**
	 * Estimated tokens the tool schemas add to every request of this run.
	 *
	 * Memoized: the set is fixed by depth, read-only-ness and the connected MCP servers,
	 * none of which change mid-run. The one exception is `spawn_subagent` dropping out once
	 * the spawn budget is spent, which only makes this estimate slightly conservative.
	 */
	private toolOverhead(): number {
		if (this.toolTokens === undefined) {
			this.toolTokens = estimateToolsTokens(this.tools());
		}
		return this.toolTokens;
	}

	/** Records the size of a prompt on its way to the provider and passes it straight through. */
	private measured(messages: ChatMessage[]): ChatMessage[] {
		this.lastPromptTokens = estimateMessagesTokens(messages);
		this.peakPromptTokens = Math.max(this.peakPromptTokens, this.lastPromptTokens);
		return messages;
	}

	/**
	 * Promotes tool calls a model wrote into its prose into real tool calls.
	 *
	 * Applied here rather than per-provider so every backend gets it: whether a model's
	 * `<tool_call>{…}</tool_call>` reaches us as text is a property of the model and the
	 * gateway, not of the provider class. Without this the step looks like "prose, no tool
	 * call", which the loop reads as a finished answer — so a run with a weaker model ends
	 * having written nothing, while appearing to have worked the whole time.
	 */
	private recoverTextToolCalls(step: AgentStep): AgentStep {
		if (step.toolCalls.length || !step.content.trim()) {
			return step;
		}
		const known = new Set(this.tools().map(t => t.name));
		// The raw content, not the thinking-stripped version: whatever is left becomes the
		// visible bubble, and stripping here would silently delete the model's reasoning.
		const { calls, text } = extractTextToolCalls(step.content, known);
		if (!calls.length) {
			return step;
		}
		return { ...step, content: text, toolCalls: calls };
	}

	/** Runs the summarizer through the same provider/model; failures return undefined so the run falls back to trimming. */
	private async compact(messages: ChatMessage[], params: AgentParams) {
		return compactMessages(messages, async (toSummarize, maxTokens) => {
			let text = '';
			await this.provider.streamChat({
				messages: toSummarize,
				model: params.model,
				apiKey: params.apiKey,
				baseUrl: params.baseUrl,
				maxTokens,
				signal: params.signal,
				onToken: delta => { text += delta; },
			});
			// Reasoning models stream their chain of thought through onToken too;
			// the stored summary must not carry it.
			return stripThinking(text);
		}, this.keepHead);
	}

	/**
	 * Executes a step's tool calls: consecutive read-only calls concurrently, everything
	 * else sequentially, sub-agents last with parallel research.
	 */
	private async runTools(
		calls: ToolCall[],
		params: AgentParams,
		callbacks: AgentCallbacks,
	): Promise<Array<{ call: ToolCall; result: string; isError: boolean }>> {
		const outcomes: Array<{ call: ToolCall; result: string; isError: boolean }> = [];
		const spawnCalls: ToolCall[] = [];

		for (let i = 0; i < calls.length; i++) {
			const call = calls[i];
			if (params.signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			if (call.name === SPAWN_SUBAGENT_TOOL.name) {
				spawnCalls.push(call);
				continue;
			}
			// A run of adjacent read-only calls has no side effects and no ordering between
			// its members, so it goes out at once. Only *adjacent* ones: a write between two
			// reads changes what the second read should see, and reordering across it would
			// answer from before the change.
			if (this.guardrails.parallelReads && READ_ONLY_TOOL_NAMES.includes(call.name)) {
				let end = i;
				while (end < calls.length && READ_ONLY_TOOL_NAMES.includes(calls[end].name)) {
					end++;
				}
				if (end - i > 1) {
					outcomes.push(...await this.runReadBatch(calls.slice(i, end), callbacks));
					i = end - 1;
					continue;
				}
			}
			if (call.name === UPDATE_TODOS_TOOL.name) {
				callbacks.onToolStart(call);
				const parsed = parseTodoUpdate(call.args);
				let outcome: { result: string; isError: boolean };
				if (parsed.error !== undefined) {
					outcome = { result: parsed.error, isError: true };
				} else {
					this.todos = parsed.items;
					callbacks.onTodos?.(parsed.items);
					// Echo the list back rather than just a count: the tool result is the
					// model's only durable record of its own plan once compaction has
					// summarized the turn that produced it.
					outcome = { result: renderChecklist(parsed.items), isError: false };
				}
				callbacks.onToolEnd(call, outcome.result, outcome.isError);
				outcomes.push({ call, ...outcome });
				continue;
			}
			if (call.name === ASK_USER_TOOL.name) {
				callbacks.onToolStart(call);
				const outcome = await this.askUser(call);
				callbacks.onToolEnd(call, outcome.result, outcome.isError);
				outcomes.push({ call, ...outcome });
				continue;
			}
			outcomes.push(await this.runOneTool(call, callbacks));
		}

		if (spawnCalls.length) {
			// A delegate reads and writes on its own; nothing the parent cached still holds.
			this.answeredReads.clear();
			const runOne = async (call: ToolCall) => {
				callbacks.onToolStart(call);
				const { result, isError } = await this.runSubagent(call, params, callbacks);
				callbacks.onToolEnd(call, result, isError);
				return { call, result, isError };
			};
			const readOnly = spawnCalls.filter(c => asBoolean(c.args.readOnly));
			const writal = spawnCalls.filter(c => !asBoolean(c.args.readOnly));
			if (writal.length) {
				// A write-capable delegate may have changed anything; the parent must not
				// then declare the task verified on the strength of an earlier build.
				this.unverifiedWrites = true;
			}
			if (this.guardrails.parallelResearch && readOnly.length > 1) {
				outcomes.push(...await Promise.all(readOnly.map(runOne)));
			} else {
				for (const call of readOnly) { outcomes.push(await runOne(call)); }
			}
			for (const call of writal) { outcomes.push(await runOne(call)); }
		}

		return outcomes;
	}

	/**
	 * The refusal to hand back instead of running the call `key` identifies, or undefined
	 * when it should run.
	 *
	 * Both guards live here rather than at the call site so the sequential and batched
	 * paths cannot drift apart: a read that is refused when run alone must be refused when
	 * it arrives alongside three others, or batching becomes a way around the loop breaker.
	 */
	private toolRefusal(key: string, isRead: boolean): string | undefined {
		// Re-reading a file the model already read this run — the single most common way
		// an agent run stalls — is answered from the transcript instead of the disk. The
		// result it wants is still above it in the conversation, so re-fetching it buys
		// nothing and costs a step; models that do it once tend to do it forever.
		if (isRead && this.answeredReads.has(key)) {
			// A refused repeat still costs a step, so a model that ignores the refusal
			// loops until the budget runs out. Counting it escalates the wording after a
			// few tries, exactly as a genuinely failing call does.
			const refusals = (this.failedCalls.get(key) ?? 0) + 1;
			this.failedCalls.set(key, refusals);
			return refusals >= MAX_IDENTICAL_FAILURES
				? `You have now asked for ${key} ${refusals} times without the file changing. Its result is already in this conversation. `
				+ 'Stop re-reading and take the next action of the task; if you believe you are missing something, say what it is instead of repeating the call.'
				: `You already ran ${key} earlier in this run and nothing has changed since, so its result is still above in this conversation — read it there instead of repeating the call. `
				+ 'If you need something you have not seen, change the arguments (a different path, a different offset/limit, a different query) or move on to the next step of the task.';
		}
		// A call that has already failed the same way several times will fail that way
		// again; running it a fourth time only spends budget confirming it. Refusing it
		// with an explicit "change approach" is the one message that actually breaks the
		// loop — repeating the tool's own error just invites the same call back.
		const failures = this.failedCalls.get(key) ?? 0;
		if (failures >= MAX_IDENTICAL_FAILURES) {
			return `${key} has already failed ${failures} times in a row with the same arguments, so it was not run again. `
				+ 'Do something different: fix the cause the earlier errors named, change the arguments, use another tool, or — if this step is genuinely blocked — say so plainly and move on to the rest of the task.';
		}
		return undefined;
	}

	/** Applies the run-wide bookkeeping a finished tool call implies. */
	private recordToolOutcome(call: ToolCall, key: string, isRead: boolean, isError: boolean): void {
		if (isError) {
			this.failedCalls.set(key, (this.failedCalls.get(key) ?? 0) + 1);
		} else {
			this.failedCalls.delete(key);
			// Only a success that CHANGED something can unblock a different call — a write
			// that creates the file an edit could not find, a command that installs the
			// missing binary. Clearing on any success (a read included) let a model defeat
			// the guard for free: alternate the failing edit with a read of a new path and
			// the failure count reset every other step, which is the exact loop this
			// exists to break.
			if (!isRead) {
				this.failedCalls.clear();
			}
		}
		if (isRead) {
			// Only a *successful* read is remembered. Caching a failed one told the model
			// it had "already read" a file it had never seen, and refused the retry that
			// would have succeeded once the transient cause cleared.
			if (!isError) {
				this.answeredReads.add(key);
			}
		} else {
			// A write, a command or an MCP call can change anything a read reported, so
			// every cached read expires here rather than being trusted across the change.
			this.answeredReads.clear();
		}
		this.recordVerificationState(call, isError);
	}

	/** Runs one ordinary tool call (anything the loop doesn't handle itself), guards included. */
	private async runOneTool(call: ToolCall, callbacks: AgentCallbacks): Promise<{ call: ToolCall; result: string; isError: boolean }> {
		const key = repeatKey(call);
		const isRead = READ_ONLY_TOOL_NAMES.includes(call.name);
		const refusal = this.toolRefusal(key, isRead);
		callbacks.onToolStart(call);
		if (refusal !== undefined) {
			callbacks.onToolEnd(call, refusal, true);
			return { call, result: refusal, isError: true };
		}
		const { result, isError } = call.name.startsWith(MCP_PREFIX)
			? await this.callMcp(call)
			: await executeTool(call, this.approver, this.guardrails);
		this.recordToolOutcome(call, key, isRead, isError);
		callbacks.onToolEnd(call, result, isError);
		return { call, result, isError };
	}

	/**
	 * Runs a group of adjacent read-only calls concurrently.
	 *
	 * The guards are evaluated up front, in order and synchronously, before anything is
	 * dispatched: they read and write shared counters, and interleaving them with the
	 * awaits would make which call gets refused depend on which read happened to finish
	 * first. Identical calls inside one batch are executed once and share the result —
	 * refusing the duplicate would be defensible, but the model asked two questions and
	 * answering both correctly costs nothing here.
	 *
	 * Callbacks stay in call order rather than completion order, so the transcript reads
	 * the same whether or not batching was on.
	 */
	private async runReadBatch(batch: ToolCall[], callbacks: AgentCallbacks): Promise<Array<{ call: ToolCall; result: string; isError: boolean }>> {
		const planned = batch.map(call => {
			const key = repeatKey(call);
			return { call, key, refusal: this.toolRefusal(key, true) };
		});
		for (const p of planned) {
			callbacks.onToolStart(p.call);
		}
		const shared = new Map<string, Promise<{ result: string; isError: boolean }>>();
		const results = await Promise.all(planned.map(p => {
			if (p.refusal !== undefined) {
				return Promise.resolve({ result: p.refusal, isError: true });
			}
			let pending = shared.get(p.key);
			if (!pending) {
				pending = executeTool(p.call, this.approver, this.guardrails);
				shared.set(p.key, pending);
			}
			return pending;
		}));
		const outcomes: Array<{ call: ToolCall; result: string; isError: boolean }> = [];
		for (let i = 0; i < planned.length; i++) {
			const { call, key, refusal } = planned[i];
			const { result, isError } = results[i];
			if (refusal === undefined) {
				this.recordToolOutcome(call, key, true, isError);
			}
			callbacks.onToolEnd(call, result, isError);
			outcomes.push({ call, result, isError });
		}
		return outcomes;
	}

	/** Invokes an MCP tool, prompting for approval first unless the policy auto-approves. */
	private async callMcp(call: ToolCall): Promise<{ result: string; isError: boolean }> {
		if (!this.mcp) {
			return { result: `MCP is not available for "${call.name}".`, isError: true };
		}
		if (!autoApproves(this.guardrails)) {
			const { approved, feedback } = await this.approver.confirm({
				kind: 'mcp',
				signature: call.name,
				title: `Run the MCP tool "${call.name}"?`,
				detail: 'Provided by a connected MCP server.',
				preview: shortArgs(call.args, 800),
				previewLanguage: 'json',
			});
			if (!approved) {
				const reason = feedback?.trim();
				return {
					result: reason
						? `The user denied the MCP tool call and said: "${reason}".`
						: 'The user denied the MCP tool call. Try a different approach rather than repeating it.',
					isError: true,
				};
			}
		}
		return this.mcp.call(call.name, call.args);
	}

	/** Runs a nested sub-agent for one delegation call, returning its summary as the tool result. */
	private async runSubagent(
		call: ToolCall,
		params: AgentParams,
		callbacks: AgentCallbacks,
	): Promise<{ result: string; isError: boolean }> {
		const goal = asString(call.args.goal ?? call.args.task ?? call.args.prompt).trim();
		// Coerced rather than compared strictly: `readOnly: "true"` read as false would hand a
		// delegate that asked for research-only powers a write-capable agent instead.
		const readOnly = asBoolean(call.args.readOnly);
		if (!goal) {
			return { result: 'spawn_subagent requires a non-empty "goal".', isError: true };
		}
		if (this.budget.spawned >= this.guardrails.maxSubagents) {
			return { result: `Sub-agent budget (${this.guardrails.maxSubagents}) exhausted; do this work yourself.`, isError: true };
		}
		this.budget.spawned++;

		const child = new AgentRunner(this.provider, this.approver, Math.max(3, Math.floor(this.maxSteps / 2)), {
			guardrails: this.guardrails,
			depth: this.depth + 1,
			budget: this.budget,
			readOnly,
			// Inherited so a delegate can finish work that needs a connected server. Without
			// it the parent would delegate a goal it has the tools for to a child that does
			// not, and the child reports the task impossible. Read-only delegates still get
			// none: `tools()` returns the inspection set before MCP is considered.
			mcp: this.mcp,
			// Inherited, or a sub-agent that reads a dozen files runs with no compaction and
			// the default budget until the provider rejects the request outright. Its seed is
			// [system, goal] — both must survive compaction, hence keepHead 2.
			maxContextTokens: this.contextBudget,
			maxOutputTokens: this.outputCap,
			contextWindow: this.contextWindow,
			keepHead: 2,
			// The delegate gets what is *left* of the parent's wall clock, not a fresh
			// allowance: a fresh one would let a chain of sub-agents multiply the ceiling
			// out, which is the same mistake the step budget used to make. Floored at one
			// minute so a delegate spawned near the deadline still gets a real attempt
			// rather than returning empty-handed the moment it starts.
			maxRunMs: this.maxRunMs > 0
				? Math.max(60_000, this.maxRunMs - (this.now() - this.startedAt))
				: 0,
			traceTiming: this.traceTiming,
			now: this.now,
		});

		const log: string[] = [];
		let finalText = '';
		let outcome: RunResult;
		try {
			outcome = await child.run(
				[
					{ role: 'system', content: subagentSystem(readOnly) },
					{ role: 'user', content: goal },
				],
				params,
				{
					onStepStart: () => { /* nested steps aren't surfaced individually */ },
					onToken: () => { /* nested narration is captured in the summary */ },
					onStepEnd: content => { if (content) { finalText = content; log.push(content); } },
					onToolStart: c => log.push(`• ${c.name}(${shortArgs(c.args)})`),
					onToolEnd: (_c, r, e) => log.push(`  ${e ? '⚠ ' : ''}${truncate(r, 300)}`),
					// Surfaced to the user too: a sub-agent that quietly ran out of budget
					// used to be invisible, leaving its half-done work unexplained.
					onNote: t => { log.push(t); callbacks.onNote(`Sub-agent: ${t}`); },
				},
			);
		} catch (err) {
			// An abort belongs to the whole run, not to this delegation — let it propagate
			// instead of being reported to the model as a failed tool call.
			if (err instanceof DOMException && err.name === 'AbortError') {
				throw err;
			}
			return { result: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}

		const summary = finalText || '(sub-agent produced no summary)';
		// The parent must know when the child stopped short, or it will treat a partial
		// result as complete.
		const unfinished = outcome.reason === 'done' ? '' : `\n\n[sub-agent stopped early: ${outcome.detail ?? outcome.reason}]`;
		return {
			result: `${summary}${unfinished}\n\n[sub-agent activity]\n${truncate(log.join('\n'), 1500)}`,
			isError: false,
		};
	}
}

function subagentSystem(readOnly: boolean): string {
	const role = readOnly
		? 'You are a READ-ONLY research SUB-AGENT. You may only read, list and search files — you cannot write or run commands.'
		: 'You are a SUB-AGENT with tools to read, list, write and edit files and run commands (writes/commands require user approval).';
	return `${role} ${SUBAGENT_PREAMBLE} You were given one focused goal and do not see the parent conversation. ` +
		`Accomplish exactly that goal using your tools, then end with a concise summary of what you found or changed. Do not ask follow-up questions.`;
}

/**
 * Identity of a read-only call for repeat detection: the tool name plus its arguments
 * with the keys sorted, so `{path, limit}` and `{limit, path}` are recognized as the same
 * call. Also readable enough to quote straight back to the model.
 *
 * A `path` argument is reduced to the file it actually resolves to first. `a.ts`, `./a.ts`
 * and `/repo/a.ts` are one file but three different strings, so keying on the raw argument
 * let a model re-read the same file indefinitely just by spelling it differently — the exact
 * loop this guard exists to stop, walked straight around.
 */
function repeatKey(call: ToolCall): string {
	const args: Record<string, unknown> = { ...call.args };
	if (typeof args.path === 'string') {
		args.path = resolveWorkspacePath(args.path)?.display ?? args.path;
	}
	const rendered = Object.keys(args).sort()
		.map(key => `${key}=${JSON.stringify(args[key])}`)
		.join(', ');
	return `${call.name}(${rendered})`;
}

function shortArgs(args: Record<string, unknown>, max = 60): string {
	try {
		const s = JSON.stringify(args) ?? '';
		return s.length > max ? s.slice(0, max - 3) + '…' : s;
	} catch {
		return '';
	}
}

/**
 * Normalizes the `options` argument of an `ask_user` call. Accepts both the documented
 * `{label, description}` objects and the bare strings models sometimes send instead;
 * entries with no usable label are dropped rather than rendered as empty buttons.
 */
function parseAskOptions(raw: unknown): AskOption[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const options: AskOption[] = [];
	for (const entry of raw) {
		const fields = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined;
		const label = (fields
			? asString(fields.label ?? fields.option ?? fields.value ?? fields.title ?? fields.text ?? fields.name)
			: asString(entry)).trim();
		if (!label) {
			continue;
		}
		const description = fields ? asString(fields.description ?? fields.detail ?? fields.hint).trim() : '';
		options.push(description ? { label, description } : { label });
	}
	return options;
}

/** The checklist as the model should see it echoed back from `update_todos`. */
function renderChecklist(items: TodoItem[]): string {
	if (!items.length) {
		return 'Checklist cleared.';
	}
	const done = items.filter(t => t.status === 'completed').length;
	const mark = (t: TodoItem) => t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' ';
	return `Checklist updated (${done}/${items.length} complete):\n`
		+ items.map(t => `- [${mark(t)}] ${t.content}`).join('\n');
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Waits `ms`, rejecting immediately if the run is aborted meanwhile. A plain `setTimeout`
 * would leave a cancelled run sitting out its whole retry backoff before noticing.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException('Aborted', 'AbortError'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
