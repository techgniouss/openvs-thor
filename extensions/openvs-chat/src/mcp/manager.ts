/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ToolSpec } from '../providers/types';
import { McpStdioClient, McpStdioConfig, McpToolDef } from './client';
import { McpHttpClient } from './httpClient';

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

/**
 * Per-server configuration. A server is stdio (`command`) or remote (`url`) — the two are
 * mutually exclusive, and `url` wins if both are given, since naming a URL is the more
 * specific statement.
 */
interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	/** Remote servers only: extra request headers, usually an `Authorization` for a hosted server. */
	headers?: Record<string, string>;
	disabled?: boolean;
}

/**
 * What {@link McpManager} needs of a connection, satisfied by both transports. Declared
 * here rather than in either client so neither has to know about the other.
 */
interface McpClient {
	start(): Promise<void>;
	listTools(): Promise<McpToolDef[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
	dispose(): void;
}

/**
 * Expands `${env:NAME}` in a configured header value.
 *
 * A hosted MCP server needs a token, and the alternative to this is the token itself
 * sitting in `settings.json` or, worse, in a `.openvs/mcp.json` that gets committed.
 * Only environment variables are read: no file access, no secret store lookup, nothing
 * that a project-supplied config could aim at something it should not reach.
 */
function expandEnv(value: string): string {
	return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => process.env[name] ?? '');
}

const NAMESPACE = 'mcp__';
const PROJECT_FILES = ['.openvs/mcp.json', '.vscode/mcp.json'];

/**
 * Both OpenAI and Anthropic constrain a tool name to `^[a-zA-Z0-9_-]{1,64}$` and reject
 * the whole request — not just the offending tool — when one breaks it.
 */
const MAX_TOOL_NAME = 64;
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Whether a tool name is accepted by the provider APIs. Exported so the rule lives in one
 * place and {@link safeToolName} can be tested against the same predicate the wire uses.
 */
export function isWireLegalToolName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_TOOL_NAME && VALID_TOOL_NAME.test(name);
}

/**
 * Builds a wire-legal namespaced name for an MCP tool, unique within `taken`.
 *
 * Server ids come from a user-written config key and tool names from a third-party
 * server, so neither is under our control: a key like `"my server"` or `"github.com/x"`,
 * or simply a long pair such as `cloudflare-observability` + `search_cloudflare_
 * documentation`, produces a name the provider refuses. Because tools are sent on *every*
 * request, one such server did not merely fail to work — it made every agent step in the
 * run 400 before the model saw anything, with an error naming a tool the user never
 * called. Sanitizing and length-capping keeps the failure local to the name.
 *
 * Truncation can collide, so uniqueness is restored with a numeric suffix; the routing
 * table keys on this final name, and the real server/tool pair is carried alongside it.
 */
/**
 * Whether a server's advertised `inputSchema` is a JSON-Schema object we can forward as a
 * tool's `parameters`. A server that sends a string, an array or null would otherwise put
 * that straight into every request, which the provider rejects — failing the whole run
 * rather than the one tool.
 */
function isSchemaObject(schema: unknown): schema is Record<string, unknown> {
	return typeof schema === 'object' && schema !== null && !Array.isArray(schema);
}

export function safeToolName(serverId: string, toolName: string, taken: ReadonlySet<string>): string {
	const clean = (part: string) => part.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
	const base = `${NAMESPACE}${clean(serverId)}__${clean(toolName)}`;
	let name = base.length <= MAX_TOOL_NAME ? base : base.slice(0, MAX_TOOL_NAME);
	for (let n = 2; taken.has(name); n++) {
		const suffix = `_${n}`;
		name = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
	}
	return name;
}

/**
 * Discovers MCP servers from global settings (`openvsChat.mcp.servers`) and a project file
 * (`.openvs/mcp.json` or `.vscode/mcp.json`), connects to them, and exposes their tools to
 * the agent under namespaced names. stdio servers only start in a trusted workspace.
 */
export class McpManager implements McpToolset, vscode.Disposable {
	private readonly clients = new Map<string, McpClient>();
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
			if (!cfg.command && !cfg.url) {
				this.status.push(`${id}: skipped (needs a "command" for a local server, or a "url" for a remote one).`);
				continue;
			}
			// The trust gate covers remote servers too, not only spawned ones: a `url` in a
			// project's own mcp.json points the agent's tool calls — and whatever ends up in
			// their arguments — at an endpoint the workspace chose.
			if (!vscode.workspace.isTrusted) {
				this.status.push(`${id}: skipped (workspace not trusted).`);
				continue;
			}
			await this.startServer(id, cfg, generation);
		}
		if (this.generation === generation) {
			this.started = true;
		}
	}

	private async startServer(id: string, cfg: McpServerConfig, generation: number): Promise<void> {
		const remote = !!cfg.url;
		const client: McpClient = remote
			? new McpHttpClient({
				url: cfg.url!,
				headers: Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, expandEnv(String(v))])),
			})
			: new McpStdioClient({
				command: cfg.command!,
				args: cfg.args,
				env: cfg.env,
				cwd: cfg.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
			} satisfies McpStdioConfig);
		try {
			await client.start();
			const tools = await client.listTools();
			if (this.generation !== generation) {
				client.dispose();
				return; // a reconnect happened while this server was handshaking
			}
			this.clients.set(id, client);
			let renamed = 0;
			for (const tool of tools) {
				if (typeof tool?.name !== 'string' || !tool.name.trim()) {
					continue; // a server that advertises a nameless tool cannot have it called
				}
				const namespaced = safeToolName(id, tool.name, new Set(this.routes.keys()));
				if (namespaced !== `${NAMESPACE}${id}__${tool.name}`) {
					renamed++;
				}
				// The route carries the server's ORIGINAL tool name: that is what goes back on
				// the wire to the server, and it is not what the model was shown.
				this.routes.set(namespaced, { server: id, tool: tool.name, readOnly: tool.annotations?.readOnlyHint === true });
				this.toolSpecs.push({
					name: namespaced,
					description: `[MCP:${id}] ${tool.description ?? tool.name}`,
					parameters: isSchemaObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
				});
			}
			this.status.push(`${id}: connected over ${remote ? 'HTTP' : 'stdio'} (${tools.length} tools${renamed ? `, ${renamed} renamed to fit provider limits` : ''}).`);
		} catch (err) {
			client.dispose();
			this.status.push(`${id}: failed — ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	tools(): ToolSpec[] {
		return this.toolSpecs;
	}

	/** Test seam: the namespaced names currently offered, for asserting they are wire-legal. */
	toolNames(): string[] {
		return [...this.routes.keys()];
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
