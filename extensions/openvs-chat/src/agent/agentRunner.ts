/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpToolset } from '../mcp/manager';
import { SUBAGENT_PREAMBLE } from '../persona/prompts';
import { stripThinking } from '../persona/thinking';
import { TodoItem, UPDATE_TODOS_TOOL, parseTodoUpdate } from '../persona/todos';
import { AgentStep, CONTINUE_PROMPT, ChatProvider, ChatMessage, ToolCall, ToolSpec } from '../providers/types';
import { COMPACT_MARKER, compactMessages, compactionThreshold, shouldCompact } from './compaction';
import { isContextLengthError, trimMessages } from './context';
import { Guardrails, autoApproves, loadGuardrails } from './guardrails';
import { AGENT_TOOLS, READ_ONLY_TOOL_NAMES, SPAWN_SUBAGENT_TOOL, ToolApprover, executeTool } from './tools';

const MCP_PREFIX = 'mcp__';

/**
 * Why a run ended. Every terminal path maps onto one of these so the UI can always
 * tell the user *why* it stopped — a run that just goes quiet is a bug, not an outcome.
 */
export type StopReason = 'done' | 'limit' | 'truncated' | 'filtered' | 'refused';

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
 * Injected when a step produces prose but no tool call. Models routinely narrate a
 * next action ("now I'll update the config") without performing it; treating that as
 * "finished" was the main cause of runs stopping mid-task. One nudge per quiet
 * stretch — if the model stays quiet after being asked, it really is done.
 */
const COMPLETION_CHECK_PROMPT =
	'Before you finish: if the task is fully complete and verified, reply with a brief final ' +
	'summary of what changed. If ANY part remains — files still to edit, commands still to run, ' +
	'unchecked items on your checklist, or a next step you just described — do it now with your ' +
	'tools instead of summarizing. Do not ask permission to continue; keep working.';

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
	/**
	 * The run compacted its own conversation. Reported for visibility only — do NOT feed
	 * `replaced` to the webview's compaction accounting: mid-run the array also holds
	 * tool turns the webview never stored, so its count would over-advance and drop
	 * recent turns the summary never covered.
	 */
	onCompacted?(summary: string, replaced: number): void;
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
	private contextBudget: number;

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
			return AGENT_TOOLS.filter(t => READ_ONLY_TOOL_NAMES.includes(t.name));
		}
		const base = [...AGENT_TOOLS];
		if (this.depth === 0) {
			base.push(UPDATE_TODOS_TOOL);
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
		let nudged = false;

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
			if (this.contextWindow && !this.compactionExhausted && shouldCompact(messages, this.contextWindow, this.contextBudget)) {
				const compacted = await this.compact(messages, params);
				if (compacted) {
					messages.splice(0, messages.length, ...compacted.messages);
					callbacks.onNote(`Compacted the conversation (~${Math.round(compacted.before / 1000)}k → ~${Math.round(compacted.after / 1000)}k tokens).`);
					const summary = compacted.messages.find(m => m.content.startsWith(COMPACT_MARKER));
					if (summary) {
						callbacks.onCompacted?.(summary.content, compacted.replaced);
					}
					// Still over the line afterwards means the protected head alone exceeds
					// the threshold — summarizing again would cost a request per few steps
					// and shrink nothing. Hand the rest of the run to the trim instead.
					if (compacted.after >= compactionThreshold(this.contextWindow, this.contextBudget)) {
						this.compactionExhausted = true;
						callbacks.onNote('The conversation is still near the context limit after compacting — older tool output will be trimmed from here on.');
					}
				} else {
					// Nothing summarizable, or the summarizer failed: retrying every step
					// would repeat that cost for the same outcome.
					this.compactionExhausted = true;
				}
			}

			callbacks.onStepStart();
			const result = await this.step(messages, params, callbacks);
			callbacks.onStepEnd(result.content);

			messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

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
				// In write-capable Agent mode, prose with no tool call usually means the model
				// described a next action instead of taking it — ask once before believing
				// it's done. Read-only Ask/Plan and research sub-agents legitimately end with
				// a prose answer, so they finish immediately (no wasted round).
				if (!this.readOnly && !nudged) {
					nudged = true;
					step++;
					messages.push({ role: 'user', content: COMPLETION_CHECK_PROMPT });
					continue;
				}
				return { reason: 'done' };
			}

			truncationRounds = 0;
			nudged = false;
			step++;

			const outcomes = await this.runTools(result.toolCalls, params, callbacks);
			for (const { call, result: toolResult } of outcomes) {
				messages.push({ role: 'tool', content: toolResult, toolCallId: call.id });
			}
		}

		return {
			reason: 'limit',
			detail: `Reached the ${this.maxSteps}-step limit. Send "continue" to keep going, or raise "openvsChat.agent.maxSteps".`,
		};
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
				const outcome = 'error' in parsed
					? { result: parsed.error, isError: true }
					: (callbacks.onTodos?.(parsed.items),
						{ result: `Checklist updated (${parsed.items.length} item(s)).`, isError: false });
				callbacks.onToolEnd(call, outcome.result, outcome.isError);
				outcomes.push({ call, ...outcome });
				continue;
			}
			callbacks.onToolStart(call);
			const { result, isError } = call.name.startsWith(MCP_PREFIX)
				? await this.callMcp(call)
				: await executeTool(call, this.approver, this.guardrails);
			callbacks.onToolEnd(call, result, isError);
			outcomes.push({ call, result, isError });
		}

		if (spawnCalls.length) {
			const runOne = async (call: ToolCall) => {
				callbacks.onToolStart(call);
				const { result, isError } = await this.runSubagent(call, params, callbacks);
				callbacks.onToolEnd(call, result, isError);
				return { call, result, isError };
			};
			const readOnly = spawnCalls.filter(c => c.args.readOnly === true);
			const writal = spawnCalls.filter(c => c.args.readOnly !== true);
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
			const approved = await this.approver.confirm(
				`Allow the MCP tool "${call.name}"?`,
				JSON.stringify(call.args).slice(0, 500),
			);
			if (!approved) {
				return { result: 'User denied the MCP tool call.', isError: true };
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

function shortArgs(args: Record<string, unknown>): string {
	try {
		const s = JSON.stringify(args);
		return s.length > 60 ? s.slice(0, 57) + '…' : s;
	} catch {
		return '';
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + '…' : text;
}
