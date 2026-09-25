/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { ChatMessage, ChatProvider, ChatRequest, ModelEntry, ProviderInfo, StreamChatResult } from './types';

/** Binary name resolved from PATH when `openvsChat.claude-code-cli.cliPath` is unset. */
const DEFAULT_BINARY = 'claude';

/** Grace period after SIGTERM before an aborted child is force-killed with SIGKILL. */
const KILL_GRACE_MS = 3000;

/** How much of the CLI's stdout an error message may quote. */
const STDOUT_TAIL_CHARS = 500;

/** The CLI's wording when its own sign-in has lapsed. */
const AUTH_FAILURE = /authenticat|oauth|not logged in|log ?in|\/login|credential/i;

/** Model names and aliases the CLI takes (`sonnet`, `claude-opus-4-8`, `opus[1m]`, …); nothing a shell would interpret. */
const SAFE_MODEL = /^[\w.:@\[\]-]+$/;

/**
 * Provider that shells out to the user's own, already-installed Claude Code CLI (`claude`) in
 * non-interactive single-shot mode ("BYOA" — bring your own agent), so someone who already
 * pays for a Claude Code subscription can reuse it here instead of configuring a separate
 * Anthropic API key.
 *
 * **What this deliberately does NOT do**, scoped down on purpose from what a full CLI-driving
 * integration could do:
 *  - No live tool execution in the workspace. The CLI runs once per request in `-p`/`--print`
 *    mode and exits; it is never handed the workspace to act in.
 *  - No parsing or replaying of the CLI's own tool-call/edit events. Whatever the CLI did
 *    internally to produce its answer stays internal — only the final text comes back, exactly
 *    like any other `streamChat` implementation.
 *  - Never wired into this extension's own Agent-mode tool loop: `info.supportsTools` is
 *    `false` and `runAgentStep` is intentionally not implemented, so Agent mode never asks this
 *    provider to call a tool. `agentRunner.ts` and `guardrails.ts` remain in full control of
 *    every actual file edit or command this extension performs, regardless of which chat
 *    provider is selected — this provider cannot bypass them.
 *
 * Single-shot only: the CLI's print mode takes one prompt and returns one final answer, with no
 * server-side conversation state to resume, so the whole conversation is flattened into one
 * prompt string on every call (see {@link buildPrompt}) — the same shape the other single-turn
 * backends in this directory (`kiro.ts`, `antigravity.ts`'s fallback) use for the same reason.
 * Attached images are not sent — the CLI's print mode takes a text prompt only, and there is no
 * multi-part message format to put them in here.
 *
 * Authentication is whatever the CLI itself already has from its own `claude login` / OAuth
 * flow — this provider never reads, stores, or touches that credential (`info.requiresApiKey`
 * is `false`); `apiKey` on {@link ChatRequest} is unused. It spawns a **local subprocess**
 * instead of calling `fetch`, a deliberate, narrow exception to the "self-contained, fetch-only"
 * rule on {@link ChatProvider} — see that interface's doc comment.
 *
 * The binary is looked up on PATH (`claude`) unless `openvsChat.claude-code-cli.cliPath` names
 * a specific location — read directly via the `vscode` config API (the same way
 * `GeminiWebProvider`'s private `enabled()` reads `webGemini.enabled`) rather than threaded
 * through {@link ChatRequest.baseUrl}, which this provider leaves unused: there is no HTTP
 * endpoint here for a base URL to name, so `registry.ts`'s `NO_BASE_URL_SETTING` keeps the
 * panel from rendering a base-URL field that would do nothing.
 */
export class ClaudeCodeCliProvider implements ChatProvider {
	readonly info: ProviderInfo = {
		id: 'claude-code-cli',
		label: 'Claude Code CLI (local)',
		// The CLI's own `--model` aliases. The user can type any model name/alias the CLI accepts.
		suggestedModels: ['sonnet', 'opus', 'haiku'],
		apiKeyUrl: '',
		requiresApiKey: false,
		supportsTools: false,
		toolModelPatterns: [],
		// Unmatchable on purpose — `buildPrompt` never sends attached images (there is no
		// multi-part message format on this wire), and an empty list here would mean the
		// opposite: `modelSupportsVision`'s documented default for an empty pattern list is
		// "assumed vision-capable", which would let the UI offer image attachments that then
		// silently vanish. Matches `antigravity.ts`'s same no-vision sentinel.
		visionModelPatterns: ['^\\x00$'],
	};

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		if (request.signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		const cliPath = vscode.workspace.getConfiguration('openvsChat').get<string>('claude-code-cli.cliPath')?.trim();
		const binary = cliPath || DEFAULT_BINARY;
		const model = request.model.trim();
		// The model becomes part of a command line (through a shell on Windows, below), so only
		// the characters real model names and aliases use are accepted.
		if (model && !SAFE_MODEL.test(model)) {
			throw new Error(`Claude Code CLI: "${model}" is not a valid model name.`);
		}
		// The prompt goes in on stdin, which `claude -p` reads when no prompt argument is given.
		// As an argument the whole conversation was one command-line entry, and Windows caps a
		// command line at ~32k characters: any chat longer than that failed to start at all.
		const prompt = buildPrompt(request.messages);
		const args = ['-p', '--output-format', 'text'];
		if (model) {
			args.push('--model', model);
		}
		// npm installs the CLI on Windows as `claude.cmd`, which Node will not spawn without a
		// shell. Only the binary is quoted; every argument is a fixed flag or the checked model.
		const viaShell = process.platform === 'win32' && !/\.(exe|com)$/i.test(binary);

		return new Promise<StreamChatResult>((resolve, reject) => {
			let child;
			try {
				// Through a shell the command is one string built here, not arguments handed to
				// `spawn`: Node deprecates the latter (DEP0190) because it only concatenates them.
				child = viaShell
					? spawn([`"${binary}"`, ...args].join(' '), { windowsHide: true, shell: true })
					: spawn(binary, args, { windowsHide: true });
			} catch (err) {
				reject(new Error(installHint(binary, err instanceof Error ? err.message : String(err))));
				return;
			}

			let aborted = false;
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let stderr = '';
			// The CLI reports some failures on stdout, not stderr — an expired sign-in prints
			// "Failed to authenticate: …" there and exits 1 — so the error keeps its tail too.
			let stdoutTail = '';

			const cleanup = (): void => {
				request.signal.removeEventListener('abort', onAbort);
				if (killTimer) {
					clearTimeout(killTimer);
				}
			};
			const settle = (fn: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				fn();
			};
			// Escalates to SIGKILL if the CLI doesn't exit promptly on SIGTERM — mirrors the
			// timeout-kill pattern `run_command` uses in `agent/tools.ts`.
			const onAbort = (): void => {
				aborted = true;
				// On Windows the CLI runs under a shell (and node under the CLI): ending the tree is
				// the only way Stop actually stops it.
				if (process.platform === 'win32' && child.pid !== undefined) {
					spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
					return;
				}
				child.kill('SIGTERM');
				killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
			};
			request.signal.addEventListener('abort', onAbort, { once: true });
			// A CLI that exits before reading all of stdin (a bad flag, say) would otherwise raise
			// EPIPE here; its exit code and stderr already say what went wrong.
			child.stdin?.on('error', () => { /* reported through 'close' */ });
			child.stdin?.end(prompt);

			// `setEncoding` (not decoding each Buffer chunk by hand) is what keeps a multi-byte
			// UTF-8 character split across two chunks from arriving as mojibake — Node's
			// StringDecoder buffers the partial trailing byte(s) internally until the rest lands.
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				stdoutTail = (stdoutTail + chunk).slice(-STDOUT_TAIL_CHARS);
				request.onToken(chunk);
			});
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

			child.on('error', err => {
				settle(() => {
					const code = (err as NodeJS.ErrnoException).code;
					reject(code === 'ENOENT'
						? new Error(installHint(binary))
						: new Error(`Claude Code CLI: failed to start (${err.message}).`));
				});
			});

			child.on('close', code => {
				settle(() => {
					if (aborted) {
						reject(new DOMException('Aborted', 'AbortError'));
						return;
					}
					if (code === 0) {
						resolve({ truncated: false });
						return;
					}
					// Measured live: with only stderr read, an expired sign-in surfaced as a bare
					// "exited with code 1", its actual reason sitting unread on stdout.
					const detail = (stderr.trim() || stdoutTail.trim()).slice(0, 500);
					const hint = AUTH_FAILURE.test(detail) ? ' Run `claude` in a terminal and sign in again (`/login`), then retry.' : '';
					reject(new Error(`Claude Code CLI exited with code ${code}${detail ? `: ${detail.replace(/[.\s]+$/, '')}.` : '.'}${hint}`));
				});
			});
		});
	}

	// No catalog to fetch — the CLI's `--model` aliases are a fixed, small, documented set.
	async listModels(): Promise<ModelEntry[]> {
		return this.info.suggestedModels.map(id => ({ id }));
	}
}

/** Friendly install/PATH guidance shown when the CLI binary can't be found or spawned. */
function installHint(binary: string, detail?: string): string {
	return `Claude Code CLI ('${binary}') was not found${detail ? ` (${detail})` : ''}. Install the Claude Code ` +
		'CLI and make sure \'claude\' is on your PATH, or set "openvsChat.claude-code-cli.cliPath" to its full path.';
}

/**
 * Flattens a conversation into one prompt string for the CLI's single-shot print mode: system
 * message(s) first as plain context, then the remaining turns labelled by role in a delimited,
 * readable transcript — there is no `messages` array on this wire, so this is the only way to
 * give the CLI prior turns at all (see the class doc).
 */
function buildPrompt(messages: ChatMessage[]): string {
	const system = messages.filter(m => m.role === 'system' && m.content.trim()).map(m => m.content.trim());
	const turns = messages.filter(m => m.role !== 'system' && m.content.trim());
	const parts: string[] = [];
	if (system.length) {
		parts.push(`System instructions:\n${system.join('\n\n')}`);
	}
	for (const m of turns) {
		const label = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool result' : 'User';
		parts.push(`${label}:\n${m.content.trim()}`);
	}
	return parts.join('\n\n---\n\n');
}
