/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentCallbacks, AgentOptions, AgentRunner, RunResult } from '../agent/agentRunner';
import { streamBudgeted } from '../agent/budgetedStream';
import { contextTurn } from '../agent/context';
import { contextWindowFor, requestBudgets } from '../agent/contextWindow';
import { Guardrails } from '../agent/guardrails';
import { ToolApprover, asString, commandTextOf, normalizeToolCall } from '../agent/tools';
import { McpToolset } from '../mcp/manager';
import { modeDoctrine } from '../persona/prompts';
import { TodoItem } from '../persona/todos';
import { ProviderRegistry } from '../providers/registry';
import { isKeyFailure, withProviderResilience } from '../providers/resilience';
import { ChatMessage, ChatProvider, ModelEntry, ToolCall, isAbortError, isTransientProviderError } from '../providers/types';
import { AutoRole, CredentialMemo, RoleAssignment, RoleRouter } from './router';

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
	/** `parentCallId` mirrors `AgentCallbacks.onToolStart`'s — set only for a sub-agent's own nested tool activity. */
	onToolStart(call: ToolCall, parentCallId?: string): void;
	/** `parentCallId` mirrors `AgentCallbacks.onToolEnd`'s. */
	onToolEnd(call: ToolCall, result: string, isError: boolean, parentCallId?: string): void;
	/** An informational note (skipped review, model fallback, step limit, …). */
	note(text: string): void;
	/** The implementer's visible checklist changed. */
	onTodos?(items: TodoItem[]): void;
}

export interface AutoRunParams {
	readonly history: ChatMessage[];
	readonly contextText?: string;
	readonly baseSystemPrompt: string;
	/**
	 * The condensed base prompt, sent in place of {@link baseSystemPrompt} to a phase whose
	 * model's request budget cannot carry it (see `needsCompactPrompt`).
	 */
	readonly compactBaseSystemPrompt?: string;
	/** `openvsChat.persona.thinking`: whether the implementer gets the <thinking> scaffold. */
	readonly thinking?: boolean;
	/** `openvsChat.persona.compactPrompt` is `always`: the implementer starts on the compact prompt and condensed schemas. */
	readonly forceCompactPrompt?: boolean;
	readonly signal: AbortSignal;
	/**
	 * Drains course corrections the user typed while the run was in flight, so the
	 * implementer picks them up between steps exactly as a plain Agent run does.
	 */
	readonly steering?: () => string[];
}

/** Collects what the implementer did, so the reviewer can critique the real changes. */
interface ChangeSink {
	readonly narration: string[];
	readonly changes: string[];
	/**
	 * How the implementation phase ended, when it ended for any reason other than
	 * finishing. The reviewer is told: reviewing a half-applied change as though it were
	 * the finished article is how an Auto run reports "correct and complete" over work
	 * that stopped at the step limit.
	 */
	unfinished?: string;
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
		/**
		 * The host's cached model catalog for a provider, when it has been fetched. Without
		 * it every Auto run sized its context window from the model *name* alone, so any
		 * model the name table doesn't know fell back to the conservative default — which
		 * made compaction fire after the first few file reads and summarize away the working
		 * state the implementer still needed. The plain Agent path has always used it.
		 */
		private readonly catalog?: (providerId: string) => ModelEntry[] | undefined,
		/**
		 * Wall-clock ceiling for the whole Auto run, in ms; 0 for none. Shared across the
		 * phases rather than granted to each: three phases with a 30-minute ceiling apiece
		 * is a 90-minute run, which is not what the setting says.
		 */
		private readonly maxRunMs = 0,
		/** Per-step timing notes, forwarded to every runner this orchestrates. */
		private readonly traceTiming = false,
		/**
		 * The run's already-resolved {@link Guardrails} (the remote approval floor already
		 * applied, per "Phase 7a" — see `chatViewProvider.ts`'s `guardrailsForRun`). Forwarded
		 * to every `AgentRunner` this orchestrates, most importantly the implementer phase
		 * (`runCode`/`runCodeDecomposed`), which is a real write/command-capable tool loop and
		 * would otherwise fall back to `AgentRunner`'s own `loadGuardrails()` default —
		 * silently re-reading the unfloored, possibly `yolo`, desktop setting for a run that
		 * may have been triggered remotely. Optional only so a caller that has no `Guardrails`
		 * value on hand yet (none exist today) still compiles; `AgentRunner` supplies its own
		 * default in that case, same as before this parameter existed.
		 */
		private readonly guardrails?: Guardrails,
	) { }

	/** When this Auto run started, so each phase gets what is left rather than a fresh budget. */
	private startedAt = Date.now();

	/** Whether this run already said it uses the compact prompt; once covers every phase. */
	private compactNoted = false;

	/** See {@link AutoRunParams.forceCompactPrompt}; set when the run starts. */
	private forceCompactPrompt = false;

	/** Relays a phase's switch to the compact prompt, once per run. */
	private noteCompactPrompt(cb: AutoCallbacks, notice: string): void {
		if (!this.compactNoted) {
			this.compactNoted = true;
			cb.note(notice);
		}
	}

	/** The wall-clock allowance to hand the next runner, floored so a late phase still runs. */
	private remainingRunMs(): number {
		if (this.maxRunMs <= 0) {
			return 0;
		}
		return Math.max(60_000, this.maxRunMs - (Date.now() - this.startedAt));
	}

	/** The run-length options every runner in this pipeline shares. */
	private runLimits(): { maxRunMs: number; traceTiming: boolean } {
		return { maxRunMs: this.remainingRunMs(), traceTiming: this.traceTiming };
	}

	/**
	 * Reply reservation and conversation budget for a text phase, clamped by any per-request
	 * allowance the backend has already stated in its response headers.
	 */
	private textBudgets(provider: ChatProvider, assignment: RoleAssignment, maxTokens: number): { maxTokens: number; contextBudget: number } {
		return requestBudgets({
			model: assignment.model,
			maxOutputTokens: maxTokens,
			entries: this.catalog?.(assignment.providerId),
			stated: provider.rateLimit?.(assignment.model)?.requestCeiling,
		});
	}

	/**
	 * Context window, trim budget and reply cap for the implementer's model, from the same
	 * {@link requestBudgets} every other path sizes its requests with. Derived from the window
	 * alone, an 8k-window model was handed an 8k conversation *and* the full reply reservation,
	 * and an allowance the backend had already stated was ignored until the run re-learned it.
	 */
	private budgetFor(provider: ChatProvider, assignment: RoleAssignment, maxTokens: number): Pick<AgentOptions, 'contextWindow' | 'maxContextTokens' | 'maxOutputTokens'> {
		const entries = this.catalog?.(assignment.providerId);
		const budgets = requestBudgets({
			model: assignment.model,
			maxOutputTokens: maxTokens,
			entries,
			stated: provider.rateLimit?.(assignment.model)?.requestCeiling,
		});
		return {
			contextWindow: contextWindowFor(assignment.model, entries),
			maxContextTokens: budgets.contextBudget,
			// Only when the request had to be split: the option also lowers the run's budget
			// floor, which is right for a derived ceiling and wrong for a roomy window.
			maxOutputTokens: budgets.maxTokens < maxTokens ? budgets.maxTokens : undefined,
		};
	}

	async run(params: AutoRunParams, cb: AutoCallbacks): Promise<void> {
		this.startedAt = Date.now();
		this.forceCompactPrompt = !!params.forceCompactPrompt;
		// One credential sweep for all three roles rather than one per role.
		const memo: CredentialMemo = new Map();
		// The planner and the implementer are both handed the conversation, so if it carries
		// image attachments they must be able to read them; the reviewer is given a text-only
		// brief and is not constrained. Routing on this beats discovering it as a provider 400
		// several phases in, and it means an image simply steers Auto to a model that can see.
		const needs = { vision: params.history.some(m => !!m.images?.length) };
		const planCandidates = await this.router.resolveRoleCandidates('plan', needs, memo);
		const codeCandidates = await this.router.resolveRoleCandidates('code', needs, memo);
		const reviewEnabled = this.router.isReviewEnabled();
		let reviewCandidates = reviewEnabled ? await this.router.resolveRoleCandidates('review', {}, memo) : [];

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
			? [contextTurn(params.contextText)]
			: [];
		const lastUser = [...params.history].reverse().find(m => m.role === 'user')?.content ?? '';

		// --- 1. PLAN ------------------------------------------------------------
		const planText = await this.streamWithFallback('plan', planCandidates, [
			{ role: 'system', content: planSystem(params.baseSystemPrompt) },
			...ctxMessages,
			...params.history,
		], maxTokens, params.signal, cb, compactOf(params, planSystem));

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
				{ role: 'system', content: codeSystem(params.baseSystemPrompt, false, params.thinking) },
				...ctxMessages,
				...params.history,
				{ role: 'assistant', content: `Here is the plan to follow:\n\n${planText}` },
				{ role: 'user', content: 'Implement this plan now using the tools.' },
			], maxTokens, params.signal, cb, sink, params.steering, compactOf(params, (base, compact) => codeSystem(base, compact, params.thinking)));
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
					(sink.unfinished
						? `IMPORTANT — the implementation did NOT run to completion:\n${sink.unfinished}\n` +
						`Treat the changes above as partial. Say explicitly what is still missing; do not report the work complete.\n\n`
						: '') +
					`Review the changes above against the request and plan. Point out correctness bugs, ` +
					`missed steps and risks. Be concise and specific. If it is correct and complete, say so.`,
			},
		], maxTokens, params.signal, cb, compactOf(params, reviewSystem));
	}

	/**
	 * The candidate the implementer falls back to after candidate `i` failed with `err`, or -1.
	 * Only an inferred role, and only while nothing has happened yet: a second model picking up
	 * half-applied work it never saw would redo or contradict it.
	 */
	private implementerFallback(candidates: readonly RoleAssignment[], i: number, err: unknown, sink: ChangeSink): number {
		const untouched = sink.narration.length === 0 && sink.changes.length === 0;
		return candidates[i].source === 'inferred' && untouched ? nextCandidate(candidates, i, err) : -1;
	}

	/** Streams a text phase (plan/review), falling back to the next inferred candidate when it fails. */
	private async streamWithFallback(
		role: AutoRole,
		candidates: RoleAssignment[],
		messages: ChatMessage[],
		maxTokens: number,
		signal: AbortSignal,
		cb: AutoCallbacks,
		compactSystem?: string,
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
				return await this.streamOnce(a, messages, maxTokens, signal, cb, compactSystem);
			} catch (err) {
				if (signal.aborted) {
					throw err;
				}
				const next = a.source === 'inferred' ? nextCandidate(candidates, i, err) : -1;
				if (next >= 0) {
					cb.note(fallbackNote(a, candidates[next], err));
					lastError = err;
					i = next - 1;
					continue;
				}
				throw a.source === 'configured' && isModelError(err) ? describePinnedModelError(a, err) : err;
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
		compactSystem?: string,
	): Promise<string> {
		const provider = this.registry.getProvider(assignment.providerId);
		if (!provider) {
			throw new Error(`${assignment.roleLabel} provider "${assignment.providerId}" is unavailable.`);
		}
		// Sized exactly as the plain streaming path sizes a request. These phases used to send
		// the conversation untrimmed with the full configured reservation, so on a backend with
		// a small per-request allowance the planner was refused before the implementer — which
		// does learn its ceiling — ever got to run.
		const budgets = this.textBudgets(provider, assignment, maxTokens);
		const { text, truncated, compactPrompt } = await withProviderResilience(this.registry, assignment.providerId, assignment.model, apiKey => streamBudgeted(provider, {
			messages,
			model: assignment.model,
			apiKey,
			baseUrl: this.registry.getBaseUrl(assignment.providerId),
			...budgets,
			compactSystem,
			signal,
			onToken: delta => cb.token(delta),
			onNotice: text => cb.note(text),
		}));
		if (compactPrompt) {
			this.noteCompactPrompt(cb, `${assignment.model}'s request budget is too small for the full instructions, so the ${assignment.roleLabel} phase was sent the compact prompt: condensed instructions, project rules shortened, active skills left out.`);
		}
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
		steering?: () => string[],
		compactSystem?: string,
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
				guardrails: this.guardrails,
				// This phase was handed a plan and told to carry it out, so "already done"
				// with no tool call is worth one push-back — the reading that lets a chat
				// turn end on its first reply must not also let the implementer opt out.
				expectsWork: true,
				...this.budgetFor(provider, a, maxTokens),
				keepHead: seed.length,
				steering,
				...this.runLimits(),
				...this.keyResilienceOptions(a.providerId, a.model),
				compactSystemPrompt: compactSystem,
				onCompactPrompt: notice => this.noteCompactPrompt(cb, notice),
				forceCompactPrompt: this.forceCompactPrompt,
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
				// A provider failure comes back as a result, not a throw — decided here by the
				// same rule as a thrown one below.
				const next = outcome.failure ? this.implementerFallback(candidates, i, outcome.failure, sink) : -1;
				if (next >= 0) {
					cb.note(fallbackNote(a, candidates[next], outcome.failure));
					lastError = outcome.failure;
					i = next - 1;
					continue;
				}
				noteOutcome(cb, sink, outcome);
				return;
			} catch (err) {
				if (signal.aborted) {
					throw err;
				}
				const next = this.implementerFallback(candidates, i, err, sink);
				if (next >= 0) {
					cb.note(fallbackNote(a, candidates[next], err));
					lastError = err;
					i = next - 1;
					continue;
				}
				throw a.source === 'configured' && isModelError(err) ? describePinnedModelError(a, err) : err;
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
		let index = candidates.findIndex(c => c.ready);
		let a = candidates[index] ?? candidates[0];
		requireReady(a);
		let provider = this.registry.getProvider(a.providerId);
		if (!provider) {
			throw new Error(`Implementation provider "${a.providerId}" is unavailable.`);
		}
		cb.phase('code', a, false);
		cb.note(`Decomposed the plan into ${steps.length} steps; running a sub-agent per step.`);

		const budget = { spawned: 0 }; // shared cap across every step's sub-agents
		let runParams = {
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
				{ role: 'system', content: codeSystem(params.baseSystemPrompt, false, params.thinking) },
				...ctxMessages,
				{ role: 'assistant', content: `Overall plan:\n\n${planText}` },
				{ role: 'user', content: `Complete ONLY this step of the plan, using the tools:\n\n${steps[i]}` },
			];
			// Protect the whole seed: compacting away "Complete ONLY this step" would let
			// the agent drift onto the rest of the plan.
			const runner = new AgentRunner(provider, this.approver, this.maxSteps, {
				budget,
				mcp: this.mcp,
				guardrails: this.guardrails,
				// One step of the same implementer — see runCode.
				expectsWork: true,
				...this.budgetFor(provider, a, maxTokens),
				keepHead: stepSeed.length,
				steering: params.steering,
				...this.keyResilienceOptions(a.providerId, a.model),
				...this.runLimits(),
				compactSystemPrompt: compactOf(params, (base, compact) => codeSystem(base, compact, params.thinking)),
				onCompactPrompt: notice => this.noteCompactPrompt(cb, notice),
				forceCompactPrompt: this.forceCompactPrompt,
			});
			// What this step had done when it failed decides whether another model may redo it.
			const before = { narration: sink.narration.length, changes: sink.changes.length };
			let outcome: RunResult | undefined;
			let failure: unknown;
			try {
				outcome = await runner.run(stepSeed, runParams, agentCallbacks(cb, sink));
				// A provider failure is reported, not thrown; it falls back by the same rule.
				failure = outcome.failure;
			} catch (err) {
				failure = err;
			}
			if (failure !== undefined) {
				const untouched = sink.narration.length === before.narration && sink.changes.length === before.changes;
				const next = !params.signal.aborted && a.source === 'inferred' && untouched ? nextCandidate(candidates, index, failure) : -1;
				const nextProvider = next >= 0 ? this.registry.getProvider(candidates[next].providerId) : undefined;
				if (!nextProvider) {
					if (!outcome) {
						throw a.source === 'configured' && isModelError(failure) ? describePinnedModelError(a, failure) : failure;
					}
					noteOutcome(cb, sink, outcome, `Step ${i + 1}/${steps.length}`);
					continue;
				}
				// The rest of the steps move to the next candidate too: the one that failed
				// would most likely fail them the same way.
				cb.note(fallbackNote(a, candidates[next], failure));
				index = next;
				a = candidates[next];
				provider = nextProvider;
				runParams = { ...runParams, model: a.model, apiKey: await this.apiKey(a.providerId), baseUrl: this.registry.getBaseUrl(a.providerId) };
				cb.phase('code', a, false);
				i--;
				continue;
			}
			noteOutcome(cb, sink, outcome!, `Step ${i + 1}/${steps.length}`);
		}
	}

	private async apiKey(providerId: string): Promise<string> {
		return (await this.registry.getApiKey(providerId)) ?? '';
	}

	/** Same shape as `chatViewProvider.ts`'s `keyResilienceOptions` — wired to this
	 * orchestrator's own registry so a phase's `AgentRunner` rotates keys and clears
	 * cooldowns identically to a plain Agent-mode run. */
	private keyResilienceOptions(providerId: string, model: string): Pick<AgentOptions, 'onKeyFailure' | 'onStepSuccess'> {
		return {
			onKeyFailure: async message => {
				this.registry.cooldowns.markCooldown(providerId, model, message);
				const rotated = await this.registry.rotateApiKey(providerId);
				return rotated ? (await this.registry.getApiKey(providerId)) ?? '' : undefined;
			},
			onStepSuccess: () => {
				this.registry.noteApiKeySuccess(providerId);
				this.registry.cooldowns.clear(providerId, model);
			},
		};
	}
}

/** Builds the agent callbacks that forward to the UI and capture changes for review. */
function agentCallbacks(cb: AutoCallbacks, sink: ChangeSink): AgentCallbacks {
	return {
		onStepStart: () => cb.agentStepStart(),
		onToken: delta => cb.token(delta),
		onStepEnd: content => { if (content) { sink.narration.push(content); } cb.agentStepEnd(content); },
		onToolStart: (call, parentCallId) => { recordChangeStart(sink, call); cb.onToolStart(call, parentCallId); },
		onToolEnd: (call, result, isError, parentCallId) => { recordChangeEnd(sink, call, result, isError); cb.onToolEnd(call, result, isError, parentCallId); },
		onNote: text => cb.note(text),
		onTodos: items => cb.onTodos?.(items),
	};
}

/**
 * Surfaces an implementation outcome to the user and, when it is not "done", records it
 * for the reviewer. A run that hit the step limit, was cut short by the provider or gave
 * up on a stalled model has produced a *partial* change; the reviewer must be told, or it
 * reviews half a change against the whole plan and signs it off.
 */
function noteOutcome(cb: AutoCallbacks, sink: ChangeSink, outcome: RunResult, label?: string): void {
	if (outcome.reason === 'done') {
		return;
	}
	const detail = outcome.detail ?? outcome.reason;
	cb.note(label ? `${label} stopped early — ${detail}` : detail);
	sink.unfinished = sink.unfinished
		? `${sink.unfinished}\n${label ?? 'Implementation'}: ${detail}`
		: `${label ?? 'Implementation'}: ${detail}`;
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

/**
 * Re-frames a model-not-found failure on a **pinned** role.
 *
 * A pin is never substituted, so this ends the run — and the raw provider body ("model:
 * meta/llama-3.3-70b-instruct" from Anthropic) says nothing about *why* a run the user
 * never configured that way is asking Anthropic for an NVIDIA model. Naming the role and
 * the pair points at the setting that is actually wrong.
 */
export function describePinnedModelError(a: RoleAssignment, err: unknown): Error {
	const detail = err instanceof Error ? err.message : String(err);
	return new Error(
		`The model pinned for ${a.roleLabel.toLowerCase()} — ${a.providerLabel} "${a.model}" — was rejected by the provider. ` +
		`Check that this model belongs to ${a.providerLabel} (⚙ Providers → Auto routing), or set the role back to Auto-select. ${detail}`,
	);
}

/**
 * Heuristic: did a failure come from an invalid/unknown model id (vs. a real runtime error)?
 * Exported because the single-model Auto paths (Ask/Plan/Edit) fall back on exactly the same
 * signal as the pipeline does — one rule, so the two modes can't disagree about what is
 * recoverable.
 */
export function isModelError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return msg.includes('404')
		|| msg.includes('not found')
		|| msg.includes('does not exist')
		|| msg.includes('not_found')
		|| msg.includes('model_not_found')
		|| msg.includes('invalid model')
		|| (msg.includes('model') && msg.includes('invalid'));
}

/**
 * How far an inferred role may fall back after `err`: `'model'` when this model is the
 * problem (not found, not entitled) and a sibling from the same provider may still serve;
 * `'provider'` when the provider itself failed (quota, a rejected key, an outage, the network)
 * and its other models would fail alike; undefined when no other model would do better (a
 * cancellation, a malformed request).
 *
 * Only a model-not-found used to fall back at all, so a 429 on the first-ranked provider
 * ended the whole Auto run while the user held keys for others ranked right behind it.
 */
export function fallbackScope(err: unknown): 'model' | 'provider' | undefined {
	if (isAbortError(err)) {
		return undefined;
	}
	if (isModelError(err)) {
		return 'model';
	}
	const message = err instanceof Error ? err.message : String(err);
	return isKeyFailure(message) || isTransientProviderError(message) ? 'provider' : undefined;
}

/**
 * The index of the candidate to fall back to after candidate `from` failed with `err`, or -1.
 * A provider-wide failure skips that provider's remaining models.
 */
export function nextCandidate(candidates: readonly RoleAssignment[], from: number, err: unknown): number {
	const scope = fallbackScope(err);
	if (!scope) {
		return -1;
	}
	const failed = candidates[from];
	for (let j = from + 1; j < candidates.length; j++) {
		if (candidates[j].ready && (scope === 'model' || candidates[j].providerId !== failed.providerId)) {
			return j;
		}
	}
	return -1;
}

/** The note shown when a phase moves to its next candidate, naming why. */
export function fallbackNote(failed: RoleAssignment, next: RoleAssignment, err: unknown): string {
	const why = fallbackScope(err) === 'provider' ? `${failed.providerLabel} failed` : `${failed.model} unavailable`;
	return `${why} — trying ${next.providerLabel} · ${next.model}.`;
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max) + `\n… [truncated, ${text.length} chars total]` : text;
}

/**
 * Records a change for the reviewer.
 *
 * The call is normalized first, exactly as the executor normalizes it. Reading the raw
 * arguments meant this saw nothing whenever the model used another product's vocabulary
 * (`old_string`/`new_string`, `file_path`) or `edit_file`'s batch form — and "nothing" was
 * recorded as an edit with empty before/after text. The reviewer was then handed a diff of
 * two empty strings and, having no changes to fault, reported the work correct and
 * complete. A reviewer that cannot see the change is worse than no reviewer at all.
 */
function recordChangeStart(sink: ChangeSink, raw: ToolCall): void {
	const call = normalizeToolCall(raw);
	if (call.name === 'write_file') {
		const path = asString(call.args.path);
		sink.changes.push(`Wrote \`${path}\`:\n\`\`\`\n${truncate(asString(call.args.content), 2000)}\n\`\`\``);
	}
	if (call.name === 'edit_file') {
		const path = asString(call.args.path);
		// `edits` is canonical after normalization; a single-edit call is the one-element case.
		const entries = Array.isArray(call.args.edits) ? call.args.edits : [call.args];
		const rendered = entries.map(entry => {
			const fields = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
			return `Replaced:\n\`\`\`\n${truncate(asString(fields.oldText), 1000)}\n\`\`\`\nWith:\n\`\`\`\n${truncate(asString(fields.newText), 1000)}\n\`\`\``;
		}).join('\n');
		const count = entries.length > 1 ? ` (${entries.length} edits)` : '';
		sink.changes.push(`Edited \`${path}\`${count}:\n${rendered}`);
	}
}

function recordChangeEnd(sink: ChangeSink, raw: ToolCall, result: string, _isError: boolean): void {
	const call = normalizeToolCall(raw);
	if (call.name === 'run_command') {
		// `commandTextOf` joins the list form the same way the executor does; `String(...)`
		// on an array renders `a,b`, which is not what ran.
		sink.changes.push(`Ran \`${commandTextOf(call.args)}\`\nOutput:\n${truncate(result, 1500)}`);
	}
}

/** The compact variant of a phase's system prompt, when the host supplied a compact base. */
function compactOf(params: AutoRunParams, phaseSystem: (base: string, compact: boolean) => string): string | undefined {
	return params.compactBaseSystemPrompt === undefined ? undefined : phaseSystem(params.compactBaseSystemPrompt, true);
}

function planSystem(base: string): string {
	return `${base}\n\nYou are the PLANNER in an automated plan→implement→review pipeline. ` +
		`Read the user's request and produce a clear, concise, numbered plan: the concrete steps, ` +
		`which files to touch, and any risks or unknowns. Do NOT write the full solution and do NOT ` +
		`call tools — output only the plan, as tightly as possible.`;
}

/**
 * The implementer's prompt: the same Agent-mode doctrine a plain Agent run gets — locate
 * before editing, never guess a path, verify before finishing — plus its role in the
 * pipeline. It used to get only the role line, so Auto's implementer ran with less guidance
 * than a plain Agent run on the same model, and was told writes need approval, which is
 * false under the default policy.
 */
function codeSystem(base: string, compact = false, thinking?: boolean): string {
	return `${base}\n\n${modeDoctrine('agent', { compact, thinking })}\n\n`
		+ 'You are the IMPLEMENTER in an automated plan → implement → review pipeline. A plan has already been prepared — follow it, '
		+ 'using your tools to make and verify the changes. When finished, briefly summarize what you changed.';
}

function reviewSystem(base: string): string {
	return `${base}\n\nYou are the REVIEWER in an automated plan→implement→review pipeline. You did NOT ` +
		`write this code. Critically review the implementation against the original request and plan: ` +
		`correctness, missed steps, bugs and risks. Be concise and specific. If it is correct and complete, ` +
		`say so plainly; otherwise list concrete issues and suggested fixes.`;
}
