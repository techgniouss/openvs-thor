/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentCallbacks, AgentRunner } from '../agent/agentRunner';
import { contextWindowFor } from '../agent/contextWindow';
import { ToolApprover } from '../agent/tools';
import { McpToolset } from '../mcp/manager';
import { TodoItem } from '../persona/todos';
import { ProviderRegistry } from '../providers/registry';
import { ChatMessage, ToolCall, streamChatWithContinuation } from '../providers/types';
import { AutoRole, RoleAssignment, RoleRouter } from './router';

/** Events the orchestrator emits as it moves through the plan → code → review phases. */
export interface AutoCallbacks {
	/** A new phase is starting. `streaming` is true for text phases (plan/review). */
	phase(role: AutoRole, assignment: RoleAssignment, streaming: boolean): void;
	/** A streamed text delta (plan/review text, or implementer narration). */
	token(delta: string): void;
	/** The implementer is beginning a new model step (open a fresh bubble). */
	agentStepStart(): void;
	/** The implementer's current step finished (authoritative full text). */
	agentStepEnd(content: string): void;
	onToolStart(call: ToolCall): void;
	onToolEnd(call: ToolCall, result: string, isError: boolean): void;
	/** An informational note (skipped review, model fallback, step limit, …). */
	note(text: string): void;
	/** The implementer's visible checklist changed. */
	onTodos?(items: TodoItem[]): void;
}

export interface AutoRunParams {
	readonly history: ChatMessage[];
	readonly contextText?: string;
	readonly baseSystemPrompt: string;
	readonly signal: AbortSignal;
}

/** Collects what the implementer did, so the reviewer can critique the real changes. */
interface ChangeSink {
	readonly narration: string[];
	readonly changes: string[];
}

/**
 * Orchestrates an "Auto" run: it plans with one model, implements with another (driving
 * the agent tool-loop), and reviews with a third — each chosen by the {@link RoleRouter}.
 *
 * Consistency guarantees: each phase uses exactly the model resolved for its role. A role
 * the user *explicitly configured* is never substituted — if it can't run, the run stops
 * with a clear message. Only *inferred* roles fall back to the next best model, and only
 * when the first fails with a model-not-found-style error before any side effects.
 */
export class AutoOrchestrator {
	constructor(
		private readonly registry: ProviderRegistry,
		private readonly router: RoleRouter,
		private readonly approver: ToolApprover,
		private readonly maxSteps: number,
		private readonly mcp?: McpToolset,
	) { }

	async run(params: AutoRunParams, cb: AutoCallbacks): Promise<void> {
		const planCandidates = await this.router.resolveRoleCandidates('plan');
		const codeCandidates = await this.router.resolveRoleCandidates('code');
		const reviewEnabled = this.router.isReviewEnabled();
		let reviewCandidates = reviewEnabled ? await this.router.resolveRoleCandidates('review') : [];

		// Pre-flight. Plan and code are required; a broken *configured* role hard-stops.
		requireReady(planCandidates[0]);
		requireReady(codeCandidates[0]);
		if (reviewCandidates.length && !reviewCandidates[0].ready) {
			if (reviewCandidates[0].source === 'configured') {
				requireReady(reviewCandidates[0]); // user pinned a model we can't run — surface it
			} else {
				cb.note(`Skipping review — ${reviewCandidates[0].problem}`);
				reviewCandidates = [];
			}
		}

		const maxTokens = this.registry.getMaxTokens();
		const ctxMessages: ChatMessage[] = params.contextText
			? [{ role: 'user', content: `Context for the request:\n\n${params.contextText}` }]
			: [];
		const lastUser = [...params.history].reverse().find(m => m.role === 'user')?.content ?? '';

		// --- 1. PLAN ------------------------------------------------------------
		const planText = await this.streamWithFallback('plan', planCandidates, [
			{ role: 'system', content: planSystem(params.baseSystemPrompt) },
			...ctxMessages,
			...params.history,
		], maxTokens, params.signal, cb);

		if (params.signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}

		// --- 2. IMPLEMENT (agent tool-loop) -------------------------------------
		const sink: ChangeSink = { narration: [], changes: [] };
		const steps = this.router.isDecompose() ? extractSteps(planText) : [];
		if (steps.length >= 2) {
			await this.runCodeDecomposed(codeCandidates, steps, planText, ctxMessages, params, maxTokens, cb, sink);
		} else {
			await this.runCode(codeCandidates, [
				{ role: 'system', content: codeSystem(params.baseSystemPrompt) },
				...ctxMessages,
				...params.history,
				{ role: 'assistant', content: `Here is the plan to follow:\n\n${planText}` },
				{ role: 'user', content: 'Implement this plan now using the tools.' },
			], maxTokens, params.signal, cb, sink);
		}

		if (!reviewCandidates.length || params.signal.aborted) {
			return;
		}

		// --- 3. REVIEW ----------------------------------------------------------
		await this.streamWithFallback('review', reviewCandidates, [
			{ role: 'system', content: reviewSystem(params.baseSystemPrompt) },
			{
				role: 'user',
				content:
					`Original request:\n${lastUser}\n\n` +
					`Plan that was followed:\n${planText}\n\n` +
					`Implementer's summary:\n${sink.narration.join('\n') || '(none)'}\n\n` +
					`Actual changes made:\n${sink.changes.join('\n\n') || '(no file or command changes were recorded)'}\n\n` +
					`Review the changes above against the request and plan. Point out correctness bugs, ` +
					`missed steps and risks. Be concise and specific. If it is correct and complete, say so.`,
			},
		], maxTokens, params.signal, cb);
	}

	/** Streams a text phase (plan/review), falling back to the next inferred candidate on a model error. */
	private async streamWithFallback(
		role: AutoRole,
		candidates: RoleAssignment[],
		messages: ChatMessage[],
		maxTokens: number,
		signal: AbortSignal,
		cb: AutoCallbacks,
	): Promise<string> {
		let lastError: unknown;
		for (let i = 0; i < candidates.length; i++) {
			const a = candidates[i];
			if (!a.ready) {
				lastError = new Error(`${a.roleLabel} model is unavailable — ${a.problem ?? 'not configured.'}`);
				continue;
			}
			cb.phase(role, a, true);
			try {
				return await this.streamOnce(a, messages, maxTokens, signal, cb);
			} catch (err) {
				if (signal.aborted) {
					throw err;
				}
				const next = candidates[i + 1];
				if (a.source === 'inferred' && isModelError(err) && next?.ready) {
					cb.note(`${a.model} unavailable — trying ${next.model}.`);
					lastError = err;
					continue;
				}
				throw err;
			}
		}
		throw lastError instanceof Error ? lastError : new Error(`No model available for ${role}.`);
	}

	private async streamOnce(
		assignment: RoleAssignment,
		messages: ChatMessage[],
		maxTokens: number,
		signal: AbortSignal,
		cb: AutoCallbacks,
	): Promise<string> {
		const provider = this.registry.getProvider(assignment.providerId);
		if (!provider) {
			throw new Error(`${assignment.roleLabel} provider "${assignment.providerId}" is unavailable.`);
		}
		const { text, truncated } = await streamChatWithContinuation(provider, {
			messages,
			model: assignment.model,
			apiKey: await this.apiKey(assignment.providerId),
			baseUrl: this.registry.getBaseUrl(assignment.providerId),
			maxTokens,
			signal,
			onToken: delta => cb.token(delta),
			onNotice: text => cb.note(text),
		});
		if (truncated) {
			// A cut-off plan or review feeds the next phase; say so rather than passing a
			// half-finished document downstream silently.
			cb.note(`The ${assignment.roleLabel} output is still incomplete after several continuations — raise "openvsChat.maxTokens" for a fuller result.`);
		}
		return text;
	}

	/** Runs the implementation tool-loop, falling back to the next inferred model on an early model error. */
	private async runCode(
		candidates: RoleAssignment[],
		seed: ChatMessage[],
		maxTokens: number,
		signal: AbortSignal,
		cb: AutoCallbacks,
		sink: ChangeSink,
	): Promise<void> {
		let lastError: unknown;
		for (let i = 0; i < candidates.length; i++) {
			const a = candidates[i];
			if (!a.ready) {
				lastError = new Error(`${a.roleLabel} model is unavailable — ${a.problem ?? 'not configured.'}`);
				continue;
			}
			const provider = this.registry.getProvider(a.providerId);
			if (!provider) {
				lastError = new Error(`Implementation provider "${a.providerId}" is unavailable.`);
				continue;
			}
			cb.phase('code', a, false);
			// The whole seed is the task definition (system prompt, context, plan, the
			// instruction); only what the agent produces during the run may be compacted.
			const runner = new AgentRunner(provider, this.approver, this.maxSteps, {
				mcp: this.mcp,
				contextWindow: contextWindowFor(a.model),
				keepHead: seed.length,
			});
			try {
				const outcome = await runner.run(
					seed,
					{
						model: a.model,
						apiKey: await this.apiKey(a.providerId),
						baseUrl: this.registry.getBaseUrl(a.providerId),
						maxTokens,
						signal,
					},
					agentCallbacks(cb, sink),
				);
				if (outcome.reason !== 'done' && outcome.detail) {
					cb.note(outcome.detail);
				}
				return;
			} catch (err) {
				if (signal.aborted) {
					throw err;
				}
				const next = candidates[i + 1];
				// Only safe to switch models if nothing has happened yet (model error on step 1).
				const untouched = sink.narration.length === 0 && sink.changes.length === 0;
				if (a.source === 'inferred' && isModelError(err) && untouched && next?.ready) {
					cb.note(`${a.model} unavailable — trying ${next.model}.`);
					lastError = err;
					continue;
				}
				throw err;
			}
		}
		throw lastError instanceof Error ? lastError : new Error('No implementation model available.');
	}

	/** Planner-decomposition path: run a fresh sub-agent for each numbered plan step, in order. */
	private async runCodeDecomposed(
		candidates: RoleAssignment[],
		steps: string[],
		planText: string,
		ctxMessages: ChatMessage[],
		params: AutoRunParams,
		maxTokens: number,
		cb: AutoCallbacks,
		sink: ChangeSink,
	): Promise<void> {
		const a = candidates.find(c => c.ready) ?? candidates[0];
		requireReady(a);
		const provider = this.registry.getProvider(a.providerId);
		if (!provider) {
			throw new Error(`Implementation provider "${a.providerId}" is unavailable.`);
		}
		cb.phase('code', a, false);
		cb.note(`Decomposed the plan into ${steps.length} steps; running a sub-agent per step.`);

		const budget = { spawned: 0 }; // shared cap across every step's sub-agents
		const runParams = {
			model: a.model,
			apiKey: await this.apiKey(a.providerId),
			baseUrl: this.registry.getBaseUrl(a.providerId),
			maxTokens,
			signal: params.signal,
		};
		for (let i = 0; i < steps.length; i++) {
			if (params.signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			cb.note(`Step ${i + 1}/${steps.length}: ${steps[i]}`);
			const stepSeed: ChatMessage[] = [
				{ role: 'system', content: codeSystem(params.baseSystemPrompt) },
				...ctxMessages,
				{ role: 'assistant', content: `Overall plan:\n\n${planText}` },
				{ role: 'user', content: `Complete ONLY this step of the plan, using the tools:\n\n${steps[i]}` },
			];
			// Protect the whole seed: compacting away "Complete ONLY this step" would let
			// the agent drift onto the rest of the plan.
			const runner = new AgentRunner(provider, this.approver, this.maxSteps, {
				budget,
				mcp: this.mcp,
				contextWindow: contextWindowFor(a.model),
				keepHead: stepSeed.length,
			});
			const outcome = await runner.run(stepSeed, runParams, agentCallbacks(cb, sink));
			if (outcome.reason !== 'done' && outcome.detail) {
				cb.note(`Step ${i + 1} stopped early — ${outcome.detail}`);
			}
		}
	}

	private async apiKey(providerId: string): Promise<string> {
		return (await this.registry.getApiKey(providerId)) ?? '';
	}
}

/** Builds the agent callbacks that forward to the UI and capture changes for review. */
function agentCallbacks(cb: AutoCallbacks, sink: ChangeSink): AgentCallbacks {
	return {
		onStepStart: () => cb.agentStepStart(),
		onToken: delta => cb.token(delta),
		onStepEnd: content => { if (content) { sink.narration.push(content); } cb.agentStepEnd(content); },
		onToolStart: call => { recordChangeStart(sink, call); cb.onToolStart(call); },
		onToolEnd: (call, result, isError) => { recordChangeEnd(sink, call, result, isError); cb.onToolEnd(call, result, isError); },
		onNote: text => cb.note(text),
		onTodos: items => cb.onTodos?.(items),
	};
}

/** Extracts numbered steps ("1. …", "2) …") from a plan for decomposition. */
function extractSteps(plan: string): string[] {
	const steps: string[] = [];
	for (const raw of plan.split('\n')) {
		const match = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
		if (match && match[1].trim()) {
			steps.push(match[1].trim());
		}
	}
	return steps;
}

function requireReady(a: RoleAssignment): void {
	if (!a.ready) {
		throw new Error(`${a.roleLabel} model is unavailable — ${a.problem ?? 'not configured.'}`);
	}
}

/** Heuristic: did a failure come from an invalid/unknown model id (vs. a real runtime error)? */
function isModelError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return msg.includes('404')
		|| msg.includes('not found')
		|| msg.includes('does not exist')
		|| msg.includes('not_found')
		|| msg.includes('model_not_found')
		|| msg.includes('invalid model')
		|| (msg.includes('model') && msg.includes('invalid'));
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + `\n… [truncated, ${text.length} chars total]` : text;
}

function recordChangeStart(sink: ChangeSink, call: ToolCall): void {
	if (call.name === 'write_file') {
		const path = String(call.args.path ?? '');
		const content = String(call.args.content ?? '');
		sink.changes.push(`Wrote \`${path}\`:\n\`\`\`\n${truncate(content, 2000)}\n\`\`\``);
	}
	if (call.name === 'edit_file') {
		const path = String(call.args.path ?? '');
		const oldText = String(call.args.oldText ?? '');
		const newText = String(call.args.newText ?? '');
		sink.changes.push(`Edited \`${path}\`:\nReplaced:\n\`\`\`\n${truncate(oldText, 1000)}\n\`\`\`\nWith:\n\`\`\`\n${truncate(newText, 1000)}\n\`\`\``);
	}
}

function recordChangeEnd(sink: ChangeSink, call: ToolCall, result: string, _isError: boolean): void {
	if (call.name === 'run_command') {
		const command = String(call.args.command ?? '');
		sink.changes.push(`Ran \`${command}\`\nOutput:\n${truncate(result, 1500)}`);
	}
}

function planSystem(base: string): string {
	return `${base}\n\nYou are the PLANNER in an automated plan→implement→review pipeline. ` +
		`Read the user's request and produce a clear, concise, numbered plan: the concrete steps, ` +
		`which files to touch, and any risks or unknowns. Do NOT write the full solution and do NOT ` +
		`call tools — output only the plan, as tightly as possible.`;
}

function codeSystem(base: string): string {
	return `${base}\n\nYou are the IMPLEMENTER in AGENT mode, with tools to read, list, write and edit files ` +
		`and run commands in the user's workspace (writes and commands require user approval). A plan has ` +
		`already been prepared — follow it. Use tools to make the changes. Ask only when truly ambiguous. ` +
		`When finished, briefly summarize what you changed.`;
}

function reviewSystem(base: string): string {
	return `${base}\n\nYou are the REVIEWER in an automated plan→implement→review pipeline. You did NOT ` +
		`write this code. Critically review the implementation against the original request and plan: ` +
		`correctness, missed steps, bugs and risks. Be concise and specific. If it is correct and complete, ` +
		`say so plainly; otherwise list concrete issues and suggested fixes.`;
}
