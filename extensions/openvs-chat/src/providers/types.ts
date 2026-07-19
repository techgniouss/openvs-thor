/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single tool/function call requested by the model. */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/** A single image attached to a user message, already downscaled/re-encoded client-side. */
export interface ChatImage {
	readonly mimeType: string;
	/** Base64-encoded image data, without the `data:...;base64,` prefix. */
	readonly data: string;
}

/**
 * A message in a conversation. `images` is only present on user turns with an
 * attachment; `toolCalls` is only present on assistant turns that invoke tools;
 * `toolCallId` is only present on `tool` result turns.
 */
export interface ChatMessage {
	readonly role: ChatRole;
	readonly content: string;
	readonly images?: ChatImage[];
	readonly toolCalls?: ToolCall[];
	readonly toolCallId?: string;
}

/** A model id plus optional capability/pricing metadata from the provider's catalog. */
export interface ModelEntry {
	readonly id: string;
	/** True when the provider serves this model at no cost (free tier / `:free` variant). */
	readonly free?: boolean;
	/**
	 * Authoritative tool-calling capability reported by the provider's catalog. When
	 * present it overrides the heuristic `toolModelPatterns` matching; when absent the
	 * patterns decide.
	 */
	readonly toolCapable?: boolean;
}

/** JSON-schema description of a tool the model may call (Agent mode). */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
}

export interface ChatRequest {
	readonly messages: ChatMessage[];
	readonly model: string;
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly maxTokens: number;
	readonly signal: AbortSignal;
	/** Called with each streamed text fragment. */
	readonly onToken: (delta: string) => void;
}

/** An agent step: ask the model what to do next (text and/or tool calls). */
export interface AgentRequest {
	readonly messages: ChatMessage[];
	readonly tools: ToolSpec[];
	readonly model: string;
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly maxTokens: number;
	readonly signal: AbortSignal;
	/** Called with streamed narration text as the step is produced (optional). */
	readonly onToken?: (delta: string) => void;
}

/** The model's response to a single agent step. */
export interface AgentStep {
	readonly content: string;
	readonly toolCalls: ToolCall[];
	/** True when the step was cut off by the max-token limit before the model finished. */
	readonly truncated?: boolean;
}

/** The outcome of a completed {@link ChatProvider.streamChat} call. */
export interface StreamChatResult {
	/**
	 * True when the response was cut off by the max-token limit (`finish_reason:
	 * "length"` / `stop_reason: "max_tokens"`) rather than finishing naturally.
	 */
	readonly truncated: boolean;
}

export interface ProviderInfo {
	readonly id: string;
	readonly label: string;
	/** Suggested model identifiers shown in the picker. The user can type any model. */
	readonly suggestedModels: string[];
	/** Where the user can obtain an API key. */
	readonly apiKeyUrl: string;
	/** Whether an API key is strictly required to call the provider. */
	readonly requiresApiKey: boolean;
	/** Whether the provider can do tool calling at all (Agent mode). */
	readonly supportsTools: boolean;
	/**
	 * Case-insensitive regex sources; a model is considered tool-capable (and thus
	 * usable in Agent mode) if its id matches any pattern. An empty list means every
	 * model from this provider supports tools.
	 */
	readonly toolModelPatterns: string[];
	/**
	 * Case-insensitive regex sources; a model is considered vision-capable (and thus
	 * able to receive image attachments) if its id matches any pattern. An empty list
	 * means every model from this provider is assumed to support image input — used for
	 * providers that proxy arbitrary/OSS backends (NVIDIA, generic OpenAI-compatible)
	 * where we can't enumerate vision-capable models in advance.
	 */
	readonly visionModelPatterns: string[];
	/**
	 * True when the backend continues a trailing assistant turn in place (Anthropic's
	 * prefill). Lets {@link streamChatWithContinuation} resume a cut-off response
	 * seamlessly instead of asking for a continuation in a new user turn.
	 */
	readonly supportsAssistantPrefill?: boolean;
}

/**
 * Whether a specific model can be used in Agent mode. Kept as a small pure helper
 * so the same rule can be mirrored in the webview (see `modelSupportsTools` in main.js).
 */
export function modelSupportsTools(info: ProviderInfo, model: string): boolean {
	if (!info.supportsTools) {
		return false;
	}
	if (!info.toolModelPatterns.length) {
		return true;
	}
	return info.toolModelPatterns.some(pattern => {
		try {
			return new RegExp(pattern, 'i').test(model);
		} catch {
			return false;
		}
	});
}

/**
 * Whether a specific model can be used in Agent mode, preferring the provider
 * catalog's own capability report (when the model list has been fetched) over the
 * heuristic patterns. Mirrored in the webview (see `modelSupportsTools` in main.js).
 */
export function entrySupportsTools(info: ProviderInfo, entries: ModelEntry[] | undefined, model: string): boolean {
	const entry = entries?.find(e => e.id === model);
	if (entry && typeof entry.toolCapable === 'boolean') {
		return info.supportsTools && entry.toolCapable;
	}
	return modelSupportsTools(info, model);
}

/**
 * Whether a specific model can accept image attachments. Kept as a small pure helper
 * so the same rule can be mirrored in the webview (see `modelSupportsVision` in main.js).
 */
export function modelSupportsVision(info: ProviderInfo, model: string): boolean {
	if (!info.visionModelPatterns.length) {
		return true;
	}
	return info.visionModelPatterns.some(pattern => {
		try {
			return new RegExp(pattern, 'i').test(model);
		} catch {
			return false;
		}
	});
}

/**
 * How many automatic continuation rounds {@link streamChatWithContinuation} will run
 * after a max-token cutoff before giving up. Each round gets a full `maxTokens` budget,
 * so even a very large file comfortably completes within this cap.
 */
const MAX_CONTINUATION_ROUNDS = 8;

/**
 * Injected as a user turn to resume a response that hit the max-token limit, for
 * backends without assistant prefill. Worded to prevent the two classic continuation
 * artifacts: re-sending earlier content and re-opening a fresh code fence.
 */
export const CONTINUE_PROMPT =
	'Your previous message was cut off mid-response by the output token limit. ' +
	'Continue EXACTLY where it stopped: output only the continuation, without repeating ' +
	'any earlier content and without any preamble or apology. If it stopped inside a ' +
	'fenced code block, continue the code directly — do not open a new fence.';

/**
 * Streams a chat completion and, whenever the provider reports a max-token cutoff,
 * transparently requests a continuation and keeps streaming — so long responses (big
 * code blocks, whole files) arrive as one seamless message instead of stopping midway.
 * Uses assistant prefill when the backend supports it (Anthropic), otherwise replays
 * the partial answer as an assistant turn followed by {@link CONTINUE_PROMPT}.
 * Returns the full accumulated text and whether it is still truncated after the
 * round budget was exhausted.
 */
export async function streamChatWithContinuation(
	provider: ChatProvider,
	request: ChatRequest,
): Promise<{ text: string; truncated: boolean }> {
	let full = '';
	let messages = request.messages;
	for (let round = 0; ; round++) {
		let chunk = '';
		const result = await provider.streamChat({
			...request,
			messages,
			onToken: delta => { chunk += delta; request.onToken(delta); },
		});
		full += chunk;
		const truncated = !!result?.truncated;
		// An empty chunk means the model made no progress; bail rather than loop.
		if (!truncated || !chunk || round >= MAX_CONTINUATION_ROUNDS) {
			return { text: full, truncated };
		}
		if (provider.info.supportsAssistantPrefill) {
			// A trailing assistant turn is continued in place. Trailing whitespace must be
			// stripped — Anthropic rejects prefill content that ends with it (HTTP 400).
			messages = [...request.messages, { role: 'assistant', content: full.replace(/\s+$/, '') }];
		} else {
			messages = [
				...request.messages,
				{ role: 'assistant', content: full },
				{ role: 'user', content: CONTINUE_PROMPT },
			];
		}
	}
}

/**
 * A chat provider knows how to stream a completion from a specific backend.
 * Implementations must be self-contained and only use the global `fetch`.
 */
export interface ChatProvider {
	readonly info: ProviderInfo;
	/**
	 * Stream a chat completion. Resolves when the stream completes, rejects on error
	 * (including abort, which throws a DOMException named 'AbortError'). Providers
	 * that can detect a max-token cutoff resolve with a {@link StreamChatResult};
	 * resolving with nothing means "assume the response finished naturally".
	 */
	streamChat(request: ChatRequest): Promise<StreamChatResult | void>;
	/** List the models available for the given key (id + metadata), for the model dropdown. */
	listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]>;
	/** Run one agent step with tools. Only meaningful when `info.supportsTools` is true. */
	runAgentStep?(request: AgentRequest): Promise<AgentStep>;
}

/**
 * Reads a `text/event-stream` (SSE) HTTP response body line by line and invokes
 * `onEvent` with each `data:` payload (excluding the trailing `[DONE]` sentinel).
 */
export async function readSSE(
	response: Response,
	onEvent: (data: string) => void,
	signal: AbortSignal,
): Promise<void> {
	if (!response.body) {
		throw new Error('Response had no body to stream.');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			if (signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line.startsWith('data:')) {
					continue;
				}
				const data = line.slice('data:'.length).trim();
				if (data === '[DONE]' || data.length === 0) {
					continue;
				}
				onEvent(data);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Why an {@link apiFetch} attempt is being retried, passed to {@link ApiFetchOptions.onRetry}. */
export interface RetryInfo {
	/** Zero-based index of the retry about to happen (0 = first retry). */
	readonly attempt: number;
	/** How long the client will wait before the retry, in ms. */
	readonly delayMs: number;
	readonly reason: 'rate-limit' | 'server' | 'network' | 'timeout';
	/** HTTP status that triggered the retry, when the failure was an HTTP response. */
	readonly status?: number;
}

/** Options controlling {@link apiFetch}'s timeout and retry behaviour. */
export interface ApiFetchOptions {
	/** Abort if no response headers arrive within this many ms (default 60s). */
	readonly timeoutMs?: number;
	/** Number of automatic retries on timeout / network error / 5xx (default 2). */
	readonly retries?: number;
	/**
	 * Called just before each automatic retry so callers can surface "retrying in Ns…"
	 * feedback to the user. Never called for a caller-initiated abort.
	 */
	readonly onRetry?: (info: RetryInfo) => void;
}

/** Links a caller's AbortSignal to a child controller, returning an unlink function. */
function linkAbort(caller: AbortSignal, child: AbortController): () => void {
	if (caller.aborted) {
		child.abort();
		return () => { /* nothing to unlink */ };
	}
	const onAbort = () => child.abort();
	caller.addEventListener('abort', onAbort);
	return () => caller.removeEventListener('abort', onAbort);
}

function backoffMs(attempt: number, response?: Response): number {
	const retryAfter = response?.headers.get('retry-after');
	if (retryAfter) {
		const seconds = Number(retryAfter);
		// Free tiers legitimately ask for 20-30s waits when a model is saturated; honor the
		// server's own hint (capped at 30s so a hostile header can't stall us indefinitely).
		if (!Number.isNaN(seconds)) {
			return Math.min(seconds * 1000, 30_000);
		}
	}
	return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * How many times HTTP 429 (rate limited / free-tier quota) is retried, independent of the
 * general {@link ApiFetchOptions.retries} budget: a rate limit clears on its own if we wait,
 * so it's worth being more patient about than a network error or a queued-request timeout.
 */
const RATE_LIMIT_RETRIES = 4;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * `fetch` with a connection timeout and automatic retry/backoff. The timeout applies to
 * receiving response *headers* (so it doesn't cut off a long, healthy stream). Transient
 * failures are retried with exponential backoff, honouring a `Retry-After` header when
 * present, and `onRetry` is invoked before each wait. HTTP 429 gets its own, more patient
 * retry budget ({@link RATE_LIMIT_RETRIES}) than network/timeout/5xx failures, since a rate
 * limit reliably clears if we simply wait it out. A caller abort is never retried.
 */
export async function apiFetch(
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	opts?: ApiFetchOptions,
): Promise<Response> {
	const retries = opts?.retries ?? 2;
	const rateLimitRetries = Math.max(retries, RATE_LIMIT_RETRIES);
	const timeoutMs = opts?.timeoutMs ?? 60_000;
	let lastError: unknown;
	// Tracked separately so a run of 429s doesn't burn the (often smaller) network budget.
	let networkAttempts = 0;
	let rateLimitAttempts = 0;

	for (; ;) {
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		const controller = new AbortController();
		const unlink = linkAbort(signal, controller);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
		try {
			const response = await fetch(url, { ...init, signal: controller.signal });
			clearTimeout(timer);
			unlink();
			if (response.status === 429 && rateLimitAttempts < rateLimitRetries) {
				const delayMs = backoffMs(rateLimitAttempts, response);
				opts?.onRetry?.({ attempt: rateLimitAttempts, delayMs, reason: 'rate-limit', status: 429 });
				rateLimitAttempts++;
				await sleep(delayMs);
				continue;
			}
			if (response.status >= 500 && networkAttempts < retries) {
				const delayMs = backoffMs(networkAttempts, response);
				opts?.onRetry?.({ attempt: networkAttempts, delayMs, reason: 'server', status: response.status });
				networkAttempts++;
				await sleep(delayMs);
				continue;
			}
			return response;
		} catch (err) {
			clearTimeout(timer);
			unlink();
			if (signal.aborted && !timedOut) {
				throw new DOMException('Aborted', 'AbortError'); // user-initiated abort: do not retry
			}
			lastError = timedOut
				? new Error(`The provider did not start responding within ${Math.round(timeoutMs / 1000)}s. Free tiers often queue requests when a model is busy or cold — try again in a moment, pick a different (more popular) model, or switch providers.`)
				: err;
			if (networkAttempts < retries) {
				const delayMs = backoffMs(networkAttempts);
				opts?.onRetry?.({ attempt: networkAttempts, delayMs, reason: timedOut ? 'timeout' : 'network' });
				networkAttempts++;
				await sleep(delayMs);
				continue;
			}
			throw lastError;
		}
	}
}

/** Builds a friendly error message from a failed (non-OK) HTTP response. */
export async function describeHttpError(provider: string, response: Response): Promise<string> {
	let detail = '';
	try {
		const text = await response.text();
		try {
			const json = JSON.parse(text);
			detail = json?.error?.message ?? json?.message ?? json?.detail ?? text;
		} catch {
			detail = text;
		}
	} catch {
		// ignore body read errors
	}
	detail = (detail || '').toString().slice(0, 500);
	if (response.status === 401 || response.status === 403) {
		return `${provider}: authentication failed (HTTP ${response.status}). Check that your API key is valid. ${detail}`;
	}
	if (response.status === 429) {
		const retryAfter = response.headers.get('retry-after');
		const seconds = retryAfter ? Number(retryAfter) : NaN;
		const wait = !Number.isNaN(seconds) ? `try again in ~${Math.ceil(seconds)}s` : 'try again shortly';
		return `${provider}: rate limited (HTTP 429) — the model's free-tier quota is spent or requests came too fast. Please ${wait}, switch to a less busy model, or add your own API key for higher limits. ${detail}`.trim();
	}
	return `${provider}: request failed (HTTP ${response.status}). ${detail}`;
}
