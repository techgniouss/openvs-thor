/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpToolset } from '../mcp/manager';
import { SUBAGENT_PREAMBLE } from '../persona/prompts';
import { stripThinking } from '../persona/thinking';
import { TodoItem, UPDATE_TODOS_TOOL, parseTodoUpdate } from '../persona/todos';
import { AgentStep, CONTINUE_PROMPT, ChatProvider, ChatMessage, ToolCall, ToolSpec } from '../providers/types';
import { canCompact, compactMessages, compactionThreshold, shouldCompact } from './compaction';
import { estimateMessagesTokens, isContextLengthError, trimMessages } from './context';
import { Guardrails, autoApproves, loadGuardrails } from './guardrails';
import { AGENT_TOOLS, ASK_USER_TOOL, AskOption, MAX_ASK_OPTIONS, READ_ONLY_TOOL_NAMES, SPAWN_SUBAGENT_TOOL, ToolApprover, detectVerificationCommands, executeTool } from './tools';

const MCP_PREFIX = 'mcp__';

/**
 * Why a run ended. Every terminal path maps onto one of these so the UI can always
 * tell the user *why* it stopped — a run that just goes quiet is a bug, not an outcome.
 */
export type StopReason = 'done' | 'limit' | 'truncated' | 'filtered' | 'refused' | 'stalled';

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
 * Estimated-token ceiling for the conversation sent each step. Well under the window of
 * every current tool-capable model, leaving room for the estimate being approximate and
 * for the model's own reply.
 */
const DEFAULT_CONTEXT_TOKENS = 120_000;

/** Floor for the adaptive budget, so repeated shrinking can't starve the conversation. */
const MIN_CONTEXT_TOKENS = 8_000;

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
 * The evidence-backed reasons get two attempts: an open checklist item or an unverified
 * write is a concrete, checkable claim, and a model that ignored the first reminder
 * often complies with the second. The generic "are you actually done?" gets one — it has
 * no evidence behind it, so if the model stays quiet after being asked, it really is
 * done and asking again is just noise. All counters reset whenever the model does real
 * tool work, so a long task is never capped overall.
 */
const NUDGE_LIMITS: Record<string, number> = { todos: 2, verify: 2, generic: 1 };

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
function verifyPrompt(commands: string[]): string {
	return 'You changed files in this run but never ran a command to check them. Run '
		+ `${commands.map(c => `\`${c}\``).join(' or ')} with run_command now and fix anything it reports. `
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
	/** Model context window in tokens; enables auto-compaction at 70% of it. 0/absent disables compaction. */
	contextWindow?: number;
	/**
	 * How many leading seed messages compaction must preserve verbatim. The seed is
	 * `[system, attached context?, the request, …]`, so without this compaction would
	 * keep the context blob and summarize away the request. See `compactMessages`.
	 */
	keepHead?: number;
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
	/** Set once compacting stops paying for itself, so the run doesn't re-summarize every few steps. */
	private compactionExhausted = false;
	/** Consecutive summarizer failures; reset by any success, so a one-off blip isn't terminal. */
	private summarizerFailures = 0;
	private contextBudget: number;
	/** The model's latest checklist, so completion can be checked against its own plan. */
	private todos: TodoItem[] = [];
	/** True once this run wrote to the workspace with no successful command run since. */
	private unverifiedWrites = false;
	/** How often each completion-nudge reason has fired in the current quiet stretch. */
	private readonly nudgeCounts = new Map<string, number>();
	/**
	 * Read-only calls already answered since the workspace (or the transcript) last
	 * changed, keyed by {@link repeatKey}. Cleared by anything that can invalidate a
	 * result — a write, a command, an MCP call, a sub-agent, a compaction.
	 */
	private readonly answeredReads = new Set<string>();
	/** Memoized workspace probe for verification commands; undefined until first needed. */
	private verifyCommands?: Promise<string[]>;

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
		this.contextWindow = opts?.contextWindow ?? 0;
		this.keepHead = opts?.keepHead;
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

		const messages: ChatMessage[] = [...seed];
		let truncationRounds = 0;
		let emptyRounds = 0;

		for (let step = 0; step < this.maxSteps;) {
			if (params.signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}

			// Course corrections typed while the previous step ran enter the loop here.
			for (const note of this.steering?.() ?? []) {
				messages.push({ role: 'user', content: note });
			}

			// Compact ahead of the hard budget: replace old middle turns with a summary
			// once past the trigger share of the model's window, so the model keeps a
			// coherent task memory instead of trim markers.
			// `canCompact` is checked separately from the result: "not enough middle yet"
			// is transient and resolves as the run grows, so it must never be mistaken for
			// a failure — doing so used to disable compaction for a whole run at step 0.
			if (this.contextWindow && !this.compactionExhausted
				&& shouldCompact(messages, this.contextWindow, this.contextBudget)
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
					if (estimateMessagesTokens(head) >= compactionThreshold(this.contextWindow, this.contextBudget)) {
						this.compactionExhausted = true;
						callbacks.onNote('The conversation is still near the context limit after compacting — older tool output will be trimmed from here on.');
					}
				} else if (++this.summarizerFailures >= MAX_SUMMARIZER_FAILURES) {
					// Persistent failure (not a one-off rate limit), so stop paying for it.
					this.compactionExhausted = true;
				}
			}

			callbacks.onStepStart();
			const result = await this.step(messages, params, callbacks);
			callbacks.onStepEnd(result.content);

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

			// A provider-side block ends the run, but must never be mistaken for success.
			if (result.finishReason === 'filtered' || result.finishReason === 'refused') {
				return {
					reason: result.finishReason,
					detail: result.finishReason === 'filtered'
						? 'The provider blocked this response with its content filter. Rephrase the request or switch models.'
						: 'The model refused to continue with this request.',
				};
			}

			if (!result.toolCalls.length) {
				// Cut off by the token limit mid-answer: resume where it stopped. This is
				// the model making progress, so it doesn't spend a step of the budget.
				if (result.truncated) {
					if (truncationRounds >= MAX_TRUNCATION_ROUNDS) {
						return {
							reason: 'truncated',
							detail: `The model kept hitting its output limit after ${MAX_TRUNCATION_ROUNDS} continuations. Raise "openvsChat.maxTokens" or ask for a smaller piece of work.`,
						};
					}
					truncationRounds++;
					messages.push({ role: 'user', content: CONTINUE_PROMPT });
					continue;
				}
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

			truncationRounds = 0;
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
			detail: `Reached the ${this.maxSteps}-step limit. Send "continue" to keep going, or raise "openvsChat.agent.maxSteps".`,
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
			if (commands.length) {
				return this.takeNudge('verify') ? verifyPrompt(commands) : undefined;
			}
		}
		return this.takeNudge('generic') ? COMPLETION_CHECK_PROMPT : undefined;
	}

	/** The workspace's verification commands, probed at most once per run. */
	private async verificationCommands(): Promise<string[]> {
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
	 * command run. Writes set the flag; a command that exits cleanly clears it. A failed
	 * command deliberately leaves it set — a red build is exactly the state the model
	 * must not walk away from.
	 */
	private recordVerificationState(call: ToolCall, isError: boolean): void {
		if (isError) {
			return;
		}
		if (call.name === 'write_file' || call.name === 'edit_file') {
			this.unverifiedWrites = true;
		} else if (call.name === 'run_command') {
			this.unverifiedWrites = false;
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
		const question = String(call.args.question ?? '').trim();
		if (!question) {
			return { result: 'ask_user requires a non-empty "question".', isError: true };
		}
		// Every entry is parsed before trimming, so the surplus shown to the user is the
		// real remainder rather than whatever happened to follow the cut.
		const parsed = parseAskOptions(call.args.options);
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
			multiSelect: call.args.multiSelect === true,
			detail: surplus.length ? `Also offered, type to choose: ${surplus.join(' · ')}` : undefined,
		})).trim();
		return answer
			? { result: `The user answered: ${answer}${dropped}`, isError: false }
			: { result: `The user dismissed the question without answering. Proceed with the most reasonable option and say which you chose.${dropped}`, isError: false };
	}

	/**
	 * Asks the model for one step, keeping the conversation inside the context budget.
	 * If the provider still rejects it as too long, the budget is halved and the step is
	 * retried once — a run should shed old file dumps rather than die on a 400.
	 */
	private async step(
		messages: ChatMessage[],
		params: AgentParams,
		callbacks: AgentCallbacks,
	): Promise<AgentStep> {
		const ask = (budget: number) => this.provider.runAgentStep!({
			messages: trimMessages(messages, budget),
			tools: this.tools(),
			model: params.model,
			apiKey: params.apiKey,
			baseUrl: params.baseUrl,
			maxTokens: params.maxTokens,
			signal: params.signal,
			onToken: delta => callbacks.onToken(delta),
			onNotice: text => callbacks.onNote(text),
		});
		try {
			return await ask(this.contextBudget);
		} catch (err) {
			if (!(err instanceof Error) || !isContextLengthError(err.message)) {
				throw err;
			}
			// The estimate was optimistic for this model; keep the smaller budget for the
			// rest of the run so every later step stays inside the real window.
			this.contextBudget = Math.max(MIN_CONTEXT_TOKENS, Math.floor(this.contextBudget / 2));
			callbacks.onNote(`The conversation outgrew the model's context window — trimming older tool output and retrying.`);
			return ask(this.contextBudget);
		}
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

	/** Executes a step's tool calls: normal tools sequentially, sub-agents with parallel research. */
	private async runTools(
		calls: ToolCall[],
		params: AgentParams,
		callbacks: AgentCallbacks,
	): Promise<Array<{ call: ToolCall; result: string; isError: boolean }>> {
		const outcomes: Array<{ call: ToolCall; result: string; isError: boolean }> = [];
		const spawnCalls: ToolCall[] = [];

		for (const call of calls) {
			if (params.signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			if (call.name === SPAWN_SUBAGENT_TOOL.name) {
				spawnCalls.push(call);
				continue;
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
			// Re-reading a file the model already read this run — the single most common way
			// an agent run stalls — is answered from the transcript instead of the disk. The
			// result it wants is still above it in the conversation, so re-fetching it buys
			// nothing and costs a step; models that do it once tend to do it forever.
			if (READ_ONLY_TOOL_NAMES.includes(call.name)) {
				const key = repeatKey(call);
				if (this.answeredReads.has(key)) {
					callbacks.onToolStart(call);
					const outcome = {
						result: `You already ran ${key} earlier in this run and nothing has changed since, so its result is still above in this conversation — read it there instead of repeating the call. `
							+ 'If you need something you have not seen, change the arguments (a different path, a different offset/limit, a different query) or move on to the next step of the task.',
						isError: true,
					};
					callbacks.onToolEnd(call, outcome.result, outcome.isError);
					outcomes.push({ call, ...outcome });
					continue;
				}
				this.answeredReads.add(key);
			}
			callbacks.onToolStart(call);
			const { result, isError } = call.name.startsWith(MCP_PREFIX)
				? await this.callMcp(call)
				: await executeTool(call, this.approver, this.guardrails);
			// A write, a command or an MCP call can change anything a read reported, so
			// every cached read expires here rather than being trusted across the change.
			if (!READ_ONLY_TOOL_NAMES.includes(call.name)) {
				this.answeredReads.clear();
			}
			this.recordVerificationState(call, isError);
			callbacks.onToolEnd(call, result, isError);
			outcomes.push({ call, result, isError });
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
			const readOnly = spawnCalls.filter(c => c.args.readOnly === true);
			const writal = spawnCalls.filter(c => c.args.readOnly !== true);
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
		const goal = String(call.args.goal ?? '').trim();
		const readOnly = call.args.readOnly === true;
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
			// Inherited, or a sub-agent that reads a dozen files runs with no compaction and
			// the default budget until the provider rejects the request outright. Its seed is
			// [system, goal] — both must survive compaction, hence keepHead 2.
			maxContextTokens: this.contextBudget,
			contextWindow: this.contextWindow,
			keepHead: 2,
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
 */
function repeatKey(call: ToolCall): string {
	const args = Object.keys(call.args).sort()
		.map(key => `${key}=${JSON.stringify(call.args[key])}`)
		.join(', ');
	return `${call.name}(${args})`;
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
		const isObject = typeof entry === 'object' && entry !== null;
		const label = (isObject ? String((entry as Record<string, unknown>).label ?? '') : String(entry ?? '')).trim();
		if (!label) {
			continue;
		}
		const description = isObject ? String((entry as Record<string, unknown>).description ?? '').trim() : '';
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
