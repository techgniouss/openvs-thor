/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';

/** A resolved shell for `run_command`, and how to describe it to the model. */
export interface ResolvedShell {
	/** Passed to `spawn`'s `shell` option; undefined means the platform default. */
	readonly path: string | undefined;
	/** One line for the environment snapshot, telling the model which syntax to write. */
	readonly description: string;
}

/**
 * Candidate Git-for-Windows Bash locations, in the order the installers use them.
 * `bin/bash.exe` rather than `usr/bin/bash.exe`: the former sets up the MSYS PATH, so
 * `ls`, `grep`, `sed` and friends resolve — which is the entire point of choosing it.
 */
function gitBashCandidates(): string[] {
	const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
	const paths: string[] = [];
	for (const root of roots) {
		if (root) {
			paths.push(`${root}\\Git\\bin\\bash.exe`);
			paths.push(`${root}\\Programs\\Git\\bin\\bash.exe`);
		}
	}
	return paths;
}

let cached: ResolvedShell | undefined;

/**
 * The shell `run_command` executes through.
 *
 * On Windows the platform default is `cmd.exe`, and that was a standing tax on every run:
 * models write POSIX (`ls`, `grep`, `cat x | head`, `2>/dev/null`, `$(…)`) by overwhelming
 * default, cmd.exe rejects all of it, and the model spends steps rediscovering that instead
 * of doing the task. Git Bash ships with the Git that VS Code already requires, so preferring
 * it when present makes the commands models actually emit simply work. PowerShell is the
 * fallback — still far more capable than cmd.exe — and cmd.exe is only reached when neither
 * exists.
 *
 * An explicit `openvsChat.agent.shell` always wins and is never probed.
 */
export function resolveAgentShell(configured: string): ResolvedShell {
	const explicit = configured.trim();
	if (explicit) {
		return { path: explicit, description: `${explicit} (set by openvsChat.agent.shell)` };
	}
	if (process.platform !== 'win32') {
		return { path: undefined, description: '/bin/sh (POSIX)' };
	}
	if (!cached) {
		cached = probeWindowsShell();
	}
	return cached;
}

/** Resets the memoized Windows probe. Test seam; also lets a settings change re-probe. */
export function resetShellCache(): void {
	cached = undefined;
}

function probeWindowsShell(): ResolvedShell {
	for (const candidate of gitBashCandidates()) {
		if (existsSync(candidate)) {
			return {
				path: candidate,
				description: 'Git Bash on Windows — write POSIX shell syntax (ls, grep, cat, pipes, 2>&1). '
					+ 'Paths use forward slashes; a Windows drive path like C:/repo/src works as-is.',
			};
		}
	}
	const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
	if (existsSync(powershell)) {
		return {
			path: powershell,
			description: 'Windows PowerShell — write PowerShell syntax. `&&` and `||` do NOT work: '
				+ 'use `;` to chain, or `if ($?) { … }` to chain on success. No `head`/`tail`/`grep` — '
				+ 'use `Select-Object -First N`, `-Last N`, `Select-String`.',
		};
	}
	return { path: undefined, description: 'cmd.exe (Windows) — use Windows command syntax, not POSIX' };
}
