/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** Hard, code-enforced limits on what the agent's tools may do (vs. soft "rules"). */
export interface Guardrails {
	readonly approval: 'always' | 'auto-readonly' | 'auto-edits' | 'yolo';
	readonly deniedCommands: RegExp[];
	readonly allowedCommands: RegExp[];
	readonly protectedPaths: string[];
	readonly commandTimeoutMs: number;
	readonly maxSubagents: number;
	readonly maxSubagentDepth: number;
	readonly parallelResearch: boolean;
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
		approval: (cfg.get<string>('guardrails.approval') as Guardrails['approval']) || 'auto-edits',
		deniedCommands: compile(cfg.get<string[]>('guardrails.deniedCommands') ?? []),
		allowedCommands: compile(cfg.get<string[]>('guardrails.allowedCommands') ?? []),
		protectedPaths: cfg.get<string[]>('guardrails.protectedPaths') ?? [],
		commandTimeoutMs: cfg.get<number>('agent.commandTimeoutMs') ?? 60_000,
		maxSubagents: cfg.get<number>('agent.maxSubagents') ?? 4,
		maxSubagentDepth: cfg.get<number>('agent.maxSubagentDepth') ?? 2,
		parallelResearch: cfg.get<boolean>('agent.parallelResearch') ?? true,
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
 * Validates a workspace-relative path: it must resolve to somewhere inside the workspace
 * root (no `..` escape), and — for writes — must not match a protected path pattern.
 */
export function checkPath(root: vscode.Uri, relativePath: string, forWrite: boolean, g: Guardrails): GuardrailCheck {
	const clean = relativePath.replace(/^[/\\]+/, '');
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
