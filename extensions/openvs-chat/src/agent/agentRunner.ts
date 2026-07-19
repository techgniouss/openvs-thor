/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpToolset } from '../mcp/manager';
import { SUBAGENT_PREAMBLE } from '../persona/prompts';
import { TodoItem, UPDATE_TODOS_TOOL, parseTodoUpdate } from '../persona/todos';
import { CONTINUE_PROMPT, ChatProvider, ChatMessage, ToolCall, ToolSpec } from '../providers/types';
import { Guardrails, autoApproves, loadGuardrails } from './guardrails';
import { AGENT_TOOLS, READ_ONLY_TOOL_NAMES, SPAWN_SUBAGENT_TOOL, ToolApprover, executeTool } from './tools';

const MCP_PREFIX = 'mcp__';

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

	async run(seed: ChatMessage[], params: AgentParams, callbacks: AgentCallbacks): Promise<void> {
		if (!this.provider.runAgentStep) {
			throw new Error(`${this.provider.info.label} does not support Agent mode.`);
		}

		const messages: ChatMessage[] = [...seed];

		for (let step = 0; step < this.maxSteps; step++) {
			if (params.signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}

			// Course corrections typed while the previous step ran enter the loop here.
			for (const note of this.steering?.() ?? []) {
				messages.push({ role: 'user', content: note });
			}

			callbacks.onStepStart();
			const result = await this.provider.runAgentStep({
				messages,
				tools: this.tools(),
				model: params.model,
				apiKey: params.apiKey,
				baseUrl: params.baseUrl,
				maxTokens: params.maxTokens,
				signal: params.signal,
				onToken: delta => callbacks.onToken(delta),
			});
			callbacks.onStepEnd(result.content);

			messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

			if (!result.toolCalls.length) {
				// A text-only step cut off by the max-token limit isn't the model being
				// done — ask it to resume where it stopped (costs one step of budget).
				if (result.truncated && result.content) {
					messages.push({ role: 'user', content: CONTINUE_PROMPT });
					continue;
				}
				return; // Model is done.
			}

			const outcomes = await this.runTools(result.toolCalls, params, callbacks);
			for (const { call, result: toolResult } of outcomes) {
				messages.push({ role: 'tool', content: toolResult, toolCallId: call.id });
			}
		}

		callbacks.onNote(`Reached the ${this.maxSteps}-step limit. Send "continue" to keep going.`);
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
				const { result, isError } = await this.runSubagent(call, params);
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
	private async runSubagent(call: ToolCall, params: AgentParams): Promise<{ result: string; isError: boolean }> {
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
		try {
			await child.run(
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
					onNote: t => log.push(t),
				},
			);
		} catch (err) {
			return { result: `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}

		const summary = finalText || '(sub-agent produced no summary)';
		return { result: `${summary}\n\n[sub-agent activity]\n${truncate(log.join('\n'), 1500)}`, isError: false };
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
