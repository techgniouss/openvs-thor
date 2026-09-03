/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpToolDef, flattenContent } from './client';

/**
 * Handshake and `tools/list` budget — the same reasoning as the stdio client's: a server
 * that cannot introduce itself promptly is broken, and this is paid at startup. Slightly
 * longer than stdio's because this one crosses a network.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** `tools/call` budget. A remote tool call is real work (a search, a query, a build). */
const CALL_TIMEOUT_MS = 120_000;

const PROTOCOL_VERSION = '2025-06-18';
/** The version the legacy HTTP+SSE servers were written against. */
const LEGACY_PROTOCOL_VERSION = '2024-11-05';

/** Per-server configuration for a remote (HTTP) MCP server. */
export interface McpHttpConfig {
	readonly url: string;
	/** Extra request headers — an `Authorization: Bearer …` for a hosted server, usually. */
	readonly headers?: Record<string, string>;
}

/**
 * Which wire a server turned out to speak. Decided once during {@link McpHttpClient.start}
 * and never revisited: the two differ in where a *response* arrives, so guessing per
 * request would strand replies.
 */
type Transport = 'streamable' | 'legacy-sse';

/** One in-flight JSON-RPC request. */
interface Pending {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * A Model Context Protocol client over HTTP, covering both transports in the wild:
 *
 *   * **Streamable HTTP** (the current spec): every request is a POST, and the reply comes
 *     back either as `application/json` or as a short `text/event-stream` on that same
 *     response.
 *   * **HTTP+SSE** (the 2024-11-05 transport, still what a lot of deployed servers speak):
 *     a long-lived GET carries every reply, and requests are POSTed to a second URL the
 *     server names in its opening `endpoint` event.
 *
 * Both are needed. Hosted MCP servers — the ones that need no local install, and therefore
 * the ones that make "connect a tool" a URL rather than a toolchain — are split across the
 * two, and before this the extension had no HTTP transport at all: a server configured with
 * a `url` was skipped with a note, so none of that ecosystem was reachable.
 *
 * Dependency-free, and deliberately parallel in shape to {@link McpStdioClient} so
 * {@link McpManager} can hold either behind one interface.
 */
export class McpHttpClient {
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private closed = false;
	private transport: Transport = 'streamable';
	/** Server-assigned session id (`Mcp-Session-Id`), echoed on every later request. */
	private sessionId?: string;
	/** Where requests are POSTed. The configured URL, until a legacy server names another. */
	private postUrl: string;
	/** Aborts the long-lived GET stream of the legacy transport on dispose. */
	private readonly streamAbort = new AbortController();
	/** Resolves once the legacy transport has learned its POST endpoint. */
	private endpointReady?: Promise<void>;

	constructor(private readonly config: McpHttpConfig) {
		this.postUrl = config.url;
	}

	/** Connects, negotiating the transport, and completes the MCP initialize handshake. */
	async start(): Promise<void> {
		const init = {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'openvs-chat', version: '1.0.0' },
		};
		try {
			await this.request('initialize', init);
		} catch (err) {
			// A server that only speaks the legacy transport answers a POST with 405 (or
			// 404 when the POST path is a different one entirely). That is not a failure to
			// report — it is the other transport announcing itself, so try it before giving up.
			if (!isLegacySignal(err)) {
				throw err;
			}
			this.transport = 'legacy-sse';
			await this.openLegacyStream();
			await this.request('initialize', { ...init, protocolVersion: LEGACY_PROTOCOL_VERSION });
		}
		this.notify('notifications/initialized', {});
	}

	async listTools(): Promise<McpToolDef[]> {
		const result = await this.request('tools/list', {});
		return Array.isArray(result?.tools) ? result.tools : [];
	}

	/** Calls a tool and returns its content flattened to text, with an error flag. */
	async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
		const result = await this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
		return { text: flattenContent(result?.content), isError: result?.isError === true };
	}

	dispose(): void {
		this.closed = true;
		this.streamAbort.abort();
		this.failAll('MCP client disposed.');
	}

	// --- internals --------------------------------------------------------------

	private headers(accept: string): Record<string, string> {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept,
			...(this.config.headers ?? {}),
		};
		if (this.sessionId) {
			headers['mcp-session-id'] = this.sessionId;
		}
		if (this.transport === 'streamable') {
			headers['mcp-protocol-version'] = PROTOCOL_VERSION;
		}
		return headers;
	}

	private async request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
		if (this.closed) {
			return Promise.reject(new Error('MCP client is not connected.'));
		}
		if (this.endpointReady) {
			await this.endpointReady;
		}
		const id = this.nextId++;
		const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
		const settled = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`MCP request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s.`));
				}
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});

		// The POST is fired without awaiting its body here in the legacy case: there the
		// reply arrives on the GET stream, and the POST itself only answers 202.
		const post = this.post(body, timeoutMs).catch((err: unknown) => {
			const entry = this.pending.get(id);
			if (entry) {
				this.pending.delete(id);
				clearTimeout(entry.timer);
				entry.reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
		if (this.transport === 'streamable') {
			await post;
		}
		return settled;
	}

	/**
	 * Sends one JSON-RPC payload. On the streamable transport the reply comes back on this
	 * very response — as JSON, or as a brief SSE stream when the server wants to interleave
	 * notifications — and is dispatched from here.
	 */
	private async post(body: string, timeoutMs: number): Promise<void> {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		// A dispose must cut a request short rather than leave it running to its timeout.
		const onDispose = () => abort.abort();
		this.streamAbort.signal.addEventListener('abort', onDispose);
		let response: Response;
		try {
			response = await fetch(this.postUrl, {
				method: 'POST',
				headers: this.headers('application/json, text/event-stream'),
				body,
				signal: abort.signal,
			});
		} finally {
			clearTimeout(timer);
			this.streamAbort.signal.removeEventListener('abort', onDispose);
		}
		const session = response.headers.get('mcp-session-id');
		if (session) {
			this.sessionId = session;
		}
		if (!response.ok) {
			throw new Error(`MCP server returned HTTP ${response.status} ${response.statusText}.`.trim());
		}
		if (response.status === 202 || !response.body) {
			return; // Accepted; the reply (if any) arrives on the GET stream.
		}
		const type = response.headers.get('content-type') ?? '';
		if (type.includes('text/event-stream')) {
			// One response stream per request: it ends once the reply this POST was waiting
			// for has arrived, so it is read to completion rather than left open.
			await this.readEvents(response, abort.signal);
			return;
		}
		const text = await response.text();
		if (text.trim()) {
			this.handleMessage(text);
		}
	}

	/**
	 * Opens the legacy transport's long-lived GET stream and waits for the `endpoint` event
	 * that names where requests go. Every later reply arrives on this stream too.
	 */
	private async openLegacyStream(): Promise<void> {
		const response = await fetch(this.config.url, {
			method: 'GET',
			headers: this.headers('text/event-stream'),
			signal: this.streamAbort.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`MCP server returned HTTP ${response.status} opening its event stream.`);
		}
		let resolveEndpoint: () => void;
		let rejectEndpoint: (err: Error) => void;
		this.endpointReady = new Promise<void>((resolve, reject) => {
			resolveEndpoint = resolve;
			rejectEndpoint = reject;
		});
		// Read in the background for the life of the connection. A stream that ends is the
		// server hanging up: every waiting request has to be failed, or each would sit until
		// its own timeout with no explanation.
		void this.readEvents(response, this.streamAbort.signal, (event, data) => {
			if (event !== 'endpoint') {
				return false;
			}
			try {
				this.postUrl = new URL(data.trim(), this.config.url).toString();
				resolveEndpoint();
			} catch {
				rejectEndpoint(new Error(`MCP server named an unusable endpoint: ${data.trim()}`));
			}
			return true;
		}).then(
			() => {
				this.closed = true;
				this.failAll('The MCP server closed its event stream.');
			},
			(err: unknown) => {
				this.closed = true;
				this.failAll(`The MCP server\'s event stream failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		const ready = this.endpointReady;
		// Clear the gate before awaiting it: `request` awaits `endpointReady` on the way in,
		// and the initialize below is itself a request.
		this.endpointReady = undefined;
		await withTimeout(ready, REQUEST_TIMEOUT_MS, 'The MCP server never named its POST endpoint.');
	}

	/**
	 * Reads an SSE body, handing each complete event to `onEvent` (which returns true when
	 * it consumed the event) and every unconsumed `data:` payload to the JSON-RPC dispatch.
	 *
	 * Written here rather than reused from `providers/types.readSSE`: that one exists to
	 * decode an LLM token stream — it only surfaces `data:` lines, treats `[DONE]` as the
	 * terminator, and *rejects* a stream that ends without one. MCP has named events
	 * (`endpoint`), no sentinel, and a stream that simply ends is normal.
	 */
	private async readEvents(response: Response, signal: AbortSignal, onEvent?: (event: string, data: string) => boolean): Promise<void> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const flush = (block: string): void => {
			let event = 'message';
			const data: string[] = [];
			for (const line of block.split('\n')) {
				if (line.startsWith('event:')) {
					event = line.slice(6).trim();
				} else if (line.startsWith('data:')) {
					data.push(line.slice(5).replace(/^ /, ''));
				}
			}
			if (!data.length) {
				return;
			}
			const payload = data.join('\n');
			if (onEvent?.(event, payload)) {
				return;
			}
			this.handleMessage(payload);
		};
		try {
			for (;;) {
				if (signal.aborted) {
					return;
				}
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				// Events are separated by a blank line; \r\n is tolerated because plenty of
				// servers send it.
				let split: number;
				while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
					const block = buffer.slice(0, split);
					buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, '');
					flush(block);
				}
			}
			if (buffer.trim()) {
				flush(buffer);
			}
		} finally {
			reader.cancel().catch(() => { /* the stream is already going away */ });
		}
	}

	private handleMessage(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return; // not JSON-RPC; ignore (keep-alive comments, server logs)
		}
		// A batch is legal on the wire, and a server that answers one request per element
		// would otherwise have every reply dropped.
		for (const entry of Array.isArray(message) ? message : [message]) {
			if (typeof entry?.id !== 'number') {
				continue; // notifications and server-initiated requests are ignored
			}
			const waiting = this.pending.get(entry.id);
			if (!waiting) {
				continue;
			}
			this.pending.delete(entry.id);
			clearTimeout(waiting.timer);
			if (entry.error) {
				waiting.reject(new Error(entry.error.message ?? 'MCP error'));
			} else {
				waiting.resolve(entry.result);
			}
		}
	}

	private notify(method: string, params: unknown): void {
		if (this.closed) {
			return;
		}
		// A notification has no id and no reply, so its failure is not something any caller
		// is waiting on — but it must not become an unhandled rejection either.
		void this.post(JSON.stringify({ jsonrpc: '2.0', method, params }), REQUEST_TIMEOUT_MS)
			.catch(() => { /* the next real request will report the connection's state */ });
	}

	private failAll(reason: string): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		this.pending.clear();
	}
}

/** Whether a failed POST is a server saying "I speak the older transport", not a real error. */
function isLegacySignal(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /HTTP (404|405|501)\b/.test(message);
}

/** Rejects with `message` if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}
