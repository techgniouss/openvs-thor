/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the host-side session store in src/session/. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-session-store.mjs
//
// src/session/ imports nothing from `vscode` (that is the whole point of Phase 1a — the host
// is meant to own live chat sessions independently of the extension API), so unlike
// test-tools.mjs this needs no Module._load stub: the compiled modules are imported directly,
// and a plain in-memory object stands in for vscode.Memento.
import assert from 'node:assert/strict';
import { SessionStore } from '../out/session/store.js';
import { HISTORY_LIMIT, archiveSession, mergeHistory } from '../out/session/history.js';
import {
	MAX_PERSISTED_IMAGE_BYTES,
	adoptLegacyState,
	buildPersistedState,
	loadState,
	messagesForState,
	saveState,
} from '../out/session/persistence.js';

/** A deterministic {@link SessionDeps}: ids count up from 'id0', the clock only moves when told. */
function makeDeps() {
	let time = 1_000_000;
	let counter = 0;
	return {
		now: () => time,
		newId: () => `id${counter++}`,
		tick: (ms = 1) => { time += ms; },
	};
}

/** An in-memory object satisfying the real `SessionMemento` interface. */
function makeMemento() {
	const data = new Map();
	return {
		get: (key, defaultValue) => (data.has(key) ? data.get(key) : defaultValue),
		update: (key, value) => { data.set(key, value); return Promise.resolve(); },
	};
}

/** A same-size-ish base64 payload, without pulling in a real image. */
function fakeImage(bytes) {
	return { mimeType: 'image/png', data: 'x'.repeat(bytes) };
}

// 1. Chat tab lifecycle: create, switch, close (archiving into history), clear (fresh id in
// place), restore (reopening an archived conversation as a live tab).
{
	const deps = makeDeps();
	const store = new SessionStore(deps);
	const first = store.getActive();
	assert.deepStrictEqual(first, {
		id: 'id0', title: '', messages: [], streaming: false, pending: null, queue: [], todos: [], mode: 'ask',
	}, 'a fresh store starts with exactly one live, empty, active session');

	const second = store.createSession(true, 'agent');
	assert.deepStrictEqual(
		{ sessionIds: store.getSessions().map(s => s.id), activeId: store.getActiveId(), second },
		{
			sessionIds: ['id0', 'id1'],
			activeId: 'id1',
			second: { id: 'id1', title: '', messages: [], streaming: false, pending: null, queue: [], todos: [], mode: 'agent' },
		},
	);

	assert.deepStrictEqual(store.switchSession(first.id), { activeChanged: true });
	assert.strictEqual(store.getActiveId(), first.id);
	// A no-op switch, whether the target is already active or unknown, reports no change.
	assert.deepStrictEqual(store.switchSession(first.id), { activeChanged: false });
	assert.deepStrictEqual(store.switchSession('does-not-exist'), { activeChanged: false });

	store.appendMessage(second.id, { role: 'user', content: 'hello world' });
	// Closing a background tab (not the active one) archives it and leaves the active tab alone.
	const closeResult = store.closeSession(second.id);
	assert.deepStrictEqual(
		{
			closeResult,
			sessionIds: store.getSessions().map(s => s.id),
			history: store.getHistory(),
		},
		{
			closeResult: { abortSessionId: undefined, activeChanged: false },
			sessionIds: ['id0'],
			history: [{ id: 'id1', title: 'hello world', messages: [{ role: 'user', content: 'hello world' }], savedAt: 1_000_000 }],
		},
	);

	// clearSession mints a fresh id in place rather than replacing the session object.
	const clearResult = store.clearSession(first.id);
	assert.deepStrictEqual(clearResult, { abortSessionId: undefined, newId: 'id2' });
	assert.deepStrictEqual(store.getActive(), {
		id: 'id2', title: '', messages: [], streaming: false, pending: null, queue: [], todos: [],
		compactSummary: undefined, compactedUpTo: 0, mode: 'ask',
	}, 'the cleared session keeps its place but gets a fresh id and empty transcript');
	assert.strictEqual(store.getHistory().length, 1, 'clearing a session with no messages archives nothing new');

	// restoreSession reopens the archived conversation as a live tab and activates it.
	const restored = store.restoreSession('id1', 'plan');
	assert.deepStrictEqual(
		{ restored, historyIds: store.getHistory().map(h => h.id), activeId: store.getActiveId() },
		{
			restored: { id: 'id1', title: 'hello world', messages: [{ role: 'user', content: 'hello world' }], streaming: false, pending: null, queue: [], todos: [], mode: 'plan' },
			historyIds: [],
			activeId: 'id1',
		},
	);
	assert.strictEqual(store.restoreSession('not-in-history'), undefined);
}

// 2. Closing the only remaining tab does not leave the store with zero sessions — a fresh one
// takes its place, and becomes active.
{
	const store = new SessionStore(makeDeps());
	const onlyId = store.getSessions()[0].id;
	const closeResult = store.closeSession(onlyId);
	assert.deepStrictEqual(closeResult, { abortSessionId: undefined, activeChanged: true, createdSessionId: 'id1' });
	assert.deepStrictEqual(store.getSessions().map(s => s.id), ['id1']);
	assert.strictEqual(store.getActiveId(), 'id1');
}

// 3. Closing a session with a run in progress reports which session needs its run aborted —
// the store has no messaging channel of its own to do that itself.
{
	const store = new SessionStore(makeDeps());
	const session = store.getActive();
	store.beginRun(session.id, 'agent');
	assert.strictEqual(store.getActive().streaming, true);
	const closeResult = store.closeSession(session.id);
	assert.deepStrictEqual(closeResult, { abortSessionId: session.id, activeChanged: true, createdSessionId: 'id2' });
}

// 4. archiveSession skips a session whose transcript is only UI notices, and otherwise
// derives a fallback title from the first non-notice user message, sliced to 28 characters
// with no ellipsis (the session's own `title`, when set, always wins — see scenario 1, where
// `appendMessage`'s title derivation already produced one).
{
	const deps = makeDeps();
	const noticesOnly = {
		id: 'n1', title: '', mode: 'ask', streaming: false, pending: null, queue: [], todos: [],
		messages: [{ role: 'assistant', content: 'a notice', kind: 'info' }],
	};
	assert.deepStrictEqual(archiveSession([], noticesOnly, deps), [], 'a notices-only session archives nothing');

	const untitled = {
		id: 'u1', title: '', mode: 'ask', streaming: false, pending: null, queue: [], todos: [],
		messages: [
			{ role: 'assistant', content: 'a notice', kind: 'info' },
			{ role: 'user', content: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
		],
	};
	assert.deepStrictEqual(archiveSession([], untitled, deps), [{
		id: 'u1',
		title: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ01', // first 28 chars, no ellipsis
		messages: untitled.messages,
		savedAt: 1_000_000,
	}]);
}

// 5. mergeHistory keeps the newest copy of each conversation id and trims to HISTORY_LIMIT.
{
	const current = [
		{ id: 'a', title: 'A', messages: [], savedAt: 100 },
		{ id: 'b', title: 'B', messages: [], savedAt: 50 },
	];
	const incoming = [
		{ id: 'a', title: 'A2', messages: [], savedAt: 200 }, // newer copy of 'a' wins
		{ id: 'c', title: 'C', messages: [], savedAt: 10 },
	];
	assert.deepStrictEqual(mergeHistory(current, incoming), [
		{ id: 'a', title: 'A2', messages: [], savedAt: 200 },
		{ id: 'b', title: 'B', messages: [], savedAt: 50 },
		{ id: 'c', title: 'C', messages: [], savedAt: 10 },
	]);

	const many = Array.from({ length: 60 }, (_, i) => ({ id: `h${i}`, title: `H${i}`, messages: [], savedAt: i }));
	const trimmed = mergeHistory([], many);
	assert.strictEqual(trimmed.length, HISTORY_LIMIT);
	assert.deepStrictEqual(trimmed.map(h => h.id), Array.from({ length: HISTORY_LIMIT }, (_, i) => `h${59 - i}`),
		'the 50 newest (by savedAt) survive the trim, newest first');
}

// 6/7. sendableMessages filters notices and empty assistant turns, slices at compactedUpTo,
// and prepends the compaction summary — and applyCompaction's arithmetic is exercised in
// both branches: no prior summary (the +1 for the untouched leading turn) and with one
// (the old summary turn is itself what the new response supersedes, so +0).
{
	const store = new SessionStore(makeDeps());
	const s = store.getActive();
	store.appendMessage(s.id, { role: 'user', content: 'first' });
	store.appendMessage(s.id, { role: 'assistant', content: 'reply' });
	store.appendMessage(s.id, { role: 'assistant', content: '', kind: 'info' }); // a UI notice
	store.appendMessage(s.id, { role: 'assistant', content: '' }); // never-streamed placeholder
	store.appendMessage(s.id, { role: 'user', content: 'second' });
	assert.deepStrictEqual(store.sendableMessages(s.id), [
		{ role: 'user', content: 'first' },
		{ role: 'assistant', content: 'reply' },
		{ role: 'user', content: 'second' },
	]);

	// First compaction: no prior summary, so compactedUpTo advances by replaced(2) + 1.
	store.applyCompaction(s.id, 'summary text', 2);
	assert.deepStrictEqual(
		{ compactedUpTo: store.getSession(s.id).compactedUpTo, compactSummary: store.getSession(s.id).compactSummary, sendable: store.sendableMessages(s.id) },
		{ compactedUpTo: 3, compactSummary: 'summary text', sendable: [{ role: 'user', content: 'summary text' }] },
	);

	// Second compaction: a prior summary exists, so compactedUpTo advances by replaced(1) + 0.
	store.appendMessage(s.id, { role: 'assistant', content: 'third reply' });
	store.applyCompaction(s.id, 'summary text 2', 1);
	assert.deepStrictEqual(
		{ compactedUpTo: store.getSession(s.id).compactedUpTo, compactSummary: store.getSession(s.id).compactSummary, sendable: store.sendableMessages(s.id) },
		{ compactedUpTo: 4, compactSummary: 'summary text 2', sendable: [{ role: 'user', content: 'summary text 2' }] },
	);
}

// 8. Persistence round-trip: what buildPersistedState produces is exactly what saveState /
// loadState carries through the memento.
{
	const store = new SessionStore(makeDeps());
	const s = store.getActive();
	store.appendMessage(s.id, { role: 'user', content: 'hi' });
	store.enqueue(s.id, 'queued follow-up');
	store.applyCompaction(s.id, 'a summary', 0);

	const payload = buildPersistedState(store.getSessions(), store.getActiveId(), store.getHistory());
	const memento = makeMemento();
	assert.strictEqual(loadState(memento), undefined, 'nothing persisted yet');
	await saveState(memento, payload);
	assert.deepStrictEqual(loadState(memento), payload);
}

// 9. The persisted image budget drops an older attachment to a text marker while keeping a
// newer one intact (spent newest-message-first, within one session), and — independent of
// tab-strip order — gives the *active* session first claim on that shared budget so the
// conversation the user is actually looking at keeps its screenshot.
{
	const budget = { left: MAX_PERSISTED_IMAGE_BYTES };
	const kept = messagesForState([
		{ role: 'user', content: 'old', images: [fakeImage(1_500_000)] },
		{ role: 'user', content: 'new', images: [fakeImage(1_500_000)] },
	], budget);
	assert.deepStrictEqual(kept, [
		{ role: 'user', content: 'old\n\n_[1 image not kept after reload]_', kind: undefined },
		{ role: 'user', content: 'new', images: [fakeImage(1_500_000)] },
	]);

	const store = new SessionStore(makeDeps());
	const background = store.getActive(); // id0 — stays inactive
	const active = store.createSession(true, 'ask'); // id1 — the active tab
	// Background tab listed first in tab-strip order, active tab second — the budget
	// preference must come from `activeSessionId`, not array position.
	store.appendMessage(background.id, { role: 'user', content: 'bg', images: [fakeImage(1_500_000)] });
	store.appendMessage(active.id, { role: 'user', content: 'active', images: [fakeImage(1_500_000)] });

	const payload = buildPersistedState(store.getSessions(), store.getActiveId(), store.getHistory());
	assert.deepStrictEqual(
		payload.sessions.map(s => ({ id: s.id, hasImage: !!s.messages[0].images })),
		[{ id: background.id, hasImage: false }, { id: active.id, hasImage: true }],
	);
	assert.match(payload.sessions[0].messages[0].content, /not kept after reload/);
}

// 10. adoptLegacyState imports the webview's pre-refactor `vscode.getState()` payload — both
// the chat-tabs shape and the older pre-tabs single-`messages` shape — and, unlike the
// webview's own migration, keeps the recovered sessions LIVE instead of archiving them.
// A persisted `mode: 'edit'` (the mode 'plan' replaced) migrates to 'plan'.
{
	const deps = makeDeps();
	const tabsPayload = {
		sessions: [{ id: 'leg1', title: 'T', messages: [{ role: 'user', content: 'hi' }], queue: ['q1'] }],
		mode: 'edit',
		selectedProvider: 'openai',
		history: [{ id: 'h1', title: 'H', messages: [], savedAt: 1 }],
	};
	assert.deepStrictEqual(adoptLegacyState(tabsPayload, deps), {
		sessions: [{
			id: 'leg1', title: 'T', messages: [{ role: 'user', content: 'hi' }],
			streaming: false, pending: null, queue: ['q1'], todos: [],
			compactSummary: undefined, compactedUpTo: undefined, mode: 'plan',
		}],
		activeSessionId: 'leg1',
		history: [{ id: 'h1', title: 'H', messages: [], savedAt: 1 }],
		provider: 'openai',
	});

	const singleMessagePayload = { messages: [{ role: 'user', content: 'hey' }], mode: 'ask' };
	const adopted = adoptLegacyState(singleMessagePayload, deps);
	assert.deepStrictEqual(adopted, {
		sessions: [{
			id: adopted.sessions[0].id, title: '', messages: [{ role: 'user', content: 'hey' }],
			streaming: false, pending: null, queue: [], todos: [], mode: 'ask',
		}],
		activeSessionId: adopted.sessions[0].id,
		history: [],
		provider: undefined,
	});

	// No persisted state at all recovers to no sessions — the caller (SessionStore.hydrate)
	// is responsible for the "always at least one session" invariant, not this pure function.
	assert.deepStrictEqual(adoptLegacyState({}, deps), { sessions: [], activeSessionId: '', history: [], provider: undefined });
}

console.log('test-session-store: all assertions passed');
