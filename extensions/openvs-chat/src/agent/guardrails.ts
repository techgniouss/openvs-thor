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
