/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 20_000;

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

	constructor(private readonly config: McpStdioConfig) { }

	/** Spawns the server and completes the MCP initialize handshake. */
	async start(): Promise<void> {
		this.proc = spawn(this.config.command, this.config.args ?? [], {
			env: { ...process.env, ...(this.config.env ?? {}) },
			cwd: this.config.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc.stdout?.on('data', (chunk: any) => this.onData(chunk));
		this.proc.on('exit', () => this.failAll('MCP server process exited.'));
		this.proc.on('error', (err: any) => this.failAll(`MCP server failed to start: ${err?.message ?? err}`));

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
		const result = await this.request('tools/call', { name, arguments: args });
		const blocks: Array<{ type?: string; text?: string }> = Array.isArray(result?.content) ? result.content : [];
		const text = blocks
			.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
			.join('\n')
			.trim();
		return { text: text || '(no output)', isError: result?.isError === true };
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

	private request(method: string, params: unknown): Promise<any> {
		if (this.closed || !this.proc?.stdin) {
			return Promise.reject(new Error('MCP client is not connected.'));
		}
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`MCP request "${method}" timed out.`));
				}
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.proc!.stdin!.write(payload);
		});
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
