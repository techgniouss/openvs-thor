/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { resolveAgentShell } from '../agent/shell';

const CACHE_MS = 30_000;
const MAX_CHARS = 1_500;
const MAX_STATUS_LINES = 20;
const MAX_OPEN_TABS = 15;

let cached: { at: number; text: string } | undefined;

/** Runs git with the given args in `cwd`, resolving to stdout or '' on any failure. */
function git(cwd: string, args: string[]): Promise<string> {
	return new Promise(resolve => {
		execFile('git', args, { cwd, timeout: 3_000, maxBuffer: 64_000 }, (err, stdout) => {
			resolve(err ? '' : stdout.trim());
		});
	});
}

/** Strips ANSI escapes and control characters so repo-controlled text (branch names, paths) cannot smuggle formatting or fake instructions into the prompt. */
function sanitize(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Describes the shell `run_command` will use, so the model writes compatible syntax. */
function agentShell(): string {
	const configured = vscode.workspace.getConfiguration('openvsChat').get<string>('agent.shell') ?? '';
	return resolveAgentShell(configured).description;
}

/** Filenames of open editor tabs, active-first, capped. */
function openTabs(): string[] {
	const names: string[] = [];
	const active = vscode.window.activeTextEditor?.document.uri.toString();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.input instanceof vscode.TabInputText) {
				const uri = tab.input.uri;
				const rel = sanitize(vscode.workspace.asRelativePath(uri));
				if (uri.toString() === active) {
					names.unshift(rel);
				} else {
					names.push(rel);
				}
			}
		}
	}
	return [...new Set(names)].slice(0, MAX_OPEN_TABS);
}

/**
 * Builds the environment snapshot injected into every system prompt (Claude Code
 * style): workspace root, platform, date, git branch/status, open editor tabs.
 * Every probe fails soft (section omitted); result is cached for {@link CACHE_MS}
 * and hard-capped at {@link MAX_CHARS} characters. Git probes are skipped entirely
 * in untrusted workspaces (a malicious repo's `.git/config` can turn `git status`
 * into code execution), and all repo-derived strings (branch, status lines, open
 * tab paths) are sanitized to strip ANSI escapes and control characters before
 * being injected into the prompt.
 */
export async function buildEnvContext(): Promise<string> {
	if (cached && Date.now() - cached.at < CACHE_MS) {
		return cached.text;
	}
	const lines: string[] = [];
	const folders = vscode.workspace.workspaceFolders ?? [];
	const root = folders[0]?.uri;
	if (root?.scheme === 'file') {
		lines.push(`Workspace root: ${sanitize(root.fsPath)}`);
	} else if (root) {
		lines.push(`Workspace root: ${sanitize(root.toString())} (virtual)`);
	}
	// Without this the model never learns the other folders exist, so it addresses every
	// path to the first one — and the tools, which do resolve a folder-name prefix, are
	// left with no way to be told which folder was meant.
	if (folders.length > 1) {
		lines.push(
			`Workspace folders: ${folders.map(f => sanitize(f.name)).join(', ')}. `
			+ `Prefix a path with the folder name to reach one (e.g. "${sanitize(folders[1].name)}/src/index.ts"); `
			+ `an unprefixed path means "${sanitize(folders[0].name)}", and run_command runs there unless you pass its "cwd".`);
	}
	lines.push(`Platform: ${process.platform}`);
	// run_command executes through a real shell, so the model has to emit syntax that
	// shell accepts. Left unsaid it defaults to POSIX and every command fails on Windows.
	lines.push(`Shell for run_command: ${sanitize(agentShell())}`);
	lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);

	// Never run git in an untrusted workspace: a malicious repo's .git/config
	// (core.fsmonitor, hooks, pager) can turn `git status` into code execution.
	if (root?.scheme === 'file' && vscode.workspace.isTrusted) {
		const cwd = root.fsPath;
		const branch = sanitize(await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).split('\n')[0].slice(0, 100);
		if (branch) {
			lines.push(`Git branch: ${branch}`);
			const status = await git(cwd, ['status', '--porcelain']);
			if (status) {
				const statusLines = sanitize(status).split('\n').map(l => l.slice(0, 200));
				const shown = statusLines.slice(0, MAX_STATUS_LINES);
				const more = statusLines.length > shown.length ? `\n… ${statusLines.length - shown.length} more` : '';
				lines.push(`Git status:\n${shown.join('\n')}${more}`);
			} else {
				lines.push('Git status: clean');
			}
		}
	}

	const tabs = openTabs();
	if (tabs.length) {
		lines.push(`Open editors (active first): ${tabs.join(', ')}`);
	}

	const text = lines.join('\n').slice(0, MAX_CHARS);
	cached = { at: Date.now(), text };
	return text;
}
