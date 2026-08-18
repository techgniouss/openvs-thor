/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/remote/deploy.ts — the "OpenVS Thor: Remote: Deploy Your Own
// Relay" command's logic. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-deploy.mjs
//
// No real `wrangler`/Cloudflare account is available in this environment, so `deployRelay`
// takes its process runner as an injected dependency (per this repo's CLAUDE.md: "make the
// dependency injectable ... and inject a fake that implements the real interface") — most of
// these tests drive it against a fake that returns canned output instead of a real spawn, the
// same way test-remote-socket.mjs avoids a real WebSocket. The timeout/cancellation tests near
// the bottom are the exception: like test-run-command.mjs, they spawn real (short-lived)
// processes because the behavior under test — child_process kill semantics — is exactly what a
// fake would paper over.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunProcess, deployRelay, parseDeployedUrl } from '../out/remote/deploy.js';

// 1. parseDeployedUrl: pulls the workers.dev URL out of real wrangler deploy output.
{
	const output = [
		' ⛅️ wrangler 3.90.0',
		'-------------------',
		'Total Upload: 12.34 KiB / gzip: 4.56 KiB',
		'Uploaded openvs-relay (2.34 sec)',
		'Deployed openvs-relay triggers (1.23 sec)',
		'  https://openvs-relay.myaccount.workers.dev',
		'Current Version ID: abc-123',
	].join('\n');
	assert.strictEqual(parseDeployedUrl(output), 'https://openvs-relay.myaccount.workers.dev');
}

// 2. parseDeployedUrl: ignores unrelated https:// links wrangler prints alongside (docs tips,
// telemetry notices) — only a *.workers.dev URL counts as the deployed address.
{
	const output = [
		'Uploaded openvs-relay (1.00 sec)',
		'Deployed openvs-relay triggers (1.00 sec)',
		'  https://openvs-relay.myaccount.workers.dev',
		'',
		'To see more configuration options, visit https://developers.cloudflare.com/workers/wrangler/configuration/',
	].join('\n');
	assert.strictEqual(parseDeployedUrl(output), 'https://openvs-relay.myaccount.workers.dev');
}

// 3. parseDeployedUrl: no workers.dev URL present (e.g. an auth error) → undefined, never a
// guess at some other URL in the output.
{
	const output = [
		'✘ [ERROR] A request to the Cloudflare API failed.',
		'',
		'You need to be logged in to perform this action.',
		'Run `wrangler login` to authenticate, then retry.',
	].join('\n');
	assert.strictEqual(parseDeployedUrl(output), undefined);
}

/** Builds a fake process runner that records every call and answers from `script` in order. */
function fakeRunner(script) {
	const calls = [];
	const runner = async (command, cwd, input, env, signal) => {
		calls.push({ command, cwd, input, env, signal });
		const next = script[calls.length - 1];
		assert.ok(next, `fake runner got more calls (${calls.length}) than the test scripted`);
		return next;
	};
	runner.calls = calls;
	return runner;
}

const NO_PEPPER_LISTED = { code: 0, output: 'No secrets found.' }; // `wrangler secret list` when RELAY_PEPPER isn't set yet
const DEPLOYED = { code: 0, output: 'Deployed openvs-relay triggers\n  https://openvs-relay.acct.workers.dev' };

// 4. Happy path, deps already installed, no pepper set yet: list → put → deploy, in that order;
// install is never invoked; the parsed URL comes back as the result.
{
	const runProcess = fakeRunner([
		NO_PEPPER_LISTED,             // wrangler secret list
		{ code: 0, output: 'secret put ok' }, // wrangler secret put RELAY_PEPPER
		DEPLOYED,                     // wrangler deploy
	]);
	const pepperValues = [];
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: true,
		env: {},
		runProcess,
		randomPepper: () => { pepperValues.push('pepper-value'); return 'pepper-value'; },
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.url, 'https://openvs-relay.acct.workers.dev');
	assert.strictEqual(runProcess.calls.length, 3, 'install must be skipped when skipInstall is true');
	assert.match(runProcess.calls[0].command, /wrangler secret list/);
	assert.match(runProcess.calls[1].command, /wrangler secret put RELAY_PEPPER/);
	assert.strictEqual(runProcess.calls[1].input, 'pepper-value', 'the generated pepper must be piped to secret put via stdin, never as an argv string');
	assert.match(runProcess.calls[2].command, /wrangler deploy/);
	assert.strictEqual(runProcess.calls[0].cwd, '/repo/openvs-relay');
	assert.strictEqual(pepperValues.length, 1, 'the pepper is generated exactly once, not re-derived for each step');
}

// 5. skipInstall: false runs `npm install` first, before the secret-list step.
{
	const runProcess = fakeRunner([
		{ code: 0, output: 'added 42 packages' }, // npm install
		NO_PEPPER_LISTED,
		{ code: 0, output: 'ok' }, // secret put
		DEPLOYED,
	]);
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: false,
		env: {},
		runProcess,
		randomPepper: () => 'p',
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(runProcess.calls.length, 4);
	assert.match(runProcess.calls[0].command, /npm install/);
}

// 6. Install failure stops the pipeline before any secret is listed, minted, or sent anywhere.
{
	const runProcess = fakeRunner([
		{ code: 1, output: 'npm ERR! network timeout' },
	]);
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: false,
		env: {},
		runProcess,
		randomPepper: () => 'p',
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.step, 'install');
	assert.strictEqual(runProcess.calls.length, 1);
	assert.match(result.output, /npm ERR! network timeout/);
}

// 7. Secret put failure (e.g. not logged in) stops before deploy is attempted.
{
	const runProcess = fakeRunner([
		NO_PEPPER_LISTED,
		{ code: 1, output: 'You need to be logged in to perform this action.' },
	]);
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: true,
		env: {},
		runProcess,
		randomPepper: () => 'p',
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.step, 'secret');
	assert.strictEqual(runProcess.calls.length, 2, 'deploy must never run after secret put fails');
	assert.match(result.output, /logged in/);
}

// 8. Deploy exits non-zero → failure at the 'deploy' step, even if some URL-shaped text leaked
// into the output.
{
	const runProcess = fakeRunner([
		NO_PEPPER_LISTED,
		{ code: 0, output: 'ok' },
		{ code: 1, output: '✘ [ERROR] could not deploy: account suspended' },
	]);
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: true,
		env: {},
		runProcess,
		randomPepper: () => 'p',
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.step, 'deploy');
	assert.strictEqual(result.url, undefined);
}

// 9. Deploy exits zero but no workers.dev URL is found in its output → treated as a failure,
// since there is nothing to save into openvsChat.remote.relayUrl.
{
	const runProcess = fakeRunner([
		NO_PEPPER_LISTED,
		{ code: 0, output: 'ok' },
		{ code: 0, output: 'Deployed openvs-relay triggers (1.00 sec)\n(no route reported)' },
	]);
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: true,
		env: {},
		runProcess,
		randomPepper: () => 'p',
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.step, 'deploy');
}

// 10. Cloudflare credentials (API token + account id), when supplied, are passed as env to
// every wrangler invocation — never argv, matching the RELAY_PEPPER-via-stdin discipline — so
// `wrangler` authenticates non-interactively instead of needing `wrangler login`. `npm install`
// needs no Cloudflare credentials at all, so it must not receive them.
{
	const runProcess = fakeRunner([
		{ code: 0, output: 'added 1 package' }, // npm install
		NO_PEPPER_LISTED,
		{ code: 0, output: 'ok' }, // secret put
		DEPLOYED,
	]);
	const cloudflareEnv = { CLOUDFLARE_API_TOKEN: 'tok-abc', CLOUDFLARE_ACCOUNT_ID: 'acct-123' };
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: false,
		runProcess,
		randomPepper: () => 'p',
		env: cloudflareEnv,
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(runProcess.calls[0].env, undefined, 'npm install needs no Cloudflare credentials');
	assert.deepStrictEqual(runProcess.calls[1].env, cloudflareEnv, 'secret list must authenticate via the Cloudflare token/account id');
	assert.deepStrictEqual(runProcess.calls[2].env, cloudflareEnv, 'secret put must authenticate via the Cloudflare token/account id');
	assert.deepStrictEqual(runProcess.calls[3].env, cloudflareEnv, 'deploy must authenticate via the Cloudflare token/account id');
}

// 11. Gap fix: RELAY_PEPPER already present in `wrangler secret list` → put is skipped
// entirely, and the pepper generator is never even called. Rotating an existing pepper on
// every re-deploy would silently invalidate every device already paired against this relay.
{
	const runProcess = fakeRunner([
		{ code: 0, output: '┌──────────────┬──────────────┐\n│ Name         │ Type         │\n├──────────────┼──────────────┤\n│ RELAY_PEPPER │ secret_text  │\n└──────────────┴──────────────┘' },
		DEPLOYED,
	]);
	let pepperCalls = 0;
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: true,
		env: {},
		runProcess,
		randomPepper: () => { pepperCalls++; return 'should-not-be-used'; },
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(runProcess.calls.length, 2, 'secret put must be skipped when RELAY_PEPPER is already listed');
	assert.match(runProcess.calls[1].command, /wrangler deploy/, 'deploy must still run right after the list check');
	assert.strictEqual(pepperCalls, 0, 'the pepper generator must not run when nothing will consume its value');
}

// 12. `wrangler secret list` failing (e.g. no worker deployed yet at all) is treated the same
// as "no pepper yet" — the pipeline still proceeds to mint and upload one, which is what a
// first-ever deploy needs.
{
	const runProcess = fakeRunner([
		{ code: 1, output: '✘ [ERROR] script not found' },
		{ code: 0, output: 'ok' },
		DEPLOYED,
	]);
	const result = await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: true,
		env: {},
		runProcess,
		randomPepper: () => 'p',
	});
	assert.strictEqual(result.ok, true);
	assert.strictEqual(runProcess.calls.length, 3, 'a failed list must not skip minting a pepper on first deploy');
}

// 13. The cancellation signal, when supplied, is forwarded to every process invocation
// unchanged — deployRelay adds no cancellation logic of its own; a killed step's process
// simply reports a non-zero/null exit code, which the existing step-failure checks already
// catch (see the real-process tests below for the kill behavior itself).
{
	const controller = new AbortController();
	const runProcess = fakeRunner([NO_PEPPER_LISTED, { code: 0, output: 'ok' }, DEPLOYED]);
	await deployRelay({
		relayDir: '/repo/openvs-relay',
		skipInstall: true,
		env: {},
		runProcess,
		randomPepper: () => 'p',
		signal: controller.signal,
	});
	for (const call of runProcess.calls) {
		assert.strictEqual(call.signal, controller.signal);
	}
}

console.log('test-remote-deploy: fake-runner assertions passed');

// ---- Real-process tests: defaultRunProcess's timeout and cancellation kill paths -------------
// A fake ProcessRunner can't prove child_process.kill() actually happens on timeout/abort —
// only a real spawn can. Uses a temp script (not an inline `node -e`) for the same reason
// test-run-command.mjs does: shell quoting differs between Git Bash, PowerShell and cmd.exe.

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openvs-deploy-'));
const sleepScript = path.join(workspace, 'sleep.js');
fs.writeFileSync(sleepScript, "setTimeout(() => {}, 60_000); console.log('started');");

// 14. A step that runs past its timeout gets killed, not left running forever, and the result
// says so plainly rather than reporting a misleading exit code.
{
	const result = await defaultRunProcess(`node "${sleepScript}"`, workspace, undefined, undefined, undefined, 300);
	assert.notStrictEqual(result.code, 0, 'a killed process must not report a clean exit');
	assert.match(result.output, /timed out after/);
}

// 15. Aborting the signal kills the process even when the timeout is nowhere close to firing.
{
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	const result = await defaultRunProcess(`node "${sleepScript}"`, workspace, undefined, undefined, controller.signal, DEPLOY_STEP_TIMEOUT_MS_FOR_TEST());
	assert.notStrictEqual(result.code, 0, 'an aborted process must not report a clean exit');
	assert.match(result.output, /cancelled/);
}

/**
 * A timeout comfortably longer than test 15's 200ms abort, so the timeout path can't be what
 * kills it — but short enough that if `killTree` regresses (the exact bug this test caught
 * once already — see `deploy.ts`'s doc on it) the test fails in a few seconds instead of
 * hanging for the real 5-minute default.
 */
function DEPLOY_STEP_TIMEOUT_MS_FOR_TEST() { return 5_000; }

console.log('test-remote-deploy: all assertions passed');
