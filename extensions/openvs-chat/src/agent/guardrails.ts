/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * When the agent stops for permission, laxest last:
 * - `always` — every write and every command is confirmed.
 * - `auto-edits` — file edits inside the workspace go through; commands are confirmed.
 * - `yolo` — nothing is confirmed; only the hard guardrails below still apply.
 *
 * Read-only tools have never prompted under any policy, which is what retired the former
 * fourth rung `auto-readonly`: it was indistinguishable from `always` in behaviour while
 * its label implied that `always` prompted for reads.
 */
export type ApprovalPolicy = 'always' | 'auto-edits' | 'yolo';

/** The shipped policy, used for an unset or unrecognized setting. */
export const DEFAULT_APPROVAL: ApprovalPolicy = 'auto-edits';

/** Every policy the setting and the webview picker accept, strictest first. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['always', 'auto-edits', 'yolo'];

/**
 * Reads a stored policy. A value written by an older build (`auto-readonly`) resolves to
 * the rung that matches how it actually behaved, rather than falling through to the
 * default and quietly *loosening* a setting the user chose to tighten.
 */
export function parseApprovalPolicy(raw: string | undefined): ApprovalPolicy {
	const value = (raw ?? '').trim();
	if ((APPROVAL_POLICIES as readonly string[]).includes(value)) {
		return value as ApprovalPolicy;
	}
	return value === 'auto-readonly' ? 'always' : DEFAULT_APPROVAL;
}

/** Hard, code-enforced limits on what the agent's tools may do (vs. soft "rules"). */
export interface Guardrails {
	readonly approval: ApprovalPolicy;
	readonly deniedCommands: RegExp[];
	readonly allowedCommands: RegExp[];
	readonly protectedPaths: string[];
	readonly commandTimeoutMs: number;
	readonly maxSubagents: number;
	readonly maxSubagentDepth: number;
	readonly parallelResearch: boolean;
	/** Shell `run_command` executes through; empty means the platform default. */
	readonly shell: string;
}

function compile(patterns: string[]): RegExp[] {
	const out: RegExp[] = [];
	for (const p of patterns) {
		try {
			out.push(new RegExp(p, 'i'));
		} catch {
			// Skip invalid user-supplied patterns rather than failing the whole run.
		}
	}
	return out;
}

/** Reads the guardrail configuration from settings. */
export function loadGuardrails(): Guardrails {
	const cfg = vscode.workspace.getConfiguration('openvsChat');
	return {
		approval: parseApprovalPolicy(cfg.get<string>('guardrails.approval')),
		deniedCommands: compile(cfg.get<string[]>('guardrails.deniedCommands') ?? []),
		allowedCommands: compile(cfg.get<string[]>('guardrails.allowedCommands') ?? []),
		protectedPaths: cfg.get<string[]>('guardrails.protectedPaths') ?? [],
		commandTimeoutMs: cfg.get<number>('agent.commandTimeoutMs') ?? 60_000,
		maxSubagents: cfg.get<number>('agent.maxSubagents') ?? 4,
		maxSubagentDepth: cfg.get<number>('agent.maxSubagentDepth') ?? 2,
		parallelResearch: cfg.get<boolean>('agent.parallelResearch') ?? true,
		shell: cfg.get<string>('agent.shell')?.trim() ?? '',
	};
}

export interface GuardrailCheck {
	readonly ok: boolean;
	readonly reason?: string;
}

/** Validates a shell command against the deny-list and (if set) the allow-list. */
export function checkCommand(command: string, g: Guardrails): GuardrailCheck {
	const cmd = command.trim();
	for (const re of g.deniedCommands) {
		if (re.test(cmd)) {
			return { ok: false, reason: `Command blocked by a guardrail (matches /${re.source}/). Adjust openvsChat.guardrails.deniedCommands to allow it.` };
		}
	}
	if (g.allowedCommands.length && !g.allowedCommands.some(re => re.test(cmd))) {
		return { ok: false, reason: 'Command blocked: an allow-list is configured (openvsChat.guardrails.allowedCommands) and this command does not match it.' };
	}
	return { ok: true };
}

/** Converts a simple glob (supports `*`) to an anchored, case-insensitive RegExp. */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
	return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Normalizes a model-supplied workspace-relative path into the form both the guardrail
 * check and the filesystem resolution use.
 *
 * Only leading separators and `./` segments are removed. A leading dot must survive: a
 * regex like `/^[./\\]+/` also eats the dot of a dotfile, so `.env` became `env`,
 * `.gitignore` became `gitignore` and `.github/workflows/ci.yml` was written to
 * `github/workflows/ci.yml` — silently, and at a path the guardrail never inspected,
 * because the two sites normalized differently. `..` is deliberately preserved so
 * {@link checkPath} can reject the escape rather than quietly rebasing it into the root.
 */
export function normalizeWorkspacePath(relativePath: string): string {
	let clean = relativePath.trim().replace(/\\/g, '/');
	// Looped rather than a single pass: the two prefixes can interleave (`.//./src`), and
	// `^\.\/` can never match `../`, so `..` still reaches the escape check intact.
	for (let previous = ''; clean !== previous;) {
		previous = clean;
		clean = clean.replace(/^\/+/, '').replace(/^\.\//, '');
	}
	return clean;
}

/**
 * A model-supplied path resolved onto a specific workspace folder.
 *
 * Multi-root workspaces are why this exists. `search_files` and `glob_files` report matches
 * through {@link describeWorkspaceUri}, which prefixes the folder name exactly as the editor
 * does — so with two folders open a hit reads `api/src/index.ts`. Resolving that against
 * `workspaceFolders[0]` (the old behaviour, and the only one the tools had) looked for
 * `<folder0>/api/src/index.ts`, which does not exist: every search result in a multi-root
 * workspace pointed at a path the very next `read_file` could not open.
 */
export interface WorkspacePath {
	/** Root of the workspace folder this path belongs to. */
	readonly root: vscode.Uri;
	/** Normalized path inside that folder; `.` for the folder itself. */
	readonly relative: string;
	/** The file or folder itself. */
	readonly uri: vscode.Uri;
	/** How the path is echoed back to the model — folder-prefixed when several are open. */
	readonly display: string;
}

/**
 * Whether a path is a Windows one, judged by its own shape rather than by `process.platform`
 * — this module is otherwise free of Node globals, and a web extension host has no `process`
 * at all.
 */
function isWindowsPath(path: string): boolean {
	return /^[a-zA-Z]:/.test(path);
}

/** Case-insensitive for Windows paths, where the same folder is reachable under either casing. */
function samePathPrefix(child: string, parent: string): boolean {
	const fold = isWindowsPath(parent) || isWindowsPath(child);
	const c = fold ? child.toLowerCase() : child;
	const p = (fold ? parent.toLowerCase() : parent).replace(/[/\\]+$/, '');
	return c === p || c.startsWith(p + '/') || c.startsWith(p + '\\');
}

/**
 * The workspace folder containing `path`, preferring the longest match.
 *
 * Longest rather than first because VS Code permits nested folders (`/repo` and
 * `/repo/packages/api` both open). Taking whichever came first made a file's reported path
 * depend on the order the user happened to add them; the innermost folder is the one whose
 * name the user would recognize, and it is stable.
 */
function folderContaining(path: string, folders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | undefined {
	let best: vscode.WorkspaceFolder | undefined;
	let bestLength = -1;
	for (const folder of folders) {
		const root = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
		if (samePathPrefix(path, root) && root.length > bestLength) {
			best = folder;
			bestLength = root.length;
		}
	}
	return best;
}

/** Builds a {@link WorkspacePath} for `relative` inside `folder`. */
function inFolder(folder: vscode.WorkspaceFolder, relative: string, multiRoot: boolean): WorkspacePath {
	const clean = normalizeWorkspacePath(relative) || '.';
	return {
		root: folder.uri,
		relative: clean,
		uri: vscode.Uri.joinPath(folder.uri, clean),
		display: multiRoot ? (clean === '.' ? folder.name : `${folder.name}/${clean}`) : clean,
	};
}

/**
 * Resolves a path the model supplied onto the workspace folder it belongs to, or undefined
 * when there is no workspace or the path is empty.
 *
 * Three forms are accepted, in order: an absolute path inside one of the folders (models do
 * emit these, and rebasing one onto the root used to produce a nonsense path that simply
 * failed to open); a `folderName/…` path, which is the form search and glob results take
 * when several folders are open; and finally a plain relative path, which belongs to the
 * first folder exactly as it always has.
 *
 * The folder-name branch is skipped entirely for single-root workspaces, so the common case
 * behaves identically to before. With several folders open, a first segment that happens to
 * match a folder's name wins over a same-named directory inside the first folder — the
 * ambiguity is unavoidable, and this direction is the one that makes search results usable.
 */
export function resolveWorkspacePath(rawPath: string): WorkspacePath | undefined {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (!folders.length) {
		return undefined;
	}
	const multiRoot = folders.length > 1;
	const raw = rawPath.trim().replace(/\\/g, '/');

	// An absolute path is only honoured when it actually lands inside a folder; anything
	// else falls through and is treated as relative, so `/etc/passwd` still normalizes to
	// `etc/passwd` and is then reported as missing rather than read.
	if (/^([a-zA-Z]:\/|\/)/.test(raw)) {
		const folder = folderContaining(raw, folders);
		if (folder) {
			return inFolder(folder, raw.slice(folder.uri.fsPath.replace(/\/+$/, '').length), multiRoot);
		}
	}

	const clean = normalizeWorkspacePath(rawPath);
	if (!clean) {
		return undefined;
	}
	if (multiRoot) {
		const slash = clean.indexOf('/');
		const head = slash === -1 ? clean : clean.slice(0, slash);
		const folder = folders.find(f => f.name === head);
		if (folder) {
			return inFolder(folder, slash === -1 ? '.' : clean.slice(slash + 1), multiRoot);
		}
	}
	return inFolder(folders[0], clean, multiRoot);
}

/**
 * Describes a URI the editor produced (a search or glob hit) as a {@link WorkspacePath}, or
 * undefined when it lies outside every workspace folder.
 *
 * The counterpart of {@link resolveWorkspacePath}: what this renders as `display` is exactly
 * what that function parses back, so a path the agent is shown is always a path it can then
 * open. Written here rather than via `asRelativePath` so both directions share one
 * implementation and cannot drift apart.
 */
export function describeWorkspaceUri(uri: vscode.Uri): WorkspacePath | undefined {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const target = uri.fsPath.replace(/\\/g, '/');
	const folder = folderContaining(target, folders);
	if (!folder) {
		return undefined;
	}
	const root = folder.uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
	return inFolder(folder, target.slice(root.length), folders.length > 1);
}

/**
 * Validates a workspace-relative path: it must resolve to somewhere inside the workspace
 * root (no `..` escape), and — for writes — must not match a protected path pattern.
 */
export function checkPath(root: vscode.Uri, relativePath: string, forWrite: boolean, g: Guardrails): GuardrailCheck {
	const clean = normalizeWorkspacePath(relativePath);
	if (!clean) {
		return { ok: false, reason: 'An empty path was supplied.' };
	}
	const target = vscode.Uri.joinPath(root, clean);
	const rootPath = root.fsPath.replace(/[/\\]+$/, '');
	if (target.fsPath !== rootPath && !target.fsPath.startsWith(rootPath + '/') && !target.fsPath.startsWith(rootPath + '\\')) {
		return { ok: false, reason: `Path "${relativePath}" escapes the workspace root and was blocked.` };
	}
	if (forWrite) {
		const segments = clean.split(/[/\\]+/).filter(Boolean);
		const basename = segments[segments.length - 1] ?? '';
		for (const pattern of g.protectedPaths) {
			const re = globToRegExp(pattern);
			if (segments.some(seg => re.test(seg)) || re.test(basename) || re.test(clean)) {
				return { ok: false, reason: `Writing "${relativePath}" is blocked: it matches a protected path (${pattern}).` };
			}
		}
	}
	return { ok: true };
}

/** Whether a side-effecting tool should auto-approve under the current policy. */
export function autoApproves(g: Guardrails): boolean {
	return g.approval === 'yolo';
}

/**
 * Whether file edits (create/overwrite inside the workspace) auto-approve under the
 * current policy. Protected paths and workspace-root confinement still apply.
 */
export function autoApprovesWrites(g: Guardrails): boolean {
	return g.approval === 'yolo' || g.approval === 'auto-edits';
}
