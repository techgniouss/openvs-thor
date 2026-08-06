/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentRequest, AgentStep, ApiFetchOptions, ChatMessage, ChatProvider, ChatRequest, FinishReason,
	ModelEntry, ProviderInfo, RetryInfo, STREAM_FETCH_OPTS, StreamChatResult, ToolCall, apiFetch,
	describeHttpError, normalizeFinishReason, readSSE, retryNotice,
} from './types';
import { normalizeToolCallId, parseToolArgs } from './toolCalls';
import { RateLimitSnapshot, RateLimitTracker } from './rateLimits';
import { CLOSE_MARK, OPEN_MARK } from '../persona/thinking';

/**
 * How an assistant turn that carries both narration and tool calls is put on the wire.
 * `inline` is the OpenAI shape; `split` emits the narration as its own assistant turn
 * immediately before the tool-call turn; `drop` discards it (last resort — see
 * {@link OpenAICompatibleProvider.postWithNarrationFallback}).
 */
type NarrationMode = 'inline' | 'split' | 'drop';

/**
 * A 400 complaining about the *shape* of the message list rather than its contents — the
 * signature of a backend that will not take two consecutive assistant turns.
 *
 * Deliberately loose. A false positive costs one extra request that fails the same way and
 * surfaces the same error, because the retry only removes narration; a false negative would
 * leave the session permanently unable to make a request the backend would have accepted.
 */
const MESSAGE_SHAPE_REJECTION =
	/assistant|consecutive|alternat|message.*(order|sequence|role)|role.*(order|sequence)/i;

/**
 * Base implementation for any backend that speaks the OpenAI Chat Completions API
 * (OpenAI itself, NVIDIA's `integrate.api.nvidia.com`, local gateways, etc.).
 * Subclasses only need to supply `info`.
 */
export abstract class OpenAICompatibleProvider implements ChatProvider {
	abstract readonly info: ProviderInfo;

	/** Extra request body fields (e.g. sampling defaults). Overridable by subclasses. */
	protected extraBody(): Record<string, unknown> {
		return {};
	}

	/** Extra request headers (e.g. OpenRouter's app attribution). Overridable by subclasses. */
	protected extraHeaders(): Record<string, string> {
		return {};
	}

	/**
	 * Whether `model` needs EXPLICIT `cache_control` breakpoints to have its prompt prefix
	 * cached. False for backends that cache automatically (OpenAI) and for those that don't
	 * cache at all; true only where the gateway forwards breakpoints to an upstream that
	 * requires them — Anthropic and Gemini models behind OpenRouter, notably.
	 */
	protected wantsCacheBreakpoints(_model: string): boolean {
		return false;
	}

	/**
	 * Whether the backend accepts an assistant history turn that carries BOTH `content`
	 * and `tool_calls`. OpenAI does; some gateways (notably NVIDIA) reject the combination
	 * with HTTP 400 ("Assistant message must have either content or tool_calls, but not
	 * both"). Those override this to false, and the narration is split into its own
	 * assistant turn ahead of the tool calls rather than thrown away — see
	 * {@link NarrationMode}.
	 */
	protected allowsContentWithToolCalls(): boolean {
		return true;
	}

	/**
	 * Rewrites a tool-call id on its way to the wire, applied to the assistant turn's
	 * `tool_calls[].id` and the matching `tool` turn's `tool_call_id` from one place so the
	 * two can never disagree.
	 *
	 * Keyed off the *model* by default rather than the provider, because the constraint that
	 * forces this — Mistral's `^[a-zA-Z0-9]{9}$` — follows the Mistral family across every
	 * gateway that serves it (OpenRouter, NVIDIA, Cloudflare, a `custom` endpoint), not just
	 * Mistral's own API. See {@link normalizeToolCallId}.
	 */
	protected toolCallId(id: string, model: string): string {
		return normalizeToolCallId(id, model);
	}

	/**
	 * Set once a backend has rejected the split narration turn, so the rest of the session
	 * drops narration instead of re-failing every request. Per-instance because providers
	 * are long-lived singletons in the registry — one probe per session, not per call.
	 */
	private narrationSplitRejected = false;

	/** How an assistant turn carrying both narration and tool calls is serialized. */
	private narrationMode(): NarrationMode {
		if (this.allowsContentWithToolCalls()) {
			return 'inline';
		}
		return this.narrationSplitRejected ? 'drop' : 'split';
	}

	/**
	 * Sends `body` (a function of the narration mode, since the mode changes the messages),
	 * falling back to dropping narration if the backend rejects the split form.
	 *
	 * Splitting is the better history by a wide margin — dropping narration leaves the
	 * model a transcript of its own tool calls with no record of *why* it made any of them,
	 * so it re-derives its plan every single step and re-reads files it already read. But
	 * whether a given gateway accepts two consecutive assistant turns can only be learned
	 * from the gateway, so the first rejection demotes the session to `drop` and retries
	 * rather than failing the step.
	 */
	private async postWithNarrationFallback(
		url: string,
		headers: Record<string, string>,
		body: (mode: NarrationMode) => string,
		signal: AbortSignal,
		opts: ApiFetchOptions,
	): Promise<Response> {
		const mode = this.narrationMode();
		const response = await apiFetch(url, { method: 'POST', headers, body: body(mode) }, signal, opts);
		if (response.ok || mode !== 'split' || response.status !== 400) {
			return response;
		}
		// Cloned, not consumed: a 400 about anything else has to reach the caller with its
		// body intact so `describeHttpError` can quote what the backend actually said.
		const text = await response.clone().text().catch(() => '');
		if (!MESSAGE_SHAPE_REJECTION.test(text)) {
			return response;
		}
		this.narrationSplitRejected = true;
		// The rejected response is abandoned here, and an unread body holds its socket open.
		await response.body?.cancel().catch(() => { /* already closed */ });
		return apiFetch(url, { method: 'POST', headers, body: body('drop') }, signal, opts);
	}

	protected url(baseUrl: string, path: string): string {
		return `${baseUrl.replace(/\/+$/, '')}${path}`;
	}

	protected authHeaders(apiKey: string): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		// Keyless local endpoints (Ollama, LM Studio, …) don't want an Authorization
		// header at all; providers that require a key are gated before reaching here.
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		return { ...headers, ...this.extraHeaders() };
	}

	/**
	 * Fetch options for a streaming POST, augmented with an `onRetry` hook that reports a
	 * short, transient notice (rate limit / slow start) so an auto-retry doesn't look like
	 * a silent hang. 429 gets its own patient budget inside {@link apiFetch}.
	 */
	private streamFetchOpts(model: string, onNotice?: (text: string) => void): ApiFetchOptions {
		return {
			...STREAM_FETCH_OPTS,
			onRetry: (info: RetryInfo) => onNotice?.(retryNotice(this.info.label, info)),
			...this.rateLimits.fetchOpts(model),
		};
	}

	/**
	 * What this backend has said about its own token allowances, per model.
	 *
	 * Held on the provider because providers are long-lived singletons in the registry, so
	 * one run's reading is available to the next — the allowance belongs to the account and
	 * the model, not to a conversation.
	 */
	protected readonly rateLimits = new RateLimitTracker();

	rateLimit(model: string): RateLimitSnapshot | undefined {
		return this.rateLimits.get(model);
	}

	/**
	 * Which field caps the reply for this model. OpenAI's reasoning models (o-series,
	 * gpt-5) reject the legacy `max_tokens` outright with HTTP 400.
	 */
	protected tokenLimitField(model: string): string {
		return /^(o[1-9]|gpt-5)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
	}

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		const response = await this.postWithNarrationFallback(
			this.url(request.baseUrl, '/chat/completions'),
			{ ...this.authHeaders(request.apiKey), 'Accept': 'text/event-stream' },
			mode => JSON.stringify({
				model: request.model,
				messages: serializeMessages(request.messages, mode, this.wantsCacheBreakpoints(request.model), id => this.toolCallId(id, request.model)),
				[this.tokenLimitField(request.model)]: request.maxTokens,
				stream: true,
				...this.extraBody(),
			}),
			request.signal,
			this.streamFetchOpts(request.model, request.onNotice),
		);

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		// Reasoning models (DeepSeek-R1, QwQ, some Nemotrons) stream their chain of
		// thought as `reasoning_content` before any `content`. Dropping it made those
		// models look dead for minutes; surface it, separated from the final answer.
		let phase: 'idle' | 'reasoning' | 'answer' = 'idle';
		let truncated = false;
		let finishReason: FinishReason | undefined;
		await readSSE(response, data => {
			try {
				const json = JSON.parse(data);
				throwStreamError(this.info.label, json);
				const raw = json?.choices?.[0]?.finish_reason;
				if (raw) {
					finishReason = normalizeFinishReason(raw);
					truncated = finishReason === 'length';
				}
				const delta = json?.choices?.[0]?.delta;
				const reasoning = reasoningDelta(delta);
				if (reasoning) {
					if (phase === 'idle') {
						request.onToken(OPEN_MARK);
						phase = 'reasoning';
					}
					request.onToken(reasoning);
				}
				const content: string | undefined = delta?.content;
				if (typeof content === 'string' && content) {
					if (phase === 'reasoning') {
						request.onToken(CLOSE_MARK);
					}
					phase = 'answer';
					request.onToken(content);
				}
			} catch {
				// Skip malformed chunks.
			}
		}, request.signal, { label: this.info.label, sawTerminal: () => finishReason !== undefined });
		return { truncated, finishReason };
	}

	async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const response = await apiFetch(this.url(baseUrl, '/models'), {
			method: 'GET',
			headers: this.authHeaders(apiKey),
		}, signal);
		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}
		const json = await response.json();
		const ids: string[] = (json?.data ?? [])
			.map((m: { id?: string }) => m?.id)
			.filter((id: unknown): id is string => typeof id === 'string');
		return ids.sort((a, b) => a.localeCompare(b)).map(id => ({ id }));
	}

	async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		const response = await this.postWithNarrationFallback(
			this.url(request.baseUrl, '/chat/completions'),
			{ ...this.authHeaders(request.apiKey), 'Accept': 'text/event-stream' },
			mode => JSON.stringify({
				model: request.model,
				messages: serializeMessages(request.messages, mode, this.wantsCacheBreakpoints(request.model), id => this.toolCallId(id, request.model)),
				[this.tokenLimitField(request.model)]: request.maxTokens,
				tools: request.tools.map(t => ({
					type: 'function',
					function: { name: t.name, description: t.description, parameters: t.parameters },
				})),
				tool_choice: 'auto',
				stream: true,
				...this.extraBody(),
			}),
			request.signal,
			this.streamFetchOpts(request.model, request.onNotice),
		);

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		// Accumulate the streamed assistant turn: text deltas plus tool-call fragments
		// (OpenAI streams tool_calls piece-by-piece, keyed by index).
		let content = '';
		let reasoning = '';
		let truncated = false;
		let finishReason: FinishReason | undefined;
		const acc = new Map<number, { id?: string; name?: string; args: string }>();
		await readSSE(response, data => {
			let json: any;
			try {
				json = JSON.parse(data);
			} catch {
				return;
			}
			throwStreamError(this.info.label, json);
			const raw = json?.choices?.[0]?.finish_reason;
			if (raw) {
				finishReason = normalizeFinishReason(raw);
				truncated = finishReason === 'length';
			}
			const delta = json?.choices?.[0]?.delta;
			if (!delta) {
				return;
			}
			// Stream reasoning for visibility, but keep it out of the recorded turn.
			const thought = reasoningDelta(delta);
			if (thought) {
				if (!reasoning) {
					request.onToken?.(OPEN_MARK);
				}
				reasoning += thought;
				request.onToken?.(thought);
			}
			if (typeof delta.content === 'string' && delta.content) {
				if (reasoning && !content) {
					request.onToken?.(CLOSE_MARK);
				}
				content += delta.content;
				request.onToken?.(delta.content);
			}
			for (const tc of delta.tool_calls ?? []) {
				const index: number = typeof tc.index === 'number' ? tc.index : 0;
				const cur = acc.get(index) ?? { args: '' };
				if (tc.id) { cur.id = tc.id; }
				if (tc.function?.name) { cur.name = tc.function.name; }
				if (typeof tc.function?.arguments === 'string') { cur.args += tc.function.arguments; }
				acc.set(index, cur);
			}
		}, request.signal, { label: this.info.label, sawTerminal: () => finishReason !== undefined });

		const toolCalls: ToolCall[] = [...acc.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([index, tc]) => {
				return { id: tc.id ?? `call_${index}`, name: tc.name ?? 'unknown', args: parseToolArgs(tc.args) };
			});
		// A reasoning model that produced no answer and no tool calls would otherwise
		// yield an empty step; fall back to its reasoning so the agent loop can react.
		return { content: content || (toolCalls.length ? '' : reasoning), toolCalls, truncated, finishReason };
	}
}

/**
 * Raises a backend's in-band stream error, which arrives on an HTTP **200**.
 *
 * Several OpenAI-compatible backends (NVIDIA NIM and other vLLM-based gateways in
 * particular) answer a failure by opening the stream normally and then sending the error as
 * an SSE event. Every such event was silently skipped here — it matches no `choices` shape —
 * so the request completed with no content at all, and the agent loop reported "the model
 * returned an empty reply" four times before giving up. The reason the provider gave was
 * sitting in the stream the whole time. The Anthropic client has always raised these; this
 * is the same rule for every other backend.
 */
function throwStreamError(label: string, json: unknown): void {
	if (!json || typeof json !== 'object') {
		return;
	}
	const payload = json as { error?: unknown; object?: unknown; message?: unknown };
	const error = payload.error;
	const message = typeof error === 'string'
		? error
		: typeof (error as { message?: unknown })?.message === 'string'
			? (error as { message: string }).message
			// vLLM-style: `{ object: 'error', message: '...' }` with no nested error object.
			: payload.object === 'error' && typeof payload.message === 'string' ? payload.message : undefined;
	if (error !== undefined || payload.object === 'error') {
		throw new Error(`${label}: ${message || 'the provider reported an error mid-stream.'}`);
	}
}

/**
 * The chain-of-thought fragment in one streamed delta, whatever the backend calls it.
 *
 * There is no standard here and the difference is not cosmetic: DeepSeek-style backends
 * send `reasoning_content`, while **Groq and OpenRouter send `reasoning`** — and a
 * reasoning model that spends a whole turn thinking (gpt-oss, Nemotron, GLM) returns no
 * `content` and no tool calls on that turn. Reading only one spelling made those turns
 * arrive as *empty* replies, so the agent loop nudged, got another one, and after four
 * gave up on a run the model was in the middle of doing correctly.
 *
 * Some gateways wrap it in an object rather than sending a bare string, so both shapes
 * are accepted; anything else is ignored rather than stringified into the transcript.
 */
function reasoningDelta(delta: Record<string, unknown> | undefined): string {
	for (const key of ['reasoning_content', 'reasoning']) {
		const value = delta?.[key];
		if (typeof value === 'string' && value) {
			return value;
		}
		if (value && typeof value === 'object') {
			const nested = (value as { content?: unknown; text?: unknown }).content
				?? (value as { text?: unknown }).text;
			if (typeof nested === 'string' && nested) {
				return nested;
			}
		}
	}
	return '';
}

/** Serializes the conversation into the OpenAI Chat Completions wire format. */
function serializeMessages(
	messages: ChatMessage[],
	mode: NarrationMode,
	breakpoints = false,
	toolCallId: (id: string) => string = id => id,
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const m of messages) {
		// `split` puts the narration in its own turn ahead of the tool calls. The model's
		// account of what it was doing is the most valuable thing in an agent transcript —
		// without it every step starts from the tool log alone.
		if (mode === 'split' && m.role === 'assistant' && m.toolCalls?.length && m.content.trim()) {
			out.push({ role: 'assistant', content: m.content });
		}
		out.push(serializeMessage(m, mode === 'inline', toolCallId));
	}
	return breakpoints ? withCacheBreakpoints(out) : out;
}

/**
 * Marks the system turn and the last text-carrying turn as cache breakpoints, in the
 * OpenAI-shaped form gateways forward to Anthropic/Gemini (`content` becomes an array of
 * parts, the marked part carries `cache_control`).
 *
 * Two, in the same places the native Anthropic client puts them: one fixes the system
 * prompt and tools, which never change during a run; the other moves to the end of the
 * conversation each step, so the cache extends to cover everything the previous step had.
 * Without these an agent run against `anthropic/claude-*` through a gateway re-reads the
 * entire conversation at full price on every step — the same defect the native client
 * fixed years ago, reintroduced by the change of route.
 */
function withCacheBreakpoints(messages: Record<string, unknown>[]): Record<string, unknown>[] {
	const mark = (index: number) => {
		const message = messages[index];
		const text = message.content;
		if (typeof text !== 'string' || !text) {
			return false;
		}
		messages[index] = { ...message, content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] };
		return true;
	};
	const system = messages.findIndex(m => m.role === 'system');
	if (system >= 0) {
		mark(system);
	}
	// Walks back from the end: the final turn is often a tool result or a tool-call turn,
	// neither of which carries the plain string content this form needs.
	for (let i = messages.length - 1; i > system; i--) {
		if (mark(i)) {
			break;
		}
	}
	return messages;
}

/** Serializes an internal message into the OpenAI Chat Completions wire format. */
function serializeMessage(
	m: ChatMessage,
	contentWithToolCalls: boolean,
	toolCallId: (id: string) => string,
): Record<string, unknown> {
	if (m.role === 'assistant' && m.toolCalls?.length) {
		return {
			role: 'assistant',
			content: contentWithToolCalls ? (m.content || null) : null,
			tool_calls: m.toolCalls.map(tc => ({
				id: toolCallId(tc.id),
				type: 'function',
				function: { name: tc.name, arguments: JSON.stringify(tc.args) },
			})),
		};
	}
	if (m.role === 'tool') {
		// Left undefined (and so omitted by JSON.stringify) when the turn carries no id, as
		// before — rewriting an absent id into an empty string would be a new, invalid field.
		const id = m.toolCallId === undefined ? undefined : toolCallId(m.toolCallId);
		return { role: 'tool', tool_call_id: id, content: m.content };
	}
	if (m.images?.length) {
		const parts: Record<string, unknown>[] = [];
		if (m.content) {
			parts.push({ type: 'text', text: m.content });
		}
		for (const img of m.images) {
			parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
		}
		return { role: m.role, content: parts };
	}
	return { role: m.role, content: m.content };
}
