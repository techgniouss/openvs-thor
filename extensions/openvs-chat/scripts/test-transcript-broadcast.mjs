/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Regression test for a real bug found and fixed while auditing the transcript-windowing work:
// `postTranscript`'s default window (30 turns / 48KB, added so a reconnecting *remote* client
// doesn't blow the coalescer's frame cap) was applied to `post()`'s broadcast path too — which
// reaches the local desktop webview and every other connected sink, not just the remote one the
// window exists to protect. That silently truncated the desktop panel's own chat history to the
// last 30 messages on every reload, tab switch, or clear, with no way in the UI to see further
// back. A second, adjacent instance of the same class of bug: `case 'sync':` and `case 'ready':`
// are both reachable from a remote sink (`sync`/`ready` are REMOTE_ALLOWED, and `pwa/app.js`
// sends `ready` on connect) and both broadcast — so reverting `postTranscript`'s default to full
// would, without further care, send a remote client the *entire* transcript on its own handshake,
// reintroducing the exact reliability problem windowing was meant to solve, through a different
// door.
//
// Neither half was caught by `npm test` when introduced or when fixed: nothing exercises what a
// real webview or a real remote sink actually receives. This file closes that gap with static
// pins on the source, matching test-send-history.mjs's/test-approval-floor.mjs's own style.
//
// Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-transcript-broadcast.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const host = fs.readFileSync(new URL('../src/chatViewProvider.ts', import.meta.url), 'utf8');

// 1. `postTranscript`'s own default (when a caller passes no `options`) must be unwindowed —
// `post()` broadcasts to every sink, and only the remote path has any reason to want a tail.
{
	const method = /private postTranscript\([\s\S]*?\n\t\}/.exec(host)?.[0] ?? '';
	assert.ok(method, 'expected to find postTranscript\'s body');
	assert.match(method, /options\s*\?\?\s*\{\s*tailTurns:\s*Infinity,\s*tailBytes:\s*Infinity\s*\}/,
		'postTranscript must default to the whole transcript when no options are given — a ' +
		'narrower default here silently truncates every broadcast sink, including the local ' +
		'desktop webview, which has no coalescer/frame-cap reason to ever want a tail view');
}

// 2. `case 'sync':` must reply to `origin` only (never broadcast) and must window the transcript
// for a non-local origin — both properties, together, are what keep a remote client's own
// resync from receiving the full transcript now that postTranscript's default is unwindowed.
{
	const block = /case 'sync': \{[\s\S]*?\n\t\t\t\}/.exec(host)?.[0] ?? '';
	assert.ok(block, 'expected to find the sync case body');
	assert.ok(!/this\.postTranscript\(/.test(block),
		'case \'sync\' must not call the broadcasting postTranscript — it must reply via bus.postTo');
	assert.match(block, /this\.bus\.postTo\(origin,\s*\{\s*type:\s*'transcript'/,
		'case \'sync\' must post the transcript reply to origin only, not broadcast it');
	assert.match(block, /origin === WEBVIEW_SINK_ID/,
		'case \'sync\' must classify the requester as local vs. remote before deciding the window');
}

// 3. `case 'ready':` — the same two properties, for the same reason: `ready` is REMOTE_ALLOWED
// and the PWA sends it on its own connect, so this case is just as reachable from a remote sink
// as `sync` is.
{
	const block = /case 'ready':[\s\S]*?\n\t\t\t\tbreak;/.exec(host)?.[0] ?? '';
	assert.ok(block, 'expected to find the ready case body');
	assert.ok(!/this\.postTranscript\(/.test(block),
		'case \'ready\' must not call the broadcasting postTranscript for the transcript reply');
	assert.match(block, /this\.bus\.postTo\(origin,\s*\{\s*type:\s*'transcript'/,
		'case \'ready\' must post the transcript reply to origin only, not broadcast it');
	assert.match(block, /origin === WEBVIEW_SINK_ID/,
		'case \'ready\' must classify the requester as local vs. remote before deciding the window');
}

console.log('test-transcript-broadcast: all assertions passed');
