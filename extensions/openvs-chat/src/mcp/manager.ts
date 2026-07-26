/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ToolSpec } from '../providers/types';
import { McpStdioClient, McpStdioConfig } from './client';

/** A toolset the agent loop can merge in and invoke (implemented by the MCP manager). */
export interface McpToolset {
	tools(): ToolSpec[];
	/** Calls a namespaced MCP tool (`mcp__<server>__<tool>`). */
	call(name: string, args: Record<string, unknown>): Promise<{ result: string; isError: boolean }>;
	/**
	 * Whether the server declared this tool as read-only (`annotations.readOnlyHint`).
	 * False when it declared otherwise *or said nothing* — an unannotated tool has to be
	 * assumed capable of changing the workspace.
	 *
	 * Optional so a toolset written against the older interface still loads; callers must
	 * treat its absence as "not known to be read-only".
	 */
	isReadOnly?(name: string): boolean;
}

/** Per-server configuration (stdio). `url` is reserved for a future HTTP transport. */
interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	disabled?: boolean;
}

const NAMESPACE = 'mcp__';
const PROJECT_FILES = ['.openvs/mcp.json', '.vscode/mcp.json'];

/**
 * Discovers MCP servers from global settings (`openvsChat.mcp.servers`) and a project file
 * (`.openvs/mcp.json` or `.vscode/mcp.json`), connects to them, and exposes their tools to
 * the agent under namespaced names. stdio servers only start in a trusted workspace.
 */
export class McpManager implements McpToolset, vscode.Disposable {
	private readonly clients = new Map<string, McpStdioClient>();
	private readonly toolSpecs: ToolSpec[] = [];
	/** namespaced tool name -> { server, tool, readOnly } */
	private readonly routes = new Map<string, { server: string; tool: string; readOnly: boolean }>();
	private readonly status: string[] = [];
	private started = false;
	private starting?: Promise<void>;
	/**
	 * Bumped by every {@link reconnect}. A start that was already in flight compares it
	 * before publishing anything, so a torn-down generation can't repopulate the tool
	 * table it was just cleared from (and leave `started` true over a dead connection).
	 */
	private generation = 0;

	/** Connects to all configured servers once (idempotent). Per-server failures are recorded, not thrown. */
	async ensureStarted(): Promise<void> {
		if (this.started) {
			return;
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = this.startAll();
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	private async startAll(): Promise<void> {
		const generation = this.generation;
		const servers = await this.loadConfig();
		for (const [id, cfg] of Object.entries(servers)) {
			if (this.generation !== generation) {
				return; // superseded by a reconnect
			}
			if (cfg.disabled) {
				continue;
			}
			if (!cfg.command) {
				this.status.push(`${id}: skipped (no "command"; only stdio servers are supported).`);
				continue;
			}
			if (!vscode.workspace.isTrusted) {
				this.status.push(`${id}: skipped (workspace not trusted).`);
				continue;
			}
			await this.startServer(id, cfg as McpStdioConfig, generation);
		}
		if (this.generation === generation) {
			this.started = true;
		}
	}

	private async startServer(id: string, cfg: McpStdioConfig, generation: number): Promise<void> {
		const client = new McpStdioClient({
			command: cfg.command,
			args: cfg.args,
			env: cfg.env,
			cwd: cfg.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		});
		try {
			await client.start();
			const tools = await client.listTools();
			if (this.generation !== generation) {
				client.dispose();
				return; // a reconnect happened while this server was handshaking
			}
			this.clients.set(id, client);
			for (const tool of tools) {
				const namespaced = `${NAMESPACE}${id}__${tool.name}`;
				this.routes.set(namespaced, { server: id, tool: tool.name, readOnly: tool.annotations?.readOnlyHint === true });
				this.toolSpecs.push({
					name: namespaced,
					description: `[MCP:${id}] ${tool.description ?? tool.name}`,
					parameters: tool.inputSchema ?? { type: 'object', properties: {} },
				});
			}
			this.status.push(`${id}: connected (${tools.length} tools).`);
		} catch (err) {
			client.dispose();
			this.status.push(`${id}: failed — ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	tools(): ToolSpec[] {
		return this.toolSpecs;
	}

	isReadOnly(name: string): boolean {
		return this.routes.get(name)?.readOnly === true;
	}

	async call(name: string, args: Record<string, unknown>): Promise<{ result: string; isError: boolean }> {
		const route = this.routes.get(name);
		if (!route) {
			return { result: `Unknown MCP tool: ${name}`, isError: true };
		}
		const client = this.clients.get(route.server);
		if (!client) {
			return { result: `MCP server "${route.server}" is not connected.`, isError: true };
		}
		try {
			const { text, isError } = await client.callTool(route.tool, args);
			return { result: text, isError };
		} catch (err) {
			return { result: `MCP tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
	}

	getStatus(): string[] {
		return this.status.length ? this.status : ['No MCP servers configured.'];
	}

	/** Tears down and forgets all connections so the next ensureStarted reconnects. */
	reconnect(): void {
		this.generation++;
		this.dispose();
		this.started = false;
	}

	dispose(): void {
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
		this.routes.clear();
		this.toolSpecs.length = 0;
		this.status.length = 0;
	}

	/** Merges global settings with a project config file (project wins on id collisions). */
	private async loadConfig(): Promise<Record<string, McpServerConfig>> {
		const merged: Record<string, McpServerConfig> = {};
		const global = vscode.workspace.getConfiguration('openvsChat').get<Record<string, McpServerConfig>>('mcp.servers') ?? {};
		Object.assign(merged, global);

		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (root) {
			for (const file of PROJECT_FILES) {
				const parsed = await this.tryReadJson(vscode.Uri.joinPath(root, file));
				if (parsed) {
					// Accept { servers: {...} }, { mcpServers: {...} } (Claude/Cursor style), or a bare map.
					const servers = parsed.servers ?? parsed.mcpServers ?? parsed;
					if (servers && typeof servers === 'object') {
						Object.assign(merged, servers);
					}
				}
			}
		}
		return merged;
	}

	private async tryReadJson(uri: vscode.Uri): Promise<any | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return undefined;
		}
	}
}
