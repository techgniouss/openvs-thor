/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { ChildProcess, execFile, spawn } from 'child_process';

/**
 * The "OpenVS Thor: Remote: Deploy Your Own Relay" command's logic: turns the manual
 * `cd openvs-relay && npm install && npx wrangler secret put RELAY_PEPPER && npx wrangler
 * deploy` sequence into one click. There is still no *default* relay — this deploys the user's
 * own Cloudflare Worker, under their own account, same as if they had typed the commands
 * themselves; see `src/remote/config.ts`'s `getRelayUrl` doc for why that stays true.
 *
 * `vscode`-free by choice, like `socket.ts` — everything here is process orchestration with no
 * editor dependency, which is what lets `scripts/test-remote-deploy.mjs` exercise it under
 * plain node against a fake {@link ProcessRunner} instead of a real `wrangler` + Cloudflare
 * account (neither of which this environment, or CI, has).
 */

/** The result of running one child process to completion. */
export interface ProcessResult {
	/** Process exit code, or `null` if it was killed by a signal (including a timeout or cancellation — see `defaultRunProcess`'s appended `output` suffix for which). */
	code: number | null;
	/** Combined stdout+stderr, in arrival order. */
	output: string;
}

/**
 * Runs `command` in `cwd`, optionally piping `input` to its stdin (used for `wrangler secret
 * put`, which reads the secret value from stdin rather than argv so it never appears in a
 * process listing or shell history), optionally overlaying `env` on top of the process's own
 * environment (used to hand `wrangler` `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` so it
 * authenticates non-interactively instead of needing `wrangler login`), and optionally killable
 * via `signal` (wired to the progress notification's Cancel button — see `remoteDeployRelay` in
 * `extension.ts`). Injected into {@link deployRelay} so tests can supply a fake instead of
 * spawning a real process.
 */
export type ProcessRunner = (command: string, cwd: string, input?: string, env?: Record<string, string>, signal?: AbortSignal) => Promise<ProcessResult>;

/** Default per-step timeout for {@link defaultRunProcess} — `npm install`/`wrangler deploy` can be slow, but must not hang the extension host forever on a stalled network. */
export const DEPLOY_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Kills `child` and everything under it. Plain `child.kill()` is not enough here: every process
 * this module spawns goes through `shell: true` (see `defaultRunProcess`'s doc), which on
 * Windows means `child` is `cmd.exe /c <command>` — killing it terminates the shell wrapper but
 * orphans the real process (`node`, `wrangler`) running underneath, which then keeps going
 * indefinitely. `scripts/test-remote-deploy.mjs`'s timeout/abort tests caught this directly: a
 * plain `child.kill()` here left a real 60-second test hanging on an "aborted after 200ms"
 * process that never actually died. `taskkill /T` kills the whole tree; POSIX shells reparent
 * cleanly on SIGTERM, so plain `kill()` is correct there.
 */
function killTree(child: ChildProcess): void {
	if (process.platform === 'win32' && child.pid) {
		// execFile with an argv array, not exec with an interpolated string — no shell involved,
		// so there is nothing for `command`/`cwd` (already attacker-adjacent: `deployRelay`'s
		// `relayDir` is a filesystem path) to inject into even in principle.
		execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']);
	} else {
		child.kill();
	}
}

/**
 * Real {@link ProcessRunner}: spawns `command` through the shell (as `agent/tools.ts`'s
 * `runCommand` does, for the same reason — `npx`/`npm` resolve via a `.cmd` shim on Windows
 * that a shell-less `spawn` cannot locate on `PATH`). `timeoutMs` is a parameter (rather than
 * always {@link DEPLOY_STEP_TIMEOUT_MS}) purely so `scripts/test-remote-deploy.mjs` can exercise
 * the kill path in well under 5 minutes.
 */
export function defaultRunProcess(
	command: string, cwd: string, input?: string, env?: Record<string, string>,
	signal?: AbortSignal, timeoutMs: number = DEPLOY_STEP_TIMEOUT_MS,
): Promise<ProcessResult> {
	return new Promise(resolve => {
		const child = spawn(command, { cwd, shell: true, windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
		const chunks: string[] = [];
		let settled = false;
		let timedOut = false;

		const onAbort = () => { killTree(child); };
		const finish = (result: ProcessResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			resolve(result);
		};

		const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener('abort', onAbort);
			}
		}

		child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
		child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
		child.on('error', err => finish({ code: null, output: chunks.join('') + `\n${err.message}` }));
		child.on('close', code => {
			const suffix = timedOut ? `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`
				: signal?.aborted ? '\n[cancelled]'
				: '';
			finish({ code, output: chunks.join('') + suffix });
		});

		if (input !== undefined) {
			child.stdin?.write(input);
		}
		child.stdin?.end();
	});
}

/** Mints a fresh `RELAY_PEPPER` secret — same shape as `config.ts`'s room-secret minting. */
export function generatePepper(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * Extracts the deployed Worker's `*.workers.dev` URL from `wrangler deploy`'s stdout. Scoped to
 * that one domain deliberately: wrangler's own output routinely carries other `https://` links
 * alongside it (docs tips, telemetry notices) that are not the deployed address, and grabbing
 * the first URL in the text would silently save one of those instead.
 */
export function parseDeployedUrl(output: string): string | undefined {
	const match = output.match(/https:\/\/\S+\.workers\.dev\/?/);
	return match ? match[0].replace(/\/$/, '') : undefined;
}

/** Which pipeline step {@link deployRelay} failed at, for the caller's error message. */
export type DeployStep = 'install' | 'secret' | 'deploy';

export interface DeployRelayResult {
	ok: boolean;
	/** The deployed relay URL — set only when `ok` is `true`. */
	url?: string;
	/** The step that failed — set only when `ok` is `false`. */
	step?: DeployStep;
	/** Combined log of every step run, for display in an Output Channel regardless of outcome. */
	output: string;
}

export interface DeployRelayOptions {
	/** Absolute path to the `openvs-relay/` checkout. */
	relayDir: string;
	/** True when `relayDir/node_modules` already exists, so `npm install` can be skipped. */
	skipInstall: boolean;
	/**
	 * `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` — the same credential this extension's
	 * Cloudflare Workers AI provider already asks for (`openvsChat.cloudflare.accountId` +
	 * its stored API key), reused here so `wrangler` authenticates non-interactively instead
	 * of needing a `wrangler login` browser flow. Applied to every `wrangler` step, not
	 * `npm install` (which needs no Cloudflare credentials). The caller is responsible for
	 * refusing to call this function at all when the credential is missing (see
	 * `remoteDeployRelay` in `extension.ts`), since only it can point the user at where to
	 * add one.
	 */
	env: Record<string, string>;
	/** Cancels the in-flight step's process — see `defaultRunProcess`'s `signal` param. */
	signal?: AbortSignal;
	runProcess?: ProcessRunner;
	randomPepper?: () => string;
}

/**
 * Deploys the user's own relay: installs dependencies if needed, uploads a `RELAY_PEPPER`
 * secret if one isn't already set, then runs `wrangler deploy` and parses the resulting URL.
 * Stops at the first failing step — a failed `npm install` means secret and deploy would fail
 * too, and running them anyway would only produce a second, less informative error under the
 * real one. A killed step (timeout or `signal` abort) surfaces the same way: its process exits
 * with a non-zero/`null` code, which the normal step-failure check below already catches — no
 * separate cancellation path needed.
 *
 * The `RELAY_PEPPER` secret (required — see `openvs-relay/wrangler.jsonc`'s comment on it;
 * without it every pairing-code and device-token hash in `room.ts` operates on `undefined`) is
 * checked via `wrangler secret list` first and only minted+uploaded if missing. Re-deploying
 * without this check would mint a *new* pepper every run and silently invalidate every device
 * already paired against this relay (their token hashes are derived from the old one). A
 * `secret list` failure (e.g. no worker deployed yet at all) is treated the same as "no pepper
 * yet" — the safe default that matches what a first deploy needs.
 *
 * VAPID push-notification secrets are deliberately out of scope here: `room.ts` already
 * degrades gracefully without them (push simply doesn't fire), so they are not on the path to
 * a *working* relay the way `RELAY_PEPPER` is — the caller's success message points the user at
 * setting those up separately if they want push.
 */
export async function deployRelay(options: DeployRelayOptions): Promise<DeployRelayResult> {
	const runProcess = options.runProcess ?? defaultRunProcess;
	const randomPepper = options.randomPepper ?? generatePepper;
	const { relayDir, env, signal } = options;
	const log: string[] = [];

	if (!options.skipInstall) {
		const install = await runProcess('npm install', relayDir, undefined, undefined, signal);
		log.push(install.output);
		if (install.code !== 0) {
			return { ok: false, step: 'install', output: log.join('\n') };
		}
	}

	const list = await runProcess('npx --no-install wrangler secret list', relayDir, undefined, env, signal);
	log.push(list.output);
	const pepperAlreadySet = list.code === 0 && /RELAY_PEPPER/.test(list.output);

	if (!pepperAlreadySet) {
		const secret = await runProcess('npx --no-install wrangler secret put RELAY_PEPPER', relayDir, randomPepper(), env, signal);
		log.push(secret.output);
		if (secret.code !== 0) {
			return { ok: false, step: 'secret', output: log.join('\n') };
		}
	}

	const deploy = await runProcess('npx --no-install wrangler deploy', relayDir, undefined, env, signal);
	log.push(deploy.output);
	const url = parseDeployedUrl(deploy.output);
	if (deploy.code !== 0 || !url) {
		return { ok: false, step: 'deploy', output: log.join('\n') };
	}

	return { ok: true, url, output: log.join('\n') };
}
