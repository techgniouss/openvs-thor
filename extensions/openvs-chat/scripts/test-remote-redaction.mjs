/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// `redactForRemote` (src/remote/remoteSink.ts) is the last thing every host message passes
// through before it leaves for the relay. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-redaction.mjs
import assert from 'node:assert/strict';

const { redactForRemote } = await import(new URL('../out/remote/remoteSink.js', import.meta.url));

const image = { mimeType: 'image/jpeg', data: 'A'.repeat(200_000) };

// A user turn's attached images go out as a count: a phone renders "1 image attached", and the
// base64 would otherwise cross the relay (and a cellular link) on every message.
assert.deepEqual(
	redactForRemote({ type: 'userTurn', sessionId: 's', content: 'look', images: [image] }),
	{ type: 'userTurn', sessionId: 's', content: 'look', imageCount: 1 });

// The same inside a transcript: its window is budgeted by `content` bytes alone, so images
// used to ride along unbudgeted and made a reconnect's catch-up megabytes long.
assert.deepEqual(
	redactForRemote({
		type: 'transcript', sessionId: 's', from: 0, total: 2, truncated: false,
		messages: [{ role: 'user', content: 'see', images: [image, image] }, { role: 'assistant', content: 'ok' }],
	}).messages,
	[{ role: 'user', content: 'see', imageCount: 2 }, { role: 'assistant', content: 'ok' }]);

// An editor action's prompt embeds the desktop's selected code: a phone sees that it happened,
// never the code — live, and in any transcript it later receives.
assert.doesNotMatch(
	redactForRemote({ type: 'userTurn', sessionId: 's', content: 'Explain: secretFunction()', fromEditor: true }).content,
	/secretFunction/);
assert.doesNotMatch(
	JSON.stringify(redactForRemote({ type: 'transcript', messages: [{ role: 'user', content: 'Fix: secretFunction()', fromEditor: true }] }).messages),
	/secretFunction/);
assert.equal(redactForRemote({ type: 'userTurn', content: 'typed on the desktop' }).content, 'typed on the desktop');

// Existing boundary: a provider's base URL goes out host-only.
assert.equal(
	redactForRemote({ type: 'config', providers: [{ id: 'custom', baseUrl: 'https://gw.example.com/v1?token=secret' }] }).providers[0].baseUrl,
	'gw.example.com');

console.log('test-remote-redaction: all assertions passed');
