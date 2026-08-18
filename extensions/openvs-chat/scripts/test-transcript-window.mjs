/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for SessionStore.windowedMessages / pageMessages — the transcript
// windowing/paging the "remote control" plan's "Catch-up" section describes. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-transcript-window.mjs
//
// src/session/ is `vscode`-free, so — like test-session-store.mjs — this imports the compiled
// module directly with no Module._load stub.
import assert from 'node:assert/strict';
import { DEFAULT_PAGE_COUNT, DEFAULT_TAIL_BYTES, DEFAULT_TAIL_TURNS, SessionStore } from '../out/session/store.js';

/** A deterministic {@link SessionDeps}: ids count up from 'id0'. */
function makeDeps() {
	let counter = 0;
	return { now: () => 1_000_000, newId: () => `id${counter++}` };
}

/** Appends `n` short user/assistant turns (`content` = 'm0', 'm1', ...) to a session. */
function appendTurns(store, sessionId, n) {
	for (let i = 0; i < n; i++) {
		store.appendMessage(sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
	}
}

// 1. A session shorter than the window returns everything, unwindowed.
{
	const store = new SessionStore(makeDeps());
	const s = store.getActive();
	appendTurns(store, s.id, 5);
	const window = store.windowedMessages(s.id);
	assert.deepStrictEqual(
		{ count: window.messages.length, from: window.from, truncated: window.truncated, total: window.total },
		{ count: 5, from: 0, truncated: false, total: 5 },
	);
	assert.deepStrictEqual(window.messages.map(m => m.content), ['m0', 'm1', 'm2', 'm3', 'm4']);

	// An unknown session id behaves the same as an empty one, not an error.
	assert.deepStrictEqual(store.windowedMessages('does-not-exist'), { messages: [], from: 0, truncated: false, total: 0 });
}

// 2. A session longer than tailTurns truncates on the turn count, with the right `from`.
{
	const store = new SessionStore(makeDeps());
	const s = store.getActive();
	appendTurns(store, s.id, 50);
	const window = store.windowedMessages(s.id, { tailTurns: 10, tailBytes: 1024 * 1024 });
	assert.deepStrictEqual(
		{ count: window.messages.length, from: window.from, truncated: window.truncated, total: window.total },
		{ count: 10, from: 40, truncated: true, total: 50 },
	);
	assert.deepStrictEqual(window.messages.map(m => m.content), Array.from({ length: 10 }, (_, i) => `m${40 + i}`));

	// The defaults exported for callers to reuse match the plan's numbers.
	assert.strictEqual(DEFAULT_TAIL_TURNS, 30);
	assert.strictEqual(DEFAULT_TAIL_BYTES, 48 * 1024);
}

// 3. A session where a few huge messages hit tailBytes before tailTurns truncates on the byte
// boundary instead — and still always includes at least the single most recent message, even
// when it alone exceeds the byte budget.
{
	const store = new SessionStore(makeDeps());
	const s = store.getActive();
	// Three ~20KB messages: two fit under a 48KB budget, a third would push it over.
	const big = 'x'.repeat(20 * 1024);
	store.appendMessage(s.id, { role: 'user', content: 'small lead-in' });
	store.appendMessage(s.id, { role: 'assistant', content: big });
	store.appendMessage(s.id, { role: 'user', content: big });
	store.appendMessage(s.id, { role: 'assistant', content: big });
	const window = store.windowedMessages(s.id, { tailTurns: 100, tailBytes: 48 * 1024 });
	assert.deepStrictEqual(
		{ count: window.messages.length, from: window.from, truncated: window.truncated, total: window.total },
		{ count: 2, from: 2, truncated: true, total: 4 },
		'only the last two ~20KB messages fit the 48KB budget; the byte boundary binds before tailTurns does',
	);

	// A single message alone over the byte budget is still returned, not dropped to empty.
	const store2 = new SessionStore(makeDeps());
	const s2 = store2.getActive();
	const huge = 'y'.repeat(100 * 1024);
	store2.appendMessage(s2.id, { role: 'user', content: huge });
	const window2 = store2.windowedMessages(s2.id, { tailTurns: 30, tailBytes: 48 * 1024 });
	assert.deepStrictEqual(
		{ count: window2.messages.length, from: window2.from, truncated: window2.truncated, total: window2.total },
		{ count: 1, from: 0, truncated: false, total: 1 },
	);
}

// 4. `Infinity` for either bound requests the whole transcript through the same path —
// `restoreSession`'s call site's override.
{
	const store = new SessionStore(makeDeps());
	const s = store.getActive();
	appendTurns(store, s.id, 40);
	const window = store.windowedMessages(s.id, { tailTurns: Infinity, tailBytes: Infinity });
	assert.deepStrictEqual(
		{ count: window.messages.length, from: window.from, truncated: window.truncated, total: window.total },
		{ count: 40, from: 0, truncated: false, total: 40 },
	);
}

// 5. Backward paging (`fetchTranscript`-style): the correct slice and `truncated` flag at each
// page, and paging past the beginning returns an empty page cleanly with `truncated: false`.
{
	const store = new SessionStore(makeDeps());
	const s = store.getActive();
	appendTurns(store, s.id, 25); // indices 0..24, content 'm0'..'m24'

	// First page: the caller pages backward from the start of what it already has (index 25,
	// i.e. one past the last message — matching windowedMessages' `total`).
	const page1 = store.pageMessages(s.id, { before: 25, count: 10 });
	assert.deepStrictEqual(
		{ count: page1.messages.length, from: page1.from, truncated: page1.truncated, total: page1.total },
		{ count: 10, from: 15, truncated: true, total: 25 },
	);
	assert.deepStrictEqual(page1.messages.map(m => m.content), Array.from({ length: 10 }, (_, i) => `m${15 + i}`));

	// Second page: continue backward from page1.from.
	const page2 = store.pageMessages(s.id, { before: page1.from, count: 10 });
	assert.deepStrictEqual(
		{ count: page2.messages.length, from: page2.from, truncated: page2.truncated, total: page2.total },
		{ count: 10, from: 5, truncated: true, total: 25 },
	);
	assert.deepStrictEqual(page2.messages.map(m => m.content), Array.from({ length: 10 }, (_, i) => `m${5 + i}`));

	// Third page: only 5 messages remain before index 5 — a short final page, still truncated
	// false because it reaches all the way back to the start of the transcript.
	const page3 = store.pageMessages(s.id, { before: page2.from, count: 10 });
	assert.deepStrictEqual(
		{ count: page3.messages.length, from: page3.from, truncated: page3.truncated, total: page3.total },
		{ count: 5, from: 0, truncated: false, total: 25 },
	);
	assert.deepStrictEqual(page3.messages.map(m => m.content), Array.from({ length: 5 }, (_, i) => `m${i}`));

	// Paging past the beginning (before <= 0, e.g. from page3.from) returns a clean empty page.
	const page4 = store.pageMessages(s.id, { before: page3.from, count: 10 });
	assert.deepStrictEqual(page4, { messages: [], from: 0, truncated: false, total: 25 });

	// An invalid/absent `count` falls back to the documented default.
	const defaulted = store.pageMessages(s.id, { before: 25, count: 0 });
	assert.strictEqual(defaulted.messages.length, Math.min(DEFAULT_PAGE_COUNT, 25));
	const defaulted2 = store.pageMessages(s.id, { before: 25 });
	assert.strictEqual(defaulted2.messages.length, Math.min(DEFAULT_PAGE_COUNT, 25));

	// An unknown session id is the same clean-empty-page guard as before <= 0.
	assert.deepStrictEqual(store.pageMessages('does-not-exist', { before: 25, count: 10 }), { messages: [], from: 25, truncated: false, total: 0 });
}

console.log('test-transcript-window: all assertions passed');
