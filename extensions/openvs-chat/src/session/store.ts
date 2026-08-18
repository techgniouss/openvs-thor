/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { archiveSession, mergeHistory as mergeHistoryList } from './history';
import { ChatMode, HistoryEntry, SessionDeps, SessionState, SessionTodo, TranscriptEntry, TranscriptImage, TranscriptWindow } from './types';

/** {@link SessionStore.windowedMessages}'s default tail length when a caller passes no options. */
export const DEFAULT_TAIL_TURNS = 30;
/** {@link SessionStore.windowedMessages}'s default tail size, in UTF-8 bytes of `content`. */
export const DEFAULT_TAIL_BYTES = 48 * 1024;
/** {@link SessionStore.pageMessages}'s default page size when `count` is absent or invalid. */
export const DEFAULT_PAGE_COUNT = 30;

/** The real, non-deterministic {@link SessionDeps} — used unless a test injects its own. */
const REAL_DEPS: SessionDeps = {
	now: () => Date.now(),
	// Mirrors the session id scheme at `media/main.js:75`: 's' + base36 time + random tail.
	newId: () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
};

/** Result of {@link SessionStore.switchSession}. */
export interface SwitchResult {
	readonly activeChanged: boolean;
}

/** Result of {@link SessionStore.closeSession}. */
export interface CloseResult {
	/**
	 * Set when the closed session had a live run in progress. The store has no messaging
	 * channel of its own (see the class doc), so it reports the need to abort rather than
	 * acting on it — the caller owns that session's `AbortController`.
	 */
	readonly abortSessionId?: string;
	/** Whether the active session changed as a result of closing this one. */
	readonly activeChanged: boolean;
	/** Set when closing emptied the session list and a fresh session was created in its place. */
	readonly createdSessionId?: string;
}

/** Result of {@link SessionStore.clearSession}. */
export interface ClearResult {
	/** Set when the cleared session had a live run in progress; see {@link CloseResult.abortSessionId}. */
	readonly abortSessionId?: string;
	/** The session's id after clearing — a fresh id is minted in place. */
	readonly newId: string;
}

/** Ingredients to seed a fresh {@link SessionStore} via {@link SessionStore.hydrate}. */
export interface SessionStoreSnapshot {
	readonly sessions: SessionState[];
	readonly activeSessionId: string;
	readonly history?: readonly HistoryEntry[];
}

/**
 * Host-side owner of live chat sessions: chat tabs, their transcripts, run state, and the
 * archived-conversation history they close into. This is Phase 1a of "remote control" — the
 * end goal is that the extension host, not the webview, owns this state, so it can be driven
 * by more than one client (the desktop webview today, a remote device later). This class has
 * no wiring to either yet: nothing constructs it outside `scripts/test-session-store.mjs`.
 *
 * Ported from the equivalent logic in `media/main.js` (see each method's doc for its source
 * line), adapted in three ways the webview's version didn't need:
 *
 *  - `mode`/`provider`/`model` move from webview-global variables onto each {@link SessionState}
 *    — independently-running tabs sharing one selected provider is exactly the kind of
 *    webview-side global state this refactor exists to retire.
 *  - The store never posts a message and never touches the DOM. Per CLAUDE.md, control flow
 *    should not be driven by events — so where the webview would `vscode.postMessage(...)` or
 *    re-render mid-mutation, a method here returns a small result describing the effect (e.g.
 *    {@link CloseResult}) and leaves deciding what to do about it to the caller.
 *  - Determinism (session ids, run ids, archive timestamps) is injected via {@link SessionDeps}
 *    rather than read from `Date.now()`/`Math.random()` directly, so tests can assert on exact
 *    values instead of "some string" / "some recent number".
 */
export class SessionStore {
	private sessions: SessionState[];
	private activeSessionId: string;
	private history: HistoryEntry[] = [];

	constructor(private readonly deps: SessionDeps = REAL_DEPS) {
		// A store always has at least one session once constructed — every reader (starting
		// with `getActive`) is entitled to assume that, exactly as `cur()` does in the webview.
		const initial = this.buildSession('ask');
		this.sessions = [initial];
		this.activeSessionId = initial.id;
	}

	/** Builds a bare new session object; does not add it to `this.sessions`. */
	private buildSession(mode: ChatMode, title = ''): SessionState {
		return {
			id: this.deps.newId(),
			title,
			messages: [],
			streaming: false,
			pending: null,
			queue: [],
			todos: [],
			mode,
		};
	}

	// ---- Reads -------------------------------------------------------------------

	/** All chat tabs, in tab-strip order. */
	getSessions(): readonly SessionState[] {
		return this.sessions;
	}

	getSession(id: string): SessionState | undefined {
		return this.sessions.find(s => s.id === id);
	}

	getActiveId(): string {
		return this.activeSessionId;
	}

	/** The active session. Always defined — see the class doc's invariant. */
	getActive(): SessionState {
		return this.getSession(this.activeSessionId) ?? this.sessions[0];
	}

	/** Archived conversations, newest first. */
	getHistory(): readonly HistoryEntry[] {
		return this.history;
	}

	// ---- Chat tabs -----------------------------------------------------------------
	// Ported from the "Chat tabs" section of media/main.js (from line 717).

	/**
	 * Opens a new chat tab. Ported from `createSession` at `media/main.js:721`, with one
	 * addition: `mode` seeds the new session's per-tab mode, since the webview version had a
	 * single global `mode` to fall back to and this store does not.
	 */
	createSession(activate = true, mode: ChatMode = 'ask'): SessionState {
		const session = this.buildSession(mode);
		this.sessions.push(session);
		if (activate) {
			this.activeSessionId = session.id;
		}
		return session;
	}

	/** Ported from `switchSession` at `media/main.js:735`: a no-op if already active or unknown. */
	switchSession(id: string): SwitchResult {
		if (id === this.activeSessionId || !this.sessions.some(s => s.id === id)) {
			return { activeChanged: false };
		}
		this.activeSessionId = id;
		return { activeChanged: true };
	}

	/**
	 * Closes a chat tab. Ported from `closeSession` at `media/main.js:812`: archive first,
	 * splice, and if that emptied the list, open a fresh session so the invariant that a
	 * store always has an active session keeps holding. Where the webview posts `stop` for a
	 * tab that was streaming, this returns {@link CloseResult.abortSessionId} instead — the
	 * store doesn't know how to abort a run, only that this session's caller must.
	 */
	closeSession(id: string): CloseResult {
		const index = this.sessions.findIndex(s => s.id === id);
		if (index === -1) {
			return { activeChanged: false };
		}
		const session = this.sessions[index];
		const abortSessionId = session.streaming ? session.id : undefined;
		this.history = archiveSession(this.history, session, this.deps);
		this.sessions.splice(index, 1);
		if (!this.sessions.length) {
			const created = this.createSession(true);
			return { abortSessionId, activeChanged: true, createdSessionId: created.id };
		}
		if (this.activeSessionId !== id) {
			return { abortSessionId, activeChanged: false };
		}
		this.activeSessionId = this.sessions[Math.min(index, this.sessions.length - 1)].id;
		return { abortSessionId, activeChanged: true };
	}

	/**
	 * Clears a chat tab's conversation in place. Ported from `clearChat` at
	 * `media/main.js:2034`: archive, then mint a new id in place — a fresh id (not a fresh
	 * session object) so the archived copy just made stays its own history entry instead of
	 * being overwritten the next time this same tab is archived.
	 */
	clearSession(id: string): ClearResult | undefined {
		const session = this.getSession(id);
		if (!session) {
			return undefined;
		}
		const abortSessionId = session.streaming ? session.id : undefined;
		this.history = archiveSession(this.history, session, this.deps);
		const newId = this.deps.newId();
		if (this.activeSessionId === session.id) {
			this.activeSessionId = newId;
		}
		session.id = newId;
		session.messages = [];
		session.title = '';
		session.pending = null;
		session.streaming = false;
		session.todos = [];
		session.compactSummary = undefined;
		session.compactedUpTo = 0;
		return { abortSessionId, newId };
	}

	/**
	 * Reopens a saved conversation from history as a live tab. Ported from `restoreChat` at
	 * `media/main.js:799`. `mode` seeds the reopened session's per-tab mode — see
	 * {@link createSession}.
	 */
	restoreSession(historyId: string, mode: ChatMode = 'ask'): SessionState | undefined {
		const index = this.history.findIndex(h => h.id === historyId);
		if (index === -1) {
			return undefined;
		}
		const [entry] = this.history.splice(index, 1);
		const session: SessionState = {
			id: entry.id,
			title: entry.title,
			messages: entry.messages,
			streaming: false,
			pending: null,
			queue: [],
			todos: [],
			mode,
		};
		this.sessions.push(session);
		this.activeSessionId = session.id;
		return session;
	}

	// ---- History ---------------------------------------------------------------

	/** Merges an incoming archive (typically the host's persisted copy) into this store's. */
	mergeHistory(incoming: readonly HistoryEntry[]): void {
		this.history = mergeHistoryList(this.history, incoming);
	}

	// ---- Shadow mode (Phase 1b) --------------------------------------------------
	// The methods below exist for `chatViewProvider.ts`'s shadow-mode wiring: the host builds
	// its own copy of session state from traffic it already sees, while the webview stays
	// authoritative. Every one of them is a plain mutation with no decision attached — the
	// store itself never reads any of this back to influence what gets sent to a model.

	/**
	 * Creates (or finds) a session keyed by a caller-supplied id, rather than one this store
	 * mints itself. {@link createSession} always calls `deps.newId()` because a live tab is
	 * something this store owns end to end; a shadow copy is the opposite of that — it exists
	 * to mirror an id the webview already minted, not to choose its own. Does not touch
	 * `activeSessionId`: the shadow copy has no visible "active tab" of its own.
	 */
	seedSession(id: string, mode: ChatMode): SessionState {
		const existing = this.getSession(id);
		if (existing) {
			return existing;
		}
		const session: SessionState = { ...this.buildSession(mode), id };
		this.sessions.push(session);
		return session;
	}

	/**
	 * Replaces a session's transcript wholesale. Used after a divergence check (or a seed) to
	 * resync the host's copy to what the webview just sent — the webview stays authoritative
	 * through Phase 1b, so this measures drift per turn instead of letting it accumulate.
	 */
	replaceMessages(sessionId: string, messages: TranscriptEntry[]): void {
		const session = this.getSession(sessionId);
		if (session) {
			session.messages = messages;
		}
	}

	/**
	 * Records the mode/provider/model a send chose for its session. The real webview does not
	 * carry these per session yet at all — see the `mode`/`provider`/`model` fields' doc on
	 * {@link SessionState}, which are still webview-global today — so this is this store's own
	 * best-effort snapshot of what a later phase's per-tab fields would hold, taken from what
	 * `chatViewProvider.ts` actually used for this send. Deliberately separate from
	 * {@link beginRun}: that method's contract is ported from the webview's real `sendText` and
	 * should not gain fields the webview itself does not set.
	 */
	setSessionConfig(sessionId: string, mode: ChatMode, provider: string | undefined, model: string | undefined): void {
		const session = this.getSession(sessionId);
		if (session) {
			session.mode = mode;
			session.provider = provider;
			session.model = model;
		}
	}

	// ---- Sending / compaction ----------------------------------------------------

	/**
	 * The messages actually sent as conversation history: the compacted summary (if any)
	 * followed by the un-compacted tail. Exact port of `sendableMessages` at
	 * `media/main.js:1945` — notice entries (`kind` set) and empty assistant turns (a
	 * streaming placeholder that never received a token) are never sendable.
	 */
	sendableMessages(sessionId: string): TranscriptEntry[] {
		const session = this.getSession(sessionId);
		if (!session) {
			return [];
		}
		const real = session.messages.filter(m => !m.kind && !(m.role === 'assistant' && m.content === ''));
		const tail = real.slice(session.compactedUpTo || 0);
		return session.compactSummary ? [{ role: 'user', content: session.compactSummary }, ...tail] : tail;
	}

	/**
	 * Records the result of a compaction round. Ported verbatim, reasoning included, from
	 * `media/main.js:2744-2761`:
	 *
	 * `replaced` counts messages from the start of the payload {@link sendableMessages} last
	 * returned — the previous summary turn (when one existed) followed by the un-compacted
	 * tail. That payload's first user-role message is always index 0 of the underlying
	 * transcript: either the old summary turn, or (on the very first compaction) the
	 * transcript's own first turn, which every session opens with. The host keeps that one
	 * leading message verbatim ahead of its new summary, so the untouched prefix is 1 message
	 * when there was no prior summary and 0 when there was (the old summary turn is itself
	 * what this response supersedes). Advancing `compactedUpTo` by `replaced` plus that prefix
	 * lines the next tail up with exactly the "recent turns" window the host just kept —
	 * otherwise one boundary message would be resent raw every round, re-growing on top of
	 * what the summary already covers.
	 */
	applyCompaction(sessionId: string, summary: string | undefined, replaced: number): void {
		const session = this.getSession(sessionId);
		if (!session) {
			return;
		}
		const hadSummary = session.compactSummary ? 1 : 0;
		const safeReplaced = Math.max(0, replaced || 0);
		session.compactedUpTo = (session.compactedUpTo || 0) + safeReplaced + (hadSummary ? 0 : 1);
		session.compactSummary = summary ? summary : session.compactSummary;
	}

	// ---- Transcript, queue, todos, run state ---------------------------------------

	/**
	 * The tail of a session's transcript a client is caught up with — on `ready`/`sync`/tab
	 * switch — without shipping the whole thing. Per the "remote control" plan's "Catch-up"
	 * section: takes messages from the end, accumulating until either `tailTurns` messages have
	 * been collected or `tailBytes` (summed UTF-8 byte length of each entry's `content`, mirroring
	 * the byte-measuring approach `remoteSink.ts`'s `truncateUtf8` uses for the same reason — this
	 * module stays `vscode`-free and does not import from `remote/`) would be exceeded by
	 * including one more entry — whichever binds first. The most recent entry is always included
	 * even alone over `tailBytes`, the same floor `agent/context.ts`'s `trimMessages` applies to a
	 * single oversized tool result, rather than a caller ever seeing an empty window on a
	 * non-empty session. Pass `Infinity` for either bound to request the whole transcript through
	 * this same path — `restoreSession`'s caller (a whole archived conversation reopened as a
	 * live tab, where windowing would contradict the point of restoring it) uses exactly that
	 * instead of a second, unwindowed code path.
	 */
	windowedMessages(sessionId: string, options?: { tailTurns?: number; tailBytes?: number }): TranscriptWindow {
		const session = this.getSession(sessionId);
		const total = session?.messages.length ?? 0;
		if (!session) {
			return { messages: [], from: 0, truncated: false, total };
		}
		const tailTurns = options?.tailTurns ?? DEFAULT_TAIL_TURNS;
		const tailBytes = options?.tailBytes ?? DEFAULT_TAIL_BYTES;
		const messages: TranscriptEntry[] = [];
		let bytes = 0;
		for (let i = total - 1; i >= 0; i--) {
			if (messages.length >= tailTurns) {
				break;
			}
			const entryBytes = Buffer.byteLength(session.messages[i].content, 'utf8');
			if (messages.length > 0 && bytes + entryBytes > tailBytes) {
				break;
			}
			messages.unshift(session.messages[i]);
			bytes += entryBytes;
		}
		const from = total - messages.length;
		return { messages, from, truncated: from > 0, total };
	}

	/**
	 * One backward page of a session's transcript, for `fetchTranscript`'s scroll-up paging —
	 * the counterpart to {@link windowedMessages}'s forward tail. `before` is an index into the
	 * *full* transcript: the point to page backward from, so the reply holds messages strictly
	 * before it. `count` defaults to {@link DEFAULT_PAGE_COUNT} when absent or not a positive
	 * number. `before <= 0` or an unknown `sessionId` returns an empty page (`truncated: false`)
	 * rather than throwing, so a client that has paged all the way back gets a clean "nothing
	 * more" signal instead of an error to handle specially.
	 */
	pageMessages(sessionId: string, options: { before: number; count?: number }): TranscriptWindow {
		const session = this.getSession(sessionId);
		const total = session?.messages.length ?? 0;
		if (!session || options.before <= 0) {
			return { messages: [], from: Math.max(0, options.before), truncated: false, total };
		}
		const count = options.count && options.count > 0 ? options.count : DEFAULT_PAGE_COUNT;
		const end = Math.min(options.before, total);
		const start = Math.max(0, end - count);
		return { messages: session.messages.slice(start, end), from: start, truncated: start > 0, total };
	}

	/**
	 * Appends one turn to a session's transcript. When it is the first non-notice user
	 * message in a still-untitled session, this also derives the tab title from it — the
	 * same "first message becomes the title" step `sendText` performs inline at
	 * `media/main.js:1959-1961` (truncated to 27 characters plus an ellipsis; that differs
	 * from the plain 28-character slice `archiveSession`'s own title *fallback* uses for a
	 * session that never got titled this way).
	 */
	appendMessage(sessionId: string, entry: TranscriptEntry): TranscriptEntry | undefined {
		const session = this.getSession(sessionId);
		if (!session) {
			return undefined;
		}
		session.messages.push(entry);
		if (!session.title && entry.role === 'user' && !entry.kind && entry.content) {
			session.title = entry.content.length > 28 ? entry.content.slice(0, 27) + '…' : entry.content;
		}
		return entry;
	}

	/**
	 * Appends assembled images from a remote `attachImage` upload (Phase 6c) to a session's
	 * pending-images queue, awaiting the next `send`. A no-op for an unknown session id,
	 * matching {@link setTodos}/{@link setQueue}'s existing pattern — a remote client that
	 * uploads before its session exists on the host has nowhere for these to land, and
	 * silently dropping is preferable to throwing out of a chunk-reassembly callback.
	 */
	addPendingImages(sessionId: string, images: TranscriptImage[]): void {
		const session = this.getSession(sessionId);
		if (!session) {
			return;
		}
		session.pendingImages = [...(session.pendingImages ?? []), ...images];
	}

	/**
	 * Returns and clears a session's pending images. `handleSend` calls this once per send and
	 * merges the result into the new turn's own `images` — see {@link SessionState.pendingImages}'s
	 * doc for why the host holds this rather than any one client.
	 */
	takePendingImages(sessionId: string): TranscriptImage[] | undefined {
		const session = this.getSession(sessionId);
		const images = session?.pendingImages;
		if (session) {
			session.pendingImages = undefined;
		}
		return images;
	}

	/** Queues a follow-up message, sent once the session's current run finishes. */
	enqueue(sessionId: string, text: string): void {
		this.getSession(sessionId)?.queue.push(text);
	}

	/** Pops the next queued follow-up, or `undefined` if the queue is empty. */
	dequeue(sessionId: string): string | undefined {
		return this.getSession(sessionId)?.queue.shift();
	}

	/**
	 * Replaces a session's queued follow-ups wholesale, unlike {@link enqueue}/{@link dequeue}'s
	 * incremental push/shift. Used by a client (e.g. a remote client re-ordering or clearing its
	 * own queue) that wants to set the whole list in one message rather than a sequence of them.
	 */
	setQueue(sessionId: string, queue: string[]): void {
		const session = this.getSession(sessionId);
		if (session) {
			session.queue = queue;
		}
	}

	/** Replaces a session's task checklist (see `media/main.js`'s `todos` message handler). */
	setTodos(sessionId: string, todos: SessionTodo[]): void {
		const session = this.getSession(sessionId);
		if (session) {
			session.todos = todos;
		}
	}

	/**
	 * Marks a session's run as started: remembers which mode started it (mid-run input later
	 * needs this to know whether to steer or queue), resets `steerable` to true (assumed
	 * steerable until the caller learns otherwise for a turn answered without an agent loop),
	 * and stamps a fresh run id so stragglers from a superseded run can be told apart from the
	 * current one. Ported from `media/main.js:1970-1992`. Returns the new run id, so the
	 * caller can hand it to whatever it starts.
	 */
	beginRun(sessionId: string, mode: ChatMode): string | undefined {
		const session = this.getSession(sessionId);
		if (!session) {
			return undefined;
		}
		session.runMode = mode;
		session.steerable = true;
		session.streaming = true;
		session.runId = this.deps.newId();
		return session.runId;
	}

	/**
	 * Marks a session's run as finished. Mirrors only the `s.streaming = false` half of the
	 * `'done'` handler at `media/main.js:2831` — draining the queue is the caller's job (see
	 * {@link dequeue}), since resuming with the next queued message means starting a new run,
	 * which is a decision the store does not make on its own.
	 */
	endRun(sessionId: string): void {
		const session = this.getSession(sessionId);
		if (session) {
			session.streaming = false;
		}
	}

	/** Mirrors `s.steerable = !!msg.steerable;` at `media/main.js:2651`. */
	setSteerable(sessionId: string, steerable: boolean): void {
		const session = this.getSession(sessionId);
		if (session) {
			session.steerable = steerable;
		}
	}

	// ---- Bulk state (persistence) -------------------------------------------------

	/**
	 * Replaces this store's sessions/history/active id wholesale. Used to seed a store from
	 * data recovered by `persistence.ts` (a loaded `PersistedState`, or `adoptLegacyState`'s
	 * output). Nothing calls this yet in Phase 1a — a later phase wires it to the extension's
	 * own persisted state at construction time.
	 */
	hydrate(snapshot: SessionStoreSnapshot): void {
		this.sessions = snapshot.sessions.length ? snapshot.sessions : [this.buildSession('ask')];
		this.activeSessionId = this.sessions.some(s => s.id === snapshot.activeSessionId)
			? snapshot.activeSessionId
			: this.sessions[0].id;
		if (snapshot.history) {
			this.history = [...snapshot.history];
		}
	}
}
