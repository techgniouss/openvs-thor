/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Regression test for a real bug found and fixed while auditing Phase 6a: after the ownership
// flip (Phase 2), `send` stopped carrying the whole conversation, but nothing was ever added to
// append the new turn into `SessionStore` before `handleSend` read history back out of it — so
// every send silently sent the model whatever history predated it, never what the user just
// typed. A second, adjacent bug rode along: `trackSessionSend` was still writing
// `sendableMessages()`'s *flattened* view (compaction summary collapsed into a synthetic user
// turn) back over the session's raw transcript, which would have permanently baked that
// synthetic turn in and discarded `compactedUpTo`'s meaning for any session that ever compacted.
//
// Neither bug was caught by any existing suite: `test-webview.mjs` only checks message *shapes*,
// and `test-session-store.mjs` only checks `SessionStore` in isolation — nothing exercised the
// sequence `chatViewProvider.ts` actually performs. This file closes that gap two ways: a static
// pin on the source (so the destructive call can't quietly come back) and a runtime replay of
// the exact store sequence `handleSend` now performs, across a compaction.
//
// Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-send-history.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SessionStore } from '../out/session/store.js';

const host = fs.readFileSync(new URL('../src/chatViewProvider.ts', import.meta.url), 'utf8');

// 1. Static pin: the destructive call must never come back. `trackSessionSend` no longer
// receives a `sanitized`/`history` array to write back — if a future edit reintroduces an
// actual `this.sessionStore.replaceMessages(...)` call, it is reintroducing exactly the
// corruption this test exists to prevent. Matched as a real call site, not the word appearing
// in a comment explaining why it was removed (which this very file's docs now do, on purpose).
{
	assert.ok(!/\bthis\.sessionStore\.replaceMessages\(/.test(host),
		'chatViewProvider.ts must never write sendableMessages()\'s flattened view back over ' +
		'the session store\'s raw transcript — see this file\'s header for what that corrupts');
}

// 2. Static pin: `handleSend` must still seed the session and append the new turn ahead of
// computing history, in that order — a regex over the method body rather than a runtime check,
// since the ordering (not just the presence) of these two calls is what makes the fix correct.
{
	const method = /private async handleSend\([\s\S]*?\n\tprivate /.exec(host)?.[0] ?? '';
	assert.ok(method, 'expected to find handleSend\'s body');
	const seedAt = method.indexOf('seedSession(sessionId');
	const appendAt = method.indexOf('appendMessage(sessionId');
	const sendableAt = method.indexOf('sendableMessages(sessionId)');
	assert.ok(seedAt >= 0, 'handleSend must seed the session before reading history back out of it');
	assert.ok(appendAt >= 0, 'handleSend must append the new turn (text/images) into the store');
	assert.ok(sendableAt >= 0, 'handleSend must read history from the store');
	assert.ok(seedAt < appendAt && appendAt < sendableAt,
		'seed, then append the new turn, then read history — any other order either has ' +
		'nowhere to append into or reads history from before the new turn arrived');
}

/** A deterministic {@link SessionDeps}, matching test-session-store.mjs's own. */
function makeDeps() {
	let counter = 0;
	return { now: () => 1_000_000, newId: () => `id${counter++}` };
}

// 3. Runtime replay: the exact sequence `handleSend` performs — seed (no-op for an existing
// session), conditionally append the new turn, then read `sendableMessages()` — across two
// consecutive sends and a compaction in between, mirroring a real multi-turn conversation.
// Message counts and the `replaced` value mirror test-session-store.mjs's own known-good
// compaction scenario exactly (3 real messages, replaced=2, no prior summary → compactedUpTo
// advances to 3) — this test's point is the *next* send after that, which nothing previously
// checked: does the new turn actually show up alongside the summary, and does the raw
// transcript survive intact.
{
	const store = new SessionStore(makeDeps());
	const session = store.createSession(true, 'ask');

	// Turn 1: seed is a no-op (session already exists), then append.
	store.seedSession(session.id, 'ask');
	store.appendMessage(session.id, { role: 'user', content: 'first message' });
	assert.deepStrictEqual(
		store.sendableMessages(session.id).map(m => m.content),
		['first message'],
		'the first turn must be visible to sendableMessages immediately after being appended');

	store.appendMessage(session.id, { role: 'assistant', content: 'first reply' });
	store.appendMessage(session.id, { role: 'user', content: 'second message' });

	// A compaction happens: all three turns above are replaced by a summary.
	store.applyCompaction(session.id, 'summary of the first exchange', 2);
	assert.deepStrictEqual(
		store.sendableMessages(session.id).map(m => m.content),
		['summary of the first exchange'],
		'sendableMessages should now be just the flattened summary turn');

	// Turn 2, after compaction — this is exactly where the second bug would have struck: if
	// trackSessionSend still wrote sendableMessages()'s flattened return back over the raw
	// transcript, the synthetic summary turn would be permanently baked into session.messages
	// and compactedUpTo's bookkeeping would be discarded.
	store.seedSession(session.id, 'ask');
	store.appendMessage(session.id, { role: 'user', content: 'third message' });
	assert.deepStrictEqual(
		store.sendableMessages(session.id).map(m => m.content),
		['summary of the first exchange', 'third message'],
		'the new turn must be visible alongside the summary, not lost and not duplicated');

	// The raw transcript itself must still hold every real turn, uncollapsed — this is what
	// `replaceMessages` would have destroyed.
	const rawContents = store.getSession(session.id).messages.map(m => m.content);
	assert.deepStrictEqual(rawContents, ['first message', 'first reply', 'second message', 'third message'],
		'the raw stored transcript must never be overwritten with the flattened summary view');
}

// 4. A brand-new, never-seeded session (the programmatic/inline-send edge case): seed must
// create it, not silently drop the append.
{
	const store = new SessionStore(makeDeps());
	store.seedSession('never-created', 'ask');
	store.appendMessage('never-created', { role: 'user', content: 'hello' });
	assert.deepStrictEqual(store.sendableMessages('never-created').map(m => m.content), ['hello'],
		'seedSession must make an unknown session id appendable, not a silent no-op');
}

console.log('test-send-history: all assertions passed');
