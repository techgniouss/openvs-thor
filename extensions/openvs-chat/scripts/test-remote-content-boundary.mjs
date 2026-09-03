/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Static-pin regression test for a remote-control content/action boundary that had no runtime
// coverage: three places in chatViewProvider.ts read or act on the *desktop's* local editor
// state and, before the fix this test pins, either reached that action from a remote client at
// all (Edit mode) or broadcast that content to a remote sink regardless of who asked (inline,
// attachContext). `src/remote/policy.ts`'s REMOTE_DENIED explicitly lists applyEdit/
// insertAtCursor/attachContext as things a remote client must never trigger or receive — none of
// that was actually true for these three call sites.
//
// Runtime-testing chatViewProvider.ts directly needs the full vscode stub this repo's other
// static-pin tests (test-approval-floor.mjs, test-send-history.mjs) avoid for the same reason;
// this follows that established style — a regex over the relevant method body, so a future edit
// that quietly drops the guard fails here instead of only showing up as a live leak. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-content-boundary.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const host = fs.readFileSync(new URL('../src/chatViewProvider.ts', import.meta.url), 'utf8');

const methodBody = (name) => {
	const re = new RegExp(`(?:private|async) (?:async )?${name}\\([\\s\\S]*?\\n\\t(?:private|async|public) `);
	const match = re.exec(host)?.[0] ?? '';
	assert.ok(match, `expected to find ${name}'s body in chatViewProvider.ts`);
	return match;
};

// 1. Edit mode (`mode: 'edit'`) auto-applies the model's reply directly to the desktop's active
// editor with no approval prompt at all (handleApplyEdit) — it must be unreachable for anything
// but the trusted local webview sink. `setMode`/`send` are both REMOTE_ALLOWED and neither
// message type on its own is dangerous; the danger is specifically the combination
// `mode === 'edit'` + a non-local origin, checked once in handleSend ahead of both send paths
// (the plain path and handleAutoSend, which shares handleSend's `requestedMode`).
{
	const handleSend = methodBody('handleSend');
	assert.ok(/requestedMode === 'edit' && origin !== WEBVIEW_SINK_ID/.test(handleSend),
		"handleSend must refuse mode: 'edit' for any origin other than the local webview — " +
		'without this, setMode + send alone let a remote client silently rewrite the desktop\'s active file');
	// The refusal must actually bail out (via `fail`, this file's established early-return
	// helper) before any send path runs, not merely be present as a dead check.
	assert.ok(/requestedMode === 'edit' && origin !== WEBVIEW_SINK_ID\) \{\s*\n\s*fail\(/.test(handleSend),
		'the edit-mode-remote check must call fail(...) and return, not just be evaluated');
}

// 2. `runInline`'s `'inline'` message embeds the desktop's current active editor selection
// verbatim (not `content`/`preview`, so RemoteSink's own truncation never applies to it either)
// — it must go to the local webview sink alone, never `this.post`'s broadcast.
{
	const runInline = methodBody('runInline');
	assert.ok(/bus\.postTo\(WEBVIEW_SINK_ID, \{ type: 'inline'/.test(runInline),
		"runInline must send 'inline' via bus.postTo(WEBVIEW_SINK_ID, ...), not a broadcast — " +
		'otherwise every Explain/Fix/Doc/Optimize/Tests selection leaks to any connected remote device');
	assert.ok(!/this\.post\(\{ type: 'inline'/.test(runInline),
		"runInline must not also broadcast 'inline' via this.post(...)");
}

// 3. `handleAttachContext` (the *local* "Attach context" button — attachContext is
// REMOTE_DENIED) reads the whole active file with no size cap. Its remote-safe equivalent,
// handleAttachActive, already replies only to the requesting sink and truncates; this one must
// match that scoping, not broadcast.
{
	const handleAttachContext = methodBody('handleAttachContext');
	assert.ok(/bus\.postTo\(WEBVIEW_SINK_ID, \{\s*\n\s*type: 'context'/.test(handleAttachContext),
		"handleAttachContext must reply via bus.postTo(WEBVIEW_SINK_ID, ...), not a broadcast — " +
		'attachContext is REMOTE_DENIED specifically so a remote sink never sees this content');
	assert.ok(!/this\.post\(\{\s*\n\s*type: 'context'/.test(handleAttachContext),
		'handleAttachContext must not also broadcast its reply via this.post(...)');
}

console.log('test-remote-content-boundary: all assertions passed');
