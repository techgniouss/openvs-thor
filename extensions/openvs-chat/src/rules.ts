/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const MAX_RULES_CHARS = 12_000;

/**
 * Assembles the always-on "rules" that steer the assistant: the `openvsChat.rules` setting
 * plus any auto-discovered rule files in the workspace (e.g. `AGENTS.md`,
 * `.github/copilot-instructions.md`, `.cursorrules`). Read fresh on each request so edits
 * take effect immediately. These are soft guidance (prompt-level); hard limits live in
 * `agent/guardrails.ts`.
 */
export class RulesProvider {
	/** Returns the combined rules block, or '' if none are configured. */
	async getRules(): Promise<string> {
		const cfg = vscode.workspace.getConfiguration('openvsChat');
		const parts: string[] = [];

		const inline = cfg.get<string>('rules')?.trim();
		if (inline) {
			parts.push(inline);
		}

		const fileNames = cfg.get<string[]>('ruleFiles') ?? [];
		// Every workspace folder is probed, not just the first. A multi-root workspace is
		// several projects, and the rules of the second one are exactly as binding as the
		// first's — reading only `workspaceFolders[0]` silently ignored them. The folder is
		// named in the heading when there is more than one, so the model can tell whose
		// rules it is reading. (`detectVerificationCommands` already probes all folders;
		// this brings rule discovery in line with it.)
		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of folders) {
			for (const name of fileNames) {
				const text = await this.tryReadFile(folder.uri, name);
				if (text) {
					const label = folders.length > 1 ? `${folder.name}/${name}` : name;
					parts.push(`# Rules from ${label}\n${text}`);
				}
			}
		}

		const joined = parts.join('\n\n').trim();
		if (joined.length > MAX_RULES_CHARS) {
			return joined.slice(0, MAX_RULES_CHARS) + '\n\n…[rules truncated]';
		}
		return joined;
	}

	/**
	 * Composes a full system prompt: the base/identity prompt leads, with project rules
	 * appended after it. Used as the foundation every mode builds on.
	 */
	async composeSystem(base: string): Promise<string> {
		const rules = await this.getRules();
		if (!rules) {
			return base;
		}
		return `${base}\n\n## Project rules (must follow)\n${rules}`;
	}

	private async tryReadFile(root: vscode.Uri, name: string): Promise<string | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
			return new TextDecoder().decode(bytes).trim() || undefined;
		} catch {
			return undefined; // file not present — that's fine
		}
	}
}
