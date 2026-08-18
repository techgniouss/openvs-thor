/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for Phase 7a — the remote approval floor. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-approval-floor.mjs
//
// Two things have to be true for this interlock to actually close the gap the plan describes
// ("a remotely-initiated Agent run inherits whatever the local guardrails.approval is —
// including yolo — which means zero approval cards"):
//
//   1. `applyApprovalFloor` itself resolves every (configured, floor) pair correctly for a
//      remote run, and never touches a local run's own setting.
//   2. Every place that actually builds the `Guardrails` a run executes under — `handleSend`
//      (the plain Agent + read-only tool loop path) and `handleAutoSend` (Auto's implementer
//      phase) — really does route through it, not just in the abstract.
//
// (1) is a runtime check against the compiled function. (2) is a static source pin, in the
// style `test-send-history.mjs` already established for `chatViewProvider.ts`'s `handleSend`:
// a regex over the method body rather than a runtime check, because what's being pinned is
// that a *future* edit — a third send path, or a refactor of one of these two — can't quietly
// stop applying the floor without failing this test. `chatViewProvider.ts` factors the actual
// `loadGuardrails()` + `applyApprovalFloor(...)` call into one shared private method,
// `guardrailsForRun`, rather than duplicating that logic (config reads, the "unset floor
// defaults to auto-edits, not yolo" fallback) at each call site — so the pin is two-step:
// each send path's body must call `guardrailsForRun`, and `guardrailsForRun`'s own body must
// call `applyApprovalFloor`. Composed, that is exactly "handleSend and handleAutoSend call
// applyApprovalFloor", just not as a single textual substring match.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';

// guardrails.ts imports `vscode` at module scope (for loadGuardrails/checkPath/etc., none of
// which `applyApprovalFloor` itself touches), so the compiled module still needs a stub to
// load at all — same reason test-tools.mjs stubs it before importing from '../out/agent/tools.js'.
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : load.call(this, request, ...rest);
};

const { APPROVAL_POLICIES, applyApprovalFloor } = await import(new URL('../out/agent/guardrails.js', import.meta.url));

// 1a. Every (configured, floor) pair across the 3-value enum, origin: 'remote' — assert the
// stricter policy wins. Strictness order: always > auto-edits > yolo.
{
	const rank = { always: 0, 'auto-edits': 1, yolo: 2 };
	assert.deepStrictEqual([...APPROVAL_POLICIES].sort((a, b) => rank[a] - rank[b]), ['always', 'auto-edits', 'yolo'],
		'this test assumes APPROVAL_POLICIES covers exactly always/auto-edits/yolo — update the rank table if that ever changes');

	for (const configured of APPROVAL_POLICIES) {
		for (const floor of APPROVAL_POLICIES) {
			const expected = rank[configured] <= rank[floor] ? configured : floor;
			const actual = applyApprovalFloor(configured, 'remote', floor);
			assert.strictEqual(actual, expected,
				`applyApprovalFloor(${configured}, 'remote', ${floor}) should be ${expected} (the stricter of the two), got ${actual}`);
		}
	}
}

// 1b. origin: 'local' always returns `configured` unchanged, regardless of `floor` — a local
// (webview) run must never be affected by the remote floor. Covers all 9 pairs too, since the
// bug this guards against is "floor leaks into local" for any particular floor value, not just
// the default.
{
	for (const configured of APPROVAL_POLICIES) {
		for (const floor of APPROVAL_POLICIES) {
			const actual = applyApprovalFloor(configured, 'local', floor);
			assert.strictEqual(actual, configured,
				`applyApprovalFloor(${configured}, 'local', ${floor}) must return ${configured} unchanged, got ${actual} — ` +
				'a local run regressing because of the remote floor is the one constraint this feature must not slip');
		}
	}
}

// 2. Static pin: the two guardrails-construction points that matter — handleSend (plain Agent
// + read-only tool loop) and handleAutoSend (Auto's implementer phase) — must each resolve
// their Guardrails through applyApprovalFloor. See this file's header for why the pin is
// two-step rather than a single substring match.
{
	const host = fs.readFileSync(new URL('../src/chatViewProvider.ts', import.meta.url), 'utf8');

	const methodBody = (name) => {
		const re = new RegExp(`private (?:async )?${name}\\([\\s\\S]*?\\n\\tprivate `);
		const match = re.exec(host)?.[0] ?? '';
		assert.ok(match, `expected to find ${name}'s body in chatViewProvider.ts`);
		return match;
	};

	const handleSend = methodBody('handleSend');
	const handleAutoSend = methodBody('handleAutoSend');
	const guardrailsForRun = methodBody('guardrailsForRun');

	assert.ok(/\bthis\.guardrailsForRun\(origin\)/.test(handleSend),
		'handleSend must resolve its Guardrails via guardrailsForRun(origin) — this is the exact ' +
		'point a Guardrails value is produced for the plain Agent / read-only tool loop path');
	assert.ok(/\bthis\.guardrailsForRun\(origin\)/.test(handleAutoSend),
		'handleAutoSend must resolve its Guardrails via guardrailsForRun(origin) too — Auto\'s ' +
		'implementer phase runs a real write/command-capable agent loop, and it would be a real ' +
		'gap if only the plain Agent path got the floor');
	assert.ok(/\bapplyApprovalFloor\(/.test(guardrailsForRun),
		'guardrailsForRun must actually call applyApprovalFloor — otherwise both send paths ' +
		'above route through a method that resolves the floor in name only');

	// Both call sites must pass the Guardrails they resolved into the runner they construct,
	// not merely compute it and drop it — a regression that would silently make this whole
	// feature a no-op while every static pin above still passes. `runAgent`/`runReadOnlyAgent`
	// both take `guardrails` as their trailing argument; `new AutoOrchestrator(...)` takes it
	// as its trailing constructor argument.
	assert.ok(/runAgent\(provider, messages, \{ \.\.\.params, signal: controller\.signal \}, post, sessionId, runId, keepHead, guardrails\)/.test(handleSend),
		'handleSend must pass the resolved guardrails as the trailing argument to runAgent(...)');
	assert.ok(/new AutoOrchestrator\([\s\S]*?,\s*guardrails\);/.test(handleAutoSend),
		'handleAutoSend must pass the resolved guardrails as the trailing argument to new AutoOrchestrator(...)');
}

console.log('test-approval-floor: all assertions passed');
