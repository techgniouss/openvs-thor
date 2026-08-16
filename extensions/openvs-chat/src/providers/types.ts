/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RateLimitSnapshot } from './rateLimits';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single tool/function call requested by the model. */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	/**
	 * Opaque provider-specific continuation token that must be echoed back verbatim
	 * alongside this call when it is replayed into history on a later step — e.g.
	 * Gemini 3's `thoughtSignature`, required on every `functionCall` part or the API
	 * 400s ("Function call is missing a thought_signature"). Undefined for providers
	 * that don't need one; never interpreted, only round-tripped.
	 */
	readonly signature?: string;
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
	/**
	 * Total context window in tokens as reported by the provider's catalog. Authoritative
	 * when present: guessing it from the model name underestimates every model the name
	 * table doesn't know, which makes compaction fire constantly and degrade long runs.
	 */
	readonly contextLength?: number;
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
	/**
	 * Out-of-band transport status (auto-retry, slow start). Kept off {@link onToken} so
	 * it renders as a UI notice instead of being spliced into the model's own answer.
	 */
	readonly onNotice?: (text: string) => void;
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
	/** Out-of-band transport status (auto-retry, slow start). See {@link ChatRequest.onNotice}. */
	readonly onNotice?: (text: string) => void;
}

/**
 * Why the model stopped producing a response, normalized across backends. `stop` is a
 * natural finish, `length` a max-token cutoff, `tool_calls` a hand-off to tools, and
 * `filtered` / `refused` a provider-side block — the last two must be surfaced rather
 * than mistaken for a completed answer.
 */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'filtered' | 'refused';

/** The model's response to a single agent step. */
export interface AgentStep {
	readonly content: string;
	readonly toolCalls: ToolCall[];
	/** True when the step was cut off by the max-token limit before the model finished. */
	readonly truncated?: boolean;
	/** Normalized stop reason reported by the backend, when it reported one. */
	readonly finishReason?: FinishReason;
}

/** The outcome of a completed {@link ChatProvider.streamChat} call. */
export interface StreamChatResult {
	/**
	 * True when the response was cut off by the max-token limit (`finish_reason:
	 * "length"` / `stop_reason: "max_tokens"`) rather than finishing naturally.
	 */
	readonly truncated: boolean;
	/** Normalized stop reason reported by the backend, when it reported one. */
	readonly finishReason?: FinishReason;
}

/** Maps a raw backend stop reason onto the normalized {@link FinishReason} set. */
export function normalizeFinishReason(raw: string | undefined | null): FinishReason | undefined {
	switch (raw) {
		case 'length':
		case 'max_tokens':
			return 'length';
		case 'tool_calls':
		case 'tool_use':
		case 'function_call':
			return 'tool_calls';
		case 'content_filter':
			return 'filtered';
		case 'refusal':
			return 'refused';
		case 'stop':
		case 'end_turn':
		case 'stop_sequence':
			return 'stop';
		default:
			return raw ? 'stop' : undefined;
	}
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
	/**
	 * True when the backend serves a repeated prompt prefix from cache — Anthropic's
	 * explicit `cache_control` breakpoints, OpenAI's automatic prefix caching, or a
	 * gateway that provides one of those.
	 *
	 * This changes what a long conversation *costs*, which is why the agent loop asks:
	 * every step re-sends the whole conversation, so without caching the per-step cost is
	 * the conversation's current size and the run's total cost is quadratic in its length.
	 * With caching the same prompt is a fraction of the price and far quicker to first
	 * token, and compaction — which rewrites the middle and so invalidates the cached
	 * prefix — becomes something to do later rather than sooner. See `COMPACT_TRIGGER`.
	 */
	readonly cachesPrompts?: boolean;
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
/**
 * What counts as a loop. A single line has to repeat {@link REPEAT_RUN_LIMIT} times; a
 * cycle of several lines only {@link REPEAT_CYCLE_LIMIT}, since a model that keeps
 * re-emitting the same *paragraph* has clearly lost the thread. Cycles shorter than
 * {@link REPEAT_MIN_LINE_CHARS} in total are ignored: a run of `}` or `---` or `| --- |`
 * is ordinary formatting, a run of the same sentence is not.
 */
const REPEAT_RUN_LIMIT = 8;
const REPEAT_CYCLE_LIMIT = 4;
const REPEAT_MAX_PERIOD = 4;
const REPEAT_MIN_LINE_CHARS = 12;
/** How much of the tail to inspect, and how many new characters to let by between scans. */
const REPEAT_TAIL_CHARS = 4000;
const REPEAT_SCAN_INTERVAL = 400;

/**
 * Whether `text` ends in the same line — or the same short cycle of lines — repeated over
 * and over.
 *
 * A model that loses the plot mid-answer often emits one line (or one bullet pair) until
 * its output budget runs out, and that cutoff reaches us as a max-token stop, identical to
 * a genuinely long answer being clipped. Continuation then makes it worse, handing the
 * loop another full budget up to {@link MAX_CONTINUATION_ROUNDS} times over.
 */
export function endsInRepeatLoop(text: string): boolean {
	const tail = text.length > REPEAT_TAIL_CHARS ? text.slice(-REPEAT_TAIL_CHARS) : text;
	const lines: string[] = [];
	for (const raw of tail.split('\n')) {
		const line = raw.trim();
		if (line) {
			lines.push(line);
		}
	}
	// The last line is excluded rather than counted: mid-stream it is a half-written copy
	// of the one above it, which would never compare equal.
	const end = lines.length - 1;
	for (let period = 1; period <= REPEAT_MAX_PERIOD; period++) {
		const need = period === 1 ? REPEAT_RUN_LIMIT : REPEAT_CYCLE_LIMIT;
		if (end < period * need) {
			continue;
		}
		const cycle = lines.slice(end - period, end);
		// Measured per line, not summed: two `| --- |` rules add up to a "long" cycle while
		// still being nothing but table formatting.
		if (!cycle.some(line => line.length >= REPEAT_MIN_LINE_CHARS)) {
			continue;
		}
		let reps = 0;
		for (let start = end - period; start >= 0; start -= period) {
			let same = true;
			for (let i = 0; i < period && same; i++) {
				same = lines[start + i] === cycle[i];
			}
			if (!same) {
				break;
			}
			reps++;
		}
		if (reps >= need) {
			return true;
		}
	}
	return false;
}

/**
 * The last {@link REPEAT_TAIL_CHARS} of `earlier` followed by `latest`, without building
 * the whole response to look at its end — the scan runs every few hundred characters, so
 * concatenating a growing answer each time is quadratic in exactly the long responses this
 * guard exists for.
 */
function repeatScanTail(earlier: string, latest: string): string {
	if (latest.length >= REPEAT_TAIL_CHARS) {
		return latest;
	}
	return earlier.slice(-(REPEAT_TAIL_CHARS - latest.length)) + latest;
}

/** Shown when a run is cut short by {@link endsInRepeatLoop} rather than by the model. */
const REPEAT_LOOP_NOTICE =
	'The model started repeating itself, so the response was stopped there instead of ' +
	'being continued. Send the message again, or switch to a stronger model.';

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
		// Aborting the provider is the only way to stop a loop while it is still burning
		// tokens. It gets its own controller so ours stays distinguishable from the user's
		// Stop — theirs must still propagate as an abort, ours must not.
		const guard = new AbortController();
		const relayAbort = () => guard.abort();
		request.signal.addEventListener('abort', relayAbort, { once: true });
		if (request.signal.aborted) {
			guard.abort();
		}
		let looping = false;
		let sinceScan = 0;
		let result: StreamChatResult | undefined;
		try {
			result = (await provider.streamChat({
				...request,
				messages,
				signal: guard.signal,
				onToken: delta => {
					chunk += delta;
					request.onToken(delta);
					// Scanning the tail on every token would be O(n²) over a long answer.
					sinceScan += delta.length;
					if (looping || sinceScan < REPEAT_SCAN_INTERVAL) {
						return;
					}
					sinceScan = 0;
					if (endsInRepeatLoop(repeatScanTail(full, chunk))) {
						looping = true;
						guard.abort();
					}
				},
			})) || undefined;
		} catch (err) {
			// Our own abort ends the response where it stands; anything else is a real
			// failure (including the user's Stop) and still belongs to the caller.
			if (!looping || request.signal.aborted || !isAbortError(err)) {
				throw err;
			}
		} finally {
			request.signal.removeEventListener('abort', relayAbort);
		}
		full += chunk;
		if (looping) {
			request.onNotice?.(REPEAT_LOOP_NOTICE);
			return { text: full, truncated: false };
		}
		const truncated = !!result?.truncated;
		// A chunk with no real text means the model made no progress; bail rather than loop.
		// Whitespace counts as no progress: continuing on it would also build a prefill turn
		// that is empty after the trailing-whitespace strip below, which Anthropic rejects.
		if (!truncated || !chunk.trim() || !full.trim() || round >= MAX_CONTINUATION_ROUNDS) {
			return { text: full, truncated };
		}
		// The mid-stream scan can miss a loop that only became one on the last few lines, or
		// that arrived in a single chunk from a non-streaming backend. Cut off *and* ending
		// in a repeat means the loop ate the budget — continuing just buys it another.
		if (endsInRepeatLoop(full)) {
			request.onNotice?.(REPEAT_LOOP_NOTICE);
			return { text: full, truncated: false };
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
	/**
	 * The last thing this backend said about its token allowance for `model`, read off
	 * response headers. Optional: a backend that reports nothing simply has no opinion, and
	 * callers fall back to learning a ceiling from the rejection when one arrives.
	 */
	rateLimit?(model: string): RateLimitSnapshot | undefined;
}

/**
 * Default inter-chunk idle timeout for streaming responses. A stream that stops
 * producing bytes for this long is treated as dead: without it a stalled provider
 * leaves the UI "typing" forever, because {@link apiFetch}'s timeout only covers
 * response *headers*.
 */
const DEFAULT_STREAM_IDLE_MS = 120_000;

let streamIdleMs = DEFAULT_STREAM_IDLE_MS;

/**
 * Overrides the inter-chunk idle timeout used by {@link readSSE}. Providers stay
 * self-contained (fetch only), so the workspace setting is pushed in from the host.
 */
export function setStreamIdleTimeout(ms: number): void {
	streamIdleMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_STREAM_IDLE_MS;
}

/** Options controlling {@link readSSE}'s stall detection and end-of-stream validation. */
export interface ReadSSEOptions {
	/** Abort if no bytes arrive for this many ms. Defaults to the configured idle timeout. */
	readonly idleMs?: number;
	/** Provider label used in stall / truncated-stream error messages. */
	readonly label?: string;
	/**
	 * Called once the body ends, to report whether the provider's own terminal event
	 * (`[DONE]`, `message_stop`, a `finish_reason`, …) was ever seen. Returning false
	 * means the connection dropped mid-response, which {@link readSSE} turns into an
	 * error instead of letting it masquerade as a complete answer.
	 */
	readonly sawTerminal?: () => boolean;
}

/** Reads one chunk, rejecting if the stream stalls for longer than `idleMs`. */
async function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	idleMs: number,
	label: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (idleMs <= 0) {
		return reader.read();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stalled = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			// Reject before cancelling: `cancel()` settles the in-flight `read()` synchronously,
			// and whichever promise settles first wins the race — cancelling first would make
			// the stall look like a clean end of stream.
			reject(new Error(`${label}: the response stalled — no data for ${Math.round(idleMs / 1000)}s. The connection was dropped; send "continue" to resume.`));
			void reader.cancel().catch(() => { /* already closed */ });
		}, idleMs);
	});
	try {
		return await Promise.race([reader.read(), stalled]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Reads a `text/event-stream` (SSE) HTTP response body line by line and invokes
 * `onEvent` with each `data:` payload (excluding the trailing `[DONE]` sentinel).
 * Rejects when the stream stalls, is aborted, or ends without the provider's terminal
 * event — a silent mid-response disconnect must never look like a finished answer.
 */
export async function readSSE(
	response: Response,
	onEvent: (data: string) => void,
	signal: AbortSignal,
	opts?: ReadSSEOptions,
): Promise<void> {
	if (!response.body) {
		throw new Error('Response had no body to stream.');
	}
	const label = opts?.label ?? 'The provider';
	const idleMs = opts?.idleMs ?? streamIdleMs;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let sawDone = false;
	/** Emits every complete `data:` line held in `buffer`. */
	const drain = (): void => {
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			emit(line);
		}
	};
	const emit = (line: string): void => {
		if (!line.startsWith('data:')) {
			return;
		}
		const data = line.slice('data:'.length).trim();
		if (data === '[DONE]') {
			sawDone = true;
			return;
		}
		if (data.length === 0) {
			return;
		}
		onEvent(data);
	};
	try {
		while (true) {
			if (signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			const { done, value } = await readChunk(reader, idleMs, label);
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			drain();
		}
		// A final event can arrive without its trailing newline; it carries the
		// `finish_reason`, so dropping it would lose the truncation signal.
		buffer += decoder.decode();
		drain();
		const tail = buffer.trim();
		if (tail) {
			emit(tail);
		}
	} finally {
		reader.releaseLock();
	}
	if (signal.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
	const terminal = opts?.sawTerminal ? opts.sawTerminal() || sawDone : true;
	if (!terminal) {
		throw new Error(`${label}: the response ended before it was complete — the connection was dropped mid-stream. Send "continue" to resume.`);
	}
}

/** Why an {@link apiFetch} attempt is being retried, passed to {@link ApiFetchOptions.onRetry}. */
export interface RetryInfo {
	/** Zero-based index of the retry about to happen (0 = first retry). */
	readonly attempt: number;
	/** How long the client will wait before the retry, in ms. */
	readonly delayMs: number;
	readonly reason: 'rate-limit' | 'server' | 'network' | 'timeout' | 'pacing';
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
	/**
	 * Called with every response received, retried ones included. Providers use it to read
	 * the rate-limit headers a backend states its own allowances in — see
	 * {@link RateLimitTracker}. Must not consume the body.
	 */
	readonly onResponse?: (response: Response) => void;
	/**
	 * How long to wait before sending, given the request's estimated size in tokens.
	 * Returning 0 sends immediately. Lets a caller sit out a token window it knows the
	 * request cannot fit, instead of spending a request to be told so.
	 */
	readonly pace?: (estimatedTokens: number) => number;
}

/**
 * Fetch options shared by every streaming chat POST: a long first-byte window (free tiers
 * queue requests server-side and can take over a minute to start on a cold model) and a
 * single retry, since retrying a queued request just re-enters the same queue.
 */
export const STREAM_FETCH_OPTS = { timeoutMs: 150_000, retries: 1 } as const;

/** Wording for the "retrying in Ns…" notice shown while {@link apiFetch} backs off. */
export function retryNotice(label: string, info: RetryInfo): string {
	const secs = Math.max(1, Math.ceil(info.delayMs / 1000));
	// Pacing happens BEFORE a request, not after a failure, so it must not say "retrying" —
	// nothing has gone wrong, and telling the user otherwise would misreport a healthy run.
	if (info.reason === 'pacing') {
		return `${label}'s token allowance refills in ${secs}s — waiting rather than spending a request to be refused…`;
	}
	const why = info.reason === 'rate-limit' ? `Rate limited by ${label}`
		: info.reason === 'timeout' ? `${label} is slow to start`
			: `Transient ${label} error`;
	return `${why} — retrying in ${secs}s…`;
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

/**
 * Sleeps, but wakes immediately if the caller aborts.
 *
 * A plain timer meant Stop did nothing until the wait elapsed — up to 30s for a rate-limit
 * backoff, and now also for a pacing wait. The user pressed the one button that is supposed
 * to be instant, so the wait has to be interruptible rather than merely checked afterwards.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		return new Promise<void>(resolve => setTimeout(resolve, ms));
	}
	// Checked here, not only by the caller before the call: `abort` fires once, so a signal
	// that aborted between the caller's check and this listener would never notify us and
	// the wait would run to completion — the exact case (a Stop landing mid-backoff) this
	// exists to handle.
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise<void>(resolve => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/**
 * Rough token size of a request body, for pacing only. The same 4-chars-per-token estimate
 * the context budget uses; a serialized JSON body is mostly the conversation, so it tracks
 * closely enough to decide whether a request can fit what a window has left.
 */
function estimateBodyTokens(body: RequestInit['body']): number {
	return typeof body === 'string' ? Math.ceil(body.length / 4) : 0;
}

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
		// Sit out a token window this request is known not to fit, before spending a request
		// to be told so. Estimated from the serialized body because that is the only measure
		// available this far down — the conversation's own token count never reaches here.
		//
		// First attempt only. Every retry path below already waited a delay chosen for the
		// failure it saw — a 429's own `Retry-After`, most precisely — and pacing on top of
		// that would sleep twice for one refill, up to a minute, while the user watches a
		// run that has not stalled do nothing.
		const paceMs = networkAttempts + rateLimitAttempts === 0 ? opts?.pace?.(estimateBodyTokens(init.body)) ?? 0 : 0;
		if (paceMs > 0) {
			opts?.onRetry?.({ attempt: 0, delayMs: paceMs, reason: 'pacing' });
			await sleep(paceMs, signal);
			if (signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
		}
		const controller = new AbortController();
		const unlink = linkAbort(signal, controller);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
		try {
			const response = await fetch(url, { ...init, signal: controller.signal });
			clearTimeout(timer);
			unlink();
			// Before any status branching, so a 429's headers — the most informative ones a
			// backend sends — are recorded rather than lost to the retry path.
			opts?.onResponse?.(response);
			if (response.status === 429 && rateLimitAttempts < rateLimitRetries) {
				const delayMs = backoffMs(rateLimitAttempts, response);
				opts?.onRetry?.({ attempt: rateLimitAttempts, delayMs, reason: 'rate-limit', status: 429 });
				rateLimitAttempts++;
				await sleep(delayMs, signal);
				continue;
			}
			if (response.status >= 500 && networkAttempts < retries) {
				const delayMs = backoffMs(networkAttempts, response);
				opts?.onRetry?.({ attempt: networkAttempts, delayMs, reason: 'server', status: response.status });
				networkAttempts++;
				await sleep(delayMs, signal);
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
				await sleep(delayMs, signal);
				continue;
			}
			throw lastError;
		}
	}
}

/**
 * Whether a rejection is a cancellation rather than a failure.
 *
 * Broader than `err instanceof DOMException`: an abort reaches us as a `DOMException`
 * from `fetch`, as a plain `Error` named `AbortError` from some runtimes and polyfills,
 * and as a Node system error carrying `ABORT_ERR`. Getting this wrong is user-visible in
 * the worst way — the agent loop turns an unrecognized rejection into a reported failure,
 * so pressing Stop would pop an error toast blaming the provider.
 */
export function isAbortError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === 'AbortError') {
		return true;
	}
	const candidate = err as { name?: unknown; code?: unknown } | null | undefined;
	return !!candidate && (candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR');
}

/**
 * Failures that are definitively the caller's fault and will fail identically forever:
 * a bad key, a revoked token, a model the account can't reach. Checked first, because a
 * 403 body routinely contains words ("try again", "temporarily") that the transient
 * patterns below would otherwise match.
 */
const PERMANENT_PATTERNS: RegExp[] = [
	/authentication failed/,
	/\bhttp 40[13]\b/,
	/invalid api key|incorrect api key|no api key|unauthorized|forbidden/,
	/does not support/,
];

/**
 * Failures that a later identical request has a real chance of surviving: the provider
 * fell over, the gateway queue timed out, the socket dropped mid-stream. Matched against
 * the messages this module produces ({@link describeHttpError}, {@link readSSE},
 * {@link apiFetch}) plus the raw runtime network errors underneath them.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
	/\bhttp 5\d\d\b/,
	/\bhttp (408|409|425|429)\b/,
	/rate limited/,
	/response stalled/,
	/ended before it was complete/,
	/did not start responding within/,
	/fetch failed|network error|socket hang up|premature close|terminated/,
	/econnreset|econnrefused|etimedout|enotfound|eai_again|epipe/,
	/temporarily unavailable|service unavailable|overloaded|bad gateway|gateway timeout/,
];

/**
 * Whether a failed provider request is worth retrying as-is.
 *
 * The agent loop uses this to decide between resuming a run and ending it: a dropped
 * stream halfway through a twenty-step task used to destroy the whole run — every tool
 * result it had gathered lives only in that run's message array — while a bad API key
 * retried three times just wastes the user's time. Unrecognized failures are treated as
 * permanent, so a genuinely broken request fails fast and loudly.
 */
export function isTransientProviderError(message: string): boolean {
	const m = message.toLowerCase();
	if (PERMANENT_PATTERNS.some(p => p.test(m))) {
		return false;
	}
	return TRANSIENT_PATTERNS.some(p => p.test(m));
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
	if (response.status === 413) {
		// The wording matters: `isContextLengthError` keys off "request too large", which is
		// what lets the agent loop adopt the stated ceiling and retry instead of ending the
		// run. A backend that sends an empty 413 body must still say it here.
		return `${provider}: request too large (HTTP 413) — it exceeded the per-request or per-minute token allowance for this model. ${detail}`.trim();
	}
	if (response.status === 429) {
		const retryAfter = response.headers.get('retry-after');
		const seconds = retryAfter ? Number(retryAfter) : NaN;
		const wait = !Number.isNaN(seconds) ? `try again in ~${Math.ceil(seconds)}s` : 'try again shortly';
		return `${provider}: rate limited (HTTP 429) — the model's free-tier quota is spent or requests came too fast. Please ${wait}, switch to a less busy model, or add your own API key for higher limits. ${detail}`.trim();
	}
	return `${provider}: request failed (HTTP ${response.status}). ${detail}`;
}
