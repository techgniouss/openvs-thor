/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Handshake and `tools/list` budget. Short on purpose: a server that cannot introduce
 * itself in 20s is broken, and every one of these is paid during startup.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * `tools/call` budget. Far longer than the handshake because a tool call is real work —
 * a build, a browser navigation, a database query — and the handshake's 20s cut those off
 * mid-flight, reported them to the model as a failure, and left the server still running
 * the abandoned call.
 */
const CALL_TIMEOUT_MS = 120_000;

/** How much of a server's stderr is retained to explain a failure. */
const MAX_STDERR_CHARS = 4_000;

/** A tool advertised by an MCP server (`tools/list`). */
export interface McpToolDef {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
	/**
	 * The server's own behavioral hints. Only `readOnlyHint` is read: it is what lets the
	 * agent loop tell an MCP tool that inspects something from one that changes the
	 * workspace, and therefore whether a run still owes the user a verification step.
	 * Advisory by spec, so absence means "assume it can write".
	 */
	readonly annotations?: { readonly readOnlyHint?: boolean };
}

/**
 * Flattens a `tools/call` result's content blocks to text. Lives here so both transports
 * summarize a result identically.
 *
 * Non-text blocks are described, never inlined. A server that returns a screenshot sends
 * base64 in `data`, and serializing the block whole put megabytes of it into the
 * conversation — which is not merely wasteful: a tool result is re-sent on every later
 * step, so on a small per-request allowance one such result ends the run.
 */
export function flattenContent(content: unknown): string {
	const blocks: Array<Record<string, any>> = Array.isArray(content) ? content : [];
	const text = blocks.map(block => {
		if (block?.type === 'text' && typeof block.text === 'string') {
			return block.text;
		}
		if (block?.type === 'image' || block?.type === 'audio') {
			const bytes = typeof block.data === 'string' ? Math.round(block.data.length * 0.75) : 0;
			return `(${block.type} returned${block.mimeType ? ` as ${block.mimeType}` : ''}`
				+ `${bytes ? `, ~${Math.round(bytes / 1024)}KB` : ''} — not shown; this conversation carries text only)`;
		}
		if (block?.type === 'resource' || block?.type === 'resource_link') {
			const resource = block.resource ?? block;
			if (typeof resource?.text === 'string') {
				return resource.text;
			}
			return `(resource ${resource?.uri ?? 'without a uri'}`
				+ `${resource?.mimeType ? ` (${resource.mimeType})` : ''} — binary content not shown)`;
		}
		return JSON.stringify(block);
	}).join('\n').trim();
	return text || '(no output)';
}

export interface McpStdioConfig {
	readonly command: string;
	readonly args?: string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
}

/**
 * A minimal Model Context Protocol client over the stdio transport: it speaks
 * newline-delimited JSON-RPC 2.0 to a spawned server process, performs the initialize
 * handshake, and supports `tools/list` and `tools/call`. Dependency-free.
 */
export class McpStdioClient {
	private proc?: ReturnType<typeof spawn>;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private buffer = '';
	private closed = false;
	/** Rolling tail of the server's stderr, used to explain a failure. */
	private stderr = '';

	constructor(private readonly config: McpStdioConfig) { }

	/** Spawns the server and completes the MCP initialize handshake. */
	async start(): Promise<void> {
		this.proc = spawn(this.config.command, this.config.args ?? [], {
			env: { ...process.env, ...(this.config.env ?? {}) },
			cwd: this.config.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc.stdout?.on('data', (chunk: any) => this.onData(chunk));
		// stderr MUST be drained. It is piped, and a pipe nobody reads fills its OS buffer
		// (~64KB) and then blocks the child's next write forever — so a chatty server did
		// not fail, it silently froze, and every later tool call sat until its timeout. The
		// tail is kept because it is usually the only explanation of why a server died.
		this.proc.stderr?.on('data', (chunk: any) => {
			this.stderr = (this.stderr + String(chunk)).slice(-MAX_STDERR_CHARS);
		});
		// A dead process must be recognized as dead. Without this the client stayed "open"
		// over a corpse: each call wrote to a closed pipe and then waited out the full
		// timeout, turning one crash into minutes of stalled agent steps.
		this.proc.on('exit', (code: number | null) => {
			this.closed = true;
			this.failAll(`MCP server process exited${code === null ? '' : ` (code ${code})`}.${this.stderrTail()}`);
		});
		this.proc.on('error', (err: any) => {
			this.closed = true;
			this.failAll(`MCP server failed to start: ${err?.message ?? err}${this.stderrTail()}`);
		});
		// Writing to a killed child emits 'error' on stdin; unhandled, that is a throw out of
		// an I/O callback, which takes down the extension host rather than one MCP server.
		this.proc.stdin?.on('error', () => { this.closed = true; });

		await this.request('initialize', {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'openvs-chat', version: '1.0.0' },
		});
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
		try {
			this.proc?.kill();
		} catch {
			// ignore
		}
		this.failAll('MCP client disposed.');
	}

	// --- internals --------------------------------------------------------------

	private onData(chunk: any): void {
		this.buffer += chunk.toString();
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				this.handleMessage(line);
			}
		}
	}

	private handleMessage(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return; // ignore non-JSON (some servers log to stdout)
		}
		if (typeof message?.id !== 'number' || !this.pending.has(message.id)) {
			return; // notifications / server requests are ignored
		}
		const entry = this.pending.get(message.id)!;
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error) {
			entry.reject(new Error(message.error.message ?? 'MCP error'));
		} else {
			entry.resolve(message.result);
		}
	}

	private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
		if (this.closed || !this.proc?.stdin?.writable) {
			return Promise.reject(new Error(`MCP client is not connected.${this.stderrTail()}`));
		}
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`MCP request "${method}" timed out after ${Math.round(timeoutMs / 1000)}s.`));
				}
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			// The write itself can throw synchronously on a destroyed stream; failing the one
			// request is correct, crashing the host is not.
			try {
				this.proc!.stdin!.write(payload);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`MCP request "${method}" could not be sent: ${err instanceof Error ? err.message : String(err)}`));
			}
		});
	}

	/** The server's recent stderr, formatted for appending to an error message. */
	private stderrTail(): string {
		const tail = this.stderr.trim();
		return tail ? ` Server output:\n${tail}` : '';
	}

	private notify(method: string, params: unknown): void {
		if (!this.closed && this.proc?.stdin) {
			this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
		}
	}

	private failAll(reason: string): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		this.pending.clear();
	}
}
