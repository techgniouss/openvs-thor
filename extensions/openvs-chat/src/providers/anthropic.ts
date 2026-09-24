/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentRequest, AgentStep, ApiFetchOptions, ChatMessage, ChatProvider, ChatRequest, COMPLETION_FETCH_OPTS,
	FinishReason, ModelEntry, ProviderInfo, STREAM_FETCH_OPTS, StreamChatResult, ThinkingBlock, ToolCall, apiFetch,
	describeHttpError, normalizeFinishReason, readSSE, retryNotice,
} from './types';
import { RateLimitSnapshot, RateLimitTracker } from './rateLimits';
import { parseToolArgs } from './toolCalls';
import { CLOSE_MARK, OPEN_MARK } from '../persona/thinking';

const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';
/**
 * Lets a request say what happens when a replayed thinking block no longer matches the
 * conversation it was produced in. See {@link AnthropicProvider.buildBody}.
 */
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
/**
 * Subscription (Claude account) OAuth tokens are only served when the request
 * identifies as Anthropic's first-party CLI, which requires this exact text as the
 * first system block.
 */
const CLAUDE_CODE_SYSTEM = 'You are Claude Code, Anthropic\'s official CLI for Claude.';

/** Thinking budget requested from models that take one (Haiku 4.5 and older). */
const THINKING_BUDGET_TOKENS = 4_096;
/** The API's floor for a thinking budget. */
const MIN_THINKING_BUDGET = 1_024;
/** Reply left over after the budget; thinking tokens are charged against `max_tokens`. */
const MIN_ANSWER_TOKENS = 1_024;

/** `openvsChat.anthropic.thinking`: request extended thinking where a model supports it, or never. */
export type AnthropicThinkingMode = 'auto' | 'off';

/**
 * How a model takes extended thinking, from the Messages API's per-model rules:
 *  - `always`: thinking cannot be turned off (Fable, Mythos, Opus 5.5+); `{type: "disabled"}`
 *    and `budget_tokens` are both rejected, so "off" means omitting the parameter.
 *  - `default-on`: omitting `thinking` runs adaptive with the reasoning hidden (Opus 5, Sonnet 5).
 *  - `adaptive-display`: adaptive is the only on-mode and reasoning is hidden unless asked
 *    for with `display: "summarized"` (Opus 4.7/4.8).
 *  - `adaptive`: adaptive, summarized by default; `display` is not needed (Opus/Sonnet 4.6).
 *  - `budget`: `{type: "enabled", budget_tokens}` (Haiku 4.5, the 4.5-and-earlier Opus/Sonnet, 3.7).
 *  - `none`: no extended thinking.
 * Every adaptive-capable model rejects assistant prefill (HTTP 400), as does any request with
 * thinking on — see {@link AnthropicProvider.supportsPrefill}.
 */
type ThinkingStyle = 'always' | 'default-on' | 'adaptive-display' | 'adaptive' | 'budget' | 'none';

/** The {@link ThinkingStyle} of a model id. Unrecognized ids get `none`: no thinking is the safe request. */
export function thinkingStyle(model: string): ThinkingStyle {
	const m = model.toLowerCase();
	if (/claude-(fable|mythos)|claude-opus-5-[5-9]/.test(m)) {
		return 'always';
	}
	if (/claude-(opus|sonnet)-5/.test(m)) {
		return 'default-on';
	}
	if (/claude-(opus|sonnet)-4-[7-9]/.test(m)) {
		return 'adaptive-display';
	}
	if (/claude-(opus|sonnet)-4-6/.test(m)) {
		return 'adaptive';
	}
	if (/claude-3-7|claude-(opus|sonnet|haiku)-4(-[0-5])?(\b|-\d{8})/.test(m)) {
		return 'budget';
	}
	return 'none';
}

/** True when the credential came from the Claude web sign-in (not an API key). */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.startsWith('sk-ant-oat');
}

/** A request body's thinking choices; see {@link AnthropicProvider.buildBody}. */
interface ThinkingPlan {
	/** The `thinking` parameter, or undefined to omit it. */
	readonly param?: Record<string, unknown>;
	/** Replay the current tool round's thinking blocks. */
	readonly replay: boolean;
}

/**
 * Provider for the Anthropic Messages API (Claude). Anthropic differs from the
 * OpenAI shape: the system prompt is a top-level field, messages carry content
 * blocks, and tool calls arrive as `tool_use` blocks.
 */
export class AnthropicProvider implements ChatProvider {
	/**
	 * Anthropic states its allowances under its own header prefix
	 * (`anthropic-ratelimit-input-tokens-*`), which {@link parseRateLimitHeaders} reads
	 * alongside the `x-ratelimit-*` spelling. Recorded here for the same reason as
	 * everywhere else — a limit learned from a header costs nothing, a limit learned from a
	 * rejection costs a request.
	 */
	private readonly rateLimits = new RateLimitTracker();

	/**
	 * @param thinkingMode Reads `openvsChat.anthropic.thinking` on each request; injected so
	 * this module stays free of the host API (the registry wires the real setting).
	 */
	constructor(private readonly thinkingMode: () => AnthropicThinkingMode = () => 'auto') { }

	rateLimit(model: string): RateLimitSnapshot | undefined {
		return this.rateLimits.get(model);
	}

	readonly info: ProviderInfo = {
		id: 'anthropic',
		label: 'Anthropic (Claude)',
		suggestedModels: [
			'claude-fable-5',
			'claude-sonnet-5',
			'claude-opus-4-8',
			'claude-sonnet-4-5',
			'claude-haiku-4-5',
		],
		apiKeyUrl: 'https://console.anthropic.com/settings/keys',
		requiresApiKey: true,
		supportsTools: true,
		// Every Claude 3+ family model supports tool use (claude-3-*, claude-sonnet-4,
		// claude-opus-4-8, claude-fable-5, claude-mythos-5, future claude-*-6, ...).
		toolModelPatterns: ['claude-3', 'claude-[a-z]+-[4-9]', 'claude-[4-9]'],
		// Every Claude 3+ family model is multimodal.
		visionModelPatterns: ['claude-3', 'claude-[a-z]+-[4-9]', 'claude-[4-9]'],
		// Per model rather than provider-wide: see `supportsPrefill`.
		supportsAssistantPrefill: false,
		// Explicit breakpoints are sent on the system block and the last message block —
		// see `buildSystem` and `withCacheBreakpoint`.
		cachesPrompts: true,
	};

	/**
	 * Prefill (continuing a trailing assistant turn in place) only where the API accepts it:
	 * models older than the 4.6 family, with thinking off. It used to be declared for every
	 * model, so a reply cut off at `max_tokens` on any current Claude model failed its
	 * continuation with HTTP 400 instead of continuing.
	 */
	supportsPrefill(model: string): boolean {
		const style = thinkingStyle(model);
		return style === 'none' || (style === 'budget' && this.thinkingMode() === 'off');
	}

	private url(baseUrl: string, path: string): string {
		return `${baseUrl.replace(/\/+$/, '')}${path}`;
	}

	private headers(apiKey: string, betas: string[] = []): Record<string, string> {
		const oauth = isOAuthToken(apiKey);
		const beta = [...(oauth ? [OAUTH_BETA] : []), ...betas];
		return {
			'Content-Type': 'application/json',
			...(oauth ? { 'Authorization': `Bearer ${apiKey}` } : { 'x-api-key': apiKey }),
			'anthropic-version': ANTHROPIC_VERSION,
			...(beta.length ? { 'anthropic-beta': beta.join(',') } : {}),
		};
	}

	/** The thinking this request asks for, or none. See {@link ThinkingStyle}. */
	private thinkingParam(model: string, maxTokens: number): Record<string, unknown> | undefined {
		if (this.thinkingMode() === 'off') {
			return undefined;
		}
		switch (thinkingStyle(model)) {
			case 'always':
			case 'default-on':
			case 'adaptive-display':
				// Summarized, so the reasoning streams into the transcript instead of reading as
				// a long silent pause before the answer (these models default to hiding it).
				return { type: 'adaptive', display: 'summarized' };
			case 'adaptive':
				return { type: 'adaptive' };
			case 'budget': {
				const budget = Math.min(THINKING_BUDGET_TOKENS, maxTokens - MIN_ANSWER_TOKENS);
				return budget >= MIN_THINKING_BUDGET ? { type: 'enabled', budget_tokens: budget } : undefined;
			}
			default:
				return undefined;
		}
	}

	/**
	 * The request body, and the extra beta headers it needs.
	 *
	 * Thinking blocks are replayed for the current tool round only — the last assistant turn
	 * — which the API requires alongside its `tool_use`, and every earlier block is left out.
	 * Replaying all of them would not survive this harness: a thinking block's signature binds
	 * the conversation before it, and trimming, compaction and the compact-prompt switch all
	 * rewrite earlier turns, which on accounts created from 2026-08-31 turns a replayed block
	 * into a 400. Dropping a *leading* run of blocks is explicitly allowed.
	 *
	 * Against Anthropic's own endpoint the request also opts into `drop_block`, so a block an
	 * edit did invalidate is dropped instead of failing the step. Elsewhere (a proxy, a cloud
	 * platform without the control) a failure is retried without thinking — see
	 * {@link send}.
	 */
	private buildBody(
		request: ChatRequest | AgentRequest, plan: ThinkingPlan, stream: boolean, tools?: AgentRequest['tools'],
	): { body: string; betas: string[] } {
		const { system, messages } = splitSystem(request.messages);
		const firstParty = /^https:\/\/api\.anthropic\.com(\/|$)/.test(request.baseUrl);
		const replayAt = plan.replay ? replayIndex(messages) : -1;
		const bindingControls = !!plan.param && replayAt >= 0 && firstParty;
		const thinking = plan.param && bindingControls
			? { ...plan.param, block_binding: { prefix_mismatch_behavior: 'drop_block' } }
			: plan.param;
		const body: Record<string, unknown> = {
			model: request.model,
			max_tokens: request.maxTokens,
			system: buildSystem(system, isOAuthToken(request.apiKey)),
			messages: withCacheBreakpoint(toAnthropicMessages(messages, replayAt)),
			stream,
		};
		if (thinking) {
			body.thinking = thinking;
		}
		if (tools) {
			body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
		}
		return { body: JSON.stringify(body), betas: bindingControls ? [THINKING_BINDING_BETA] : [] };
	}

	/**
	 * Sends a request, retrying once without thinking when the backend refuses it over
	 * thinking: a replayed block it will not accept (an edited history on a platform without
	 * `drop_block`, a model switch mid-run), or a thinking setting a gateway does not
	 * support. Stripping the blocks is Anthropic's documented recovery; the model answers
	 * that step without the reasoning they carried rather than the step failing.
	 */
	private async send(
		request: ChatRequest | AgentRequest, stream: boolean, opts: ApiFetchOptions, tools?: AgentRequest['tools'],
	): Promise<Response> {
		const plan: ThinkingPlan = { param: this.thinkingParam(request.model, request.maxTokens), replay: true };
		const post = (p: ThinkingPlan) => {
			const { body, betas } = this.buildBody(request, p, stream, tools);
			return apiFetch(this.url(request.baseUrl, '/messages'), { method: 'POST', headers: this.headers(request.apiKey, betas), body }, request.signal, opts);
		};
		const response = await post(plan);
		const thinkingInPlay = !!plan.param || request.messages.some(m => m.thinkingBlocks?.length);
		if (response.ok || response.status !== 400 || !thinkingInPlay) {
			return response;
		}
		const text = await response.clone().text().catch(() => '');
		if (!/thinking|signature|block_binding/i.test(text)) {
			return response;
		}
		await response.body?.cancel().catch(() => { /* already closed */ });
		return post({ param: undefined, replay: false });
	}

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		// A completion must apply the same tight budget completeFim-style callers use — see
		// COMPLETION_FETCH_OPTS's doc comment — rather than the normal chat transport's 150s
		// timeout, extra retry and pace hook. No onRetry in that branch either: a completion
		// should not narrate a retry notice, since completions have no retries to narrate.
		const opts: ApiFetchOptions = request.isCompletion
			? { ...COMPLETION_FETCH_OPTS, ...this.rateLimits.noteOnlyOpts(request.model) }
			: {
				...STREAM_FETCH_OPTS,
				onRetry: info => request.onNotice?.(retryNotice(this.info.label, info)),
				...this.rateLimits.fetchOpts(request.model),
			};
		// A completion is a 96-token prediction: thinking would spend the whole reply on it.
		const response = request.isCompletion
			? await apiFetch(this.url(request.baseUrl, '/messages'), {
				method: 'POST',
				headers: this.headers(request.apiKey),
				body: this.buildBody(request, { replay: false }, true).body,
			}, request.signal, opts)
			: await this.send(request, true, opts);

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		const events = new StreamState(request.onToken);
		await readSSE(response, data => {
			// Parsing is the only thing guarded: a mid-stream `error` event must propagate,
			// not be mistaken for a malformed chunk and swallowed (which used to return the
			// partial answer as if it had completed normally).
			let json: any;
			try {
				json = JSON.parse(data);
			} catch {
				return;
			}
			events.handle(json, this.info.label);
		}, request.signal, { label: this.info.label, sawTerminal: () => events.finishReason !== undefined });
		events.close();
		if (events.finishReason === 'refused' && !events.text) {
			throw new Error(refusalMessage(this.info.label, events.refusalCategory));
		}
		return { truncated: events.finishReason === 'length', finishReason: events.finishReason };
	}

	async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const response = await apiFetch(this.url(baseUrl, '/models'), {
			method: 'GET',
			headers: this.headers(apiKey),
		}, signal);
		if (!response.ok) {
			// Subscription tokens are scoped to inference; if the models endpoint
			// rejects them, fall back to the known-good models rather than failing.
			if (isOAuthToken(apiKey) && (response.status === 401 || response.status === 403)) {
				return this.info.suggestedModels.map(id => ({ id }));
			}
			throw new Error(await describeHttpError(this.info.label, response));
		}
		const json = await response.json();
		// The catalog's `max_input_tokens` (1M on the current models) is deliberately not
		// reported as `contextLength`: every agent step re-sends the whole conversation, and
		// budgeting against 1M would let a run grow to ~800k tokens a request before compacting.
		// `contextWindowFor`'s 200k for Claude is the cost ceiling, not an error.
		const ids: string[] = (json?.data ?? [])
			.map((m: { id?: string }) => m?.id)
			.filter((id: unknown): id is string => typeof id === 'string');
		return ids.sort((a, b) => a.localeCompare(b)).map(id => ({ id }));
	}

	async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		const response = await this.send(request, true, {
			...STREAM_FETCH_OPTS,
			onRetry: info => request.onNotice?.(retryNotice(this.info.label, info)),
			...this.rateLimits.fetchOpts(request.model),
		}, request.tools);

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		const events = new StreamState(delta => request.onToken?.(delta));
		await readSSE(response, data => {
			let event: any;
			try {
				event = JSON.parse(data);
			} catch {
				return;
			}
			events.handle(event, this.info.label);
		}, request.signal, { label: this.info.label, sawTerminal: () => events.finishReason !== undefined });
		events.close();

		const toolCalls: ToolCall[] = events.blocksOf('tool_use')
			.map(b => ({ id: b.id ?? '', name: b.name ?? 'unknown', args: parseToolArgs(b.json) }));
		const thinkingBlocks: ThinkingBlock[] = events.blocks()
			.flatMap((b): ThinkingBlock[] => b.type === 'thinking'
				? [{ type: 'thinking', thinking: b.thinking, signature: b.signature }]
				: b.type === 'redacted_thinking' && b.data ? [{ type: 'redacted_thinking', data: b.data }] : []);
		return {
			content: events.text,
			toolCalls,
			truncated: events.finishReason === 'length',
			finishReason: events.finishReason,
			...(thinkingBlocks.length ? { thinkingBlocks } : {}),
		};
	}
}

/** One streamed content block, accumulated. */
interface StreamedBlock {
	type?: string;
	id?: string;
	name?: string;
	json: string;
	thinking: string;
	signature: string;
	data?: string;
}

/**
 * Accumulates one streamed Messages response: the answer text, tool calls, and thinking
 * blocks, with the reasoning streamed to `onToken` between the transcript's thinking marks.
 */
class StreamState {
	text = '';
	finishReason: FinishReason | undefined;
	refusalCategory: string | undefined;
	private readonly byIndex = new Map<number, StreamedBlock>();
	private reasoningOpen = false;

	constructor(private readonly onToken: (delta: string) => void) { }

	handle(event: any, label: string): void {
		if (event?.type === 'message_delta' && event?.delta?.stop_reason) {
			this.finishReason = normalizeFinishReason(event.delta.stop_reason);
			const category = event.delta.stop_details?.category ?? event.stop_details?.category;
			if (typeof category === 'string') {
				this.refusalCategory = category;
			}
		} else if (event?.type === 'content_block_start') {
			const cb = event.content_block ?? {};
			this.byIndex.set(event.index, {
				type: cb.type, id: cb.id, name: cb.name, json: '',
				thinking: typeof cb.thinking === 'string' ? cb.thinking : '',
				signature: typeof cb.signature === 'string' ? cb.signature : '',
				data: typeof cb.data === 'string' ? cb.data : undefined,
			});
		} else if (event?.type === 'content_block_delta') {
			const d = event.delta ?? {};
			const block = this.byIndex.get(event.index);
			if (d.type === 'text_delta' && typeof d.text === 'string') {
				this.closeReasoning();
				this.text += d.text;
				this.onToken(d.text);
			} else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
				if (block) {
					block.thinking += d.thinking;
				}
				if (d.thinking) {
					if (!this.reasoningOpen) {
						this.onToken(OPEN_MARK);
						this.reasoningOpen = true;
					}
					this.onToken(d.thinking);
				}
			} else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
				if (block) {
					block.signature += d.signature;
				}
			} else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
				if (block) {
					block.json += d.partial_json;
				}
			}
		} else if (event?.type === 'error') {
			throw new Error(`${label}: ${event?.error?.message ?? 'stream error'}`);
		}
	}

	/** Closes a reasoning section the stream ended inside. */
	close(): void {
		this.closeReasoning();
	}

	/** Every block, in stream order. */
	blocks(): StreamedBlock[] {
		return [...this.byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
	}

	blocksOf(type: string): StreamedBlock[] {
		return this.blocks().filter(b => b.type === type);
	}

	private closeReasoning(): void {
		if (this.reasoningOpen) {
			this.onToken(CLOSE_MARK);
			this.reasoningOpen = false;
		}
	}
}

/** What a refused request tells the user; the category is the API's own label for why. */
function refusalMessage(label: string, category: string | undefined): string {
	return `${label} declined this request${category ? ` (${category})` : ''}. Rephrase it, or switch models.`;
}

/**
 * Builds the top-level `system` field. OAuth (subscription) tokens require the
 * first-party CLI identity as the first block, with the real system prompt appended
 * as a second block; API keys skip that identity block. Always returns an array (never
 * a plain string) so the last block can carry a cache breakpoint.
 */
function buildSystem(system: string, oauth: boolean): ({ type: 'text'; text: string } & CacheControl)[] | undefined {
	const blocks: ({ type: 'text'; text: string } & CacheControl)[] = [];
	if (oauth) {
		blocks.push({ type: 'text', text: CLAUDE_CODE_SYSTEM });
	}
	if (system) {
		blocks.push({ type: 'text', text: system });
	}
	if (!blocks.length) {
		return undefined;
	}
	// One breakpoint after the system prompt: tools + system form a stable prefix
	// the API can serve from cache on every subsequent step of a run.
	blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
	return blocks;
}

function splitSystem(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
	const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
	return { system, messages: messages.filter(m => m.role !== 'system') };
}

/**
 * The index of the one assistant turn whose thinking blocks are replayed: the last assistant
 * turn, when it made tool calls and carries blocks — the tool round in progress. -1 for none.
 */
function replayIndex(messages: ChatMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'assistant') {
			return messages[i].toolCalls?.length && messages[i].thinkingBlocks?.length ? i : -1;
		}
	}
	return -1;
}

type CacheControl = { cache_control?: { type: 'ephemeral' } };
type AnthropicBlock = CacheControl & (
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string }
	| { type: 'thinking'; thinking: string; signature: string }
	| { type: 'redacted_thinking'; data: string });
type AnthropicMsg = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

/**
 * Maps internal messages (plain chat *and* tool calls/results) to Anthropic's block
 * format. Anthropic requires strictly alternating user/assistant turns starting with a
 * user turn, so this merges consecutive same-role messages into a single turn — without
 * this, an attached-context user message followed by a history user message would be two
 * consecutive `user` turns and the API would reject the request (HTTP 400).
 *
 * `replayAt` names the one assistant turn whose thinking blocks go back, verbatim and ahead
 * of its text and tool calls as the API requires. See {@link replayIndex}.
 */
function toAnthropicMessages(messages: ChatMessage[], replayAt = -1): AnthropicMsg[] {
	const out: AnthropicMsg[] = [];
	const append = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
		if (!blocks.length) {
			return;
		}
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.content.push(...blocks);
		} else {
			out.push({ role, content: blocks });
		}
	};

	messages.forEach((m, index) => {
		if (m.role === 'tool') {
			append('user', [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }]);
		} else if (m.role === 'assistant' && m.toolCalls?.length) {
			const blocks: AnthropicBlock[] = index === replayAt
				? (m.thinkingBlocks ?? []).map((b): AnthropicBlock => b.type === 'thinking'
					? { type: 'thinking', thinking: b.thinking, signature: b.signature }
					: { type: 'redacted_thinking', data: b.data })
				: [];
			if (m.content) {
				blocks.push({ type: 'text', text: m.content });
			}
			for (const tc of m.toolCalls) {
				blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
			}
			append('assistant', blocks);
		} else if (m.content || m.images?.length) {
			const blocks: AnthropicBlock[] = (m.images ?? []).map(img => ({
				type: 'image',
				source: { type: 'base64', media_type: img.mimeType, data: img.data },
			}));
			if (m.content) {
				blocks.push({ type: 'text', text: m.content });
			}
			append(m.role === 'assistant' ? 'assistant' : 'user', blocks);
		}
	});

	// Anthropic requires the first turn to be from the user.
	if (out.length && out[0].role === 'assistant') {
		out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
	}
	return out;
}

/**
 * Marks the final content block as a cache breakpoint, so the whole conversation up
 * to this request is a cache hit on the next step (the API caches the longest
 * previously-seen prefix; the moving breakpoint extends it step by step). Thinking blocks
 * cannot carry one, so it lands on the last block that can.
 */
function withCacheBreakpoint(msgs: AnthropicMsg[]): AnthropicMsg[] {
	const last = msgs[msgs.length - 1];
	const block = last?.content.slice().reverse().find(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
	if (block) {
		block.cache_control = { type: 'ephemeral' };
	}
	return msgs;
}
