/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared types for the host-side session store (`src/session/`).
 *
 * Nothing here imports `vscode`. This is Phase 1a of "remote control": the host is meant to
 * own live chat sessions instead of the webview, and these types describe that ownership
 * independently of both the extension host API and the webview's DOM-bound `main.js`. A later
 * phase wires `SessionStore` into `chatViewProvider.ts`; until then these types (and the
 * modules built on them) are exercised only by `scripts/test-session-store.mjs`.
 */

/**
 * The chat modes a session can run in. Mirrors `ChatMode` in `chatViewProvider.ts` exactly —
 * 'ask' (read-only Q&A), 'plan' (plan the requirement, no changes), 'agent' (full tool loop),
 * and 'edit', which survives only as the internal mode behind the inline Fix/Doc/Optimize/Edit
 * code actions and is never user-selectable from the mode picker.
 */
export type ChatMode = 'ask' | 'plan' | 'edit' | 'agent';

/** A single image attached to a transcript entry, already downscaled/re-encoded client-side. */
export interface TranscriptImage {
	readonly mimeType: string;
	/** Base64-encoded image data, without the `data:...;base64,` prefix. */
	readonly data: string;
}

/**
 * One phase of an Auto-mode run (plan / implementation / review), attached to a `kind: 'auto'`
 * transcript entry so the transcript can show which model actually answered each phase.
 * Mirrors the `AutoPhase` typedef near the top of `media/main.js`.
 */
export interface TranscriptPhase {
	readonly role: string;
	readonly label?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly source?: string;
}

/** A single tool/function call requested by the model, as recorded in a transcript entry. */
export interface TranscriptToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/**
 * One turn in a session's conversation. Mirrors the webview's `Msg` typedef (see the JSDoc
 * near the top of `media/main.js`) plus the tool-call fields `ChatMessage` carries in
 * `src/providers/types.ts` — `toolCalls` on an assistant turn that invoked tools, `toolCallId`
 * on the matching tool-result turn — so one entry shape can hold both what the webview renders
 * today and the tool round-trips a later phase needs the host to keep.
 *
 * `kind` is set only on UI notices ('info' / 'error') and Auto-mode run summaries ('auto');
 * entries with a `kind` are never sent to a model — see {@link SessionStore.sendableMessages}.
 */
export interface TranscriptEntry {
	readonly role: 'user' | 'assistant' | 'tool';
	content: string;
	readonly images?: TranscriptImage[];
	readonly kind?: 'info' | 'error' | 'auto';
	readonly phases?: TranscriptPhase[];
	readonly toolCalls?: TranscriptToolCall[];
	readonly toolCallId?: string;
}

/** A task-checklist item the agent loop tracks for a run, rendered as the session's todo panel. */
export interface SessionTodo {
	readonly content: string;
	readonly status: 'pending' | 'in_progress' | 'completed';
}

/**
 * A slice of one session's transcript, as returned by {@link SessionStore.windowedMessages} and
 * {@link SessionStore.pageMessages} and shipped verbatim (plus `type`/`sessionId`) as a
 * `transcript` wire message — see the "remote control" plan's "Catch-up" section. `from` is the
 * slice's starting index into the *full* transcript (not 0, unless the slice starts at the
 * beginning); `total` is always the full session's message count, regardless of how much of it
 * `messages` holds, so a client can render "showing last N of total". `truncated` means "there
 * is more transcript before `from`" — for a tail window that's older history; for a backward
 * page it's "still older messages before this page".
 */
export interface TranscriptWindow {
	readonly messages: TranscriptEntry[];
	readonly from: number;
	readonly truncated: boolean;
	readonly total: number;
}

/**
 * One chat tab's full live state, including its transcript. Mirrors `Session` at
 * `media/main.js:38`, with three fields the webview currently holds globally moved onto the
 * session instead — `mode`, `provider` and `model` are per-tab in this target design, since
 * independently-running tabs having to share one selected provider is exactly the kind of
 * webview-side global state this refactor exists to retire.
 */
export interface SessionState {
	/**
	 * Mutable, not `readonly`: {@link SessionStore.clearSession} mints a fresh id in place
	 * (matching `clearChat`'s `s.id = newSessionId()` at `media/main.js:2043`) rather than
	 * replacing the session object, so a caller's existing reference stays valid.
	 */
	id: string;
	title: string;
	messages: TranscriptEntry[];
	streaming: boolean;
	pending: string | null;
	queue: string[];
	todos?: SessionTodo[];
	runId?: string;
	runMode?: ChatMode;
	steerable?: boolean;
	compactSummary?: string;
	compactedUpTo?: number;
	mode: ChatMode;
	provider?: string;
	model?: string;
	/**
	 * Images assembled from a remote client's chunked `attachImage` upload (Phase 6c),
	 * awaiting the session's next `send`. The host, not any one client, owns this queue — the
	 * point of the Phase 2 ownership flip was moving state like this off the client, and a
	 * remote client has no local "composer draft" of its own to hold it in the way the
	 * desktop webview's `pendingImages` array does. `SessionStore.appendMessage`'s caller
	 * merges this into the appended turn's own `images` and clears it; never sent to a model
	 * or a remote sink on its own, so both `toSessionSummary` functions (`chatViewProvider.ts`
	 * and `snapshot.ts`) deliberately leave it out of the field list they build a
	 * {@link SessionSummary} from, even though the type itself does not forbid it.
	 */
	pendingImages?: TranscriptImage[];
}

/**
 * A {@link SessionState} without its transcript. This is what a later phase sends over the
 * wire to a remote client (or renders in a tab strip) — typing it separately means a
 * transcript can never be included in that payload by accident.
 */
export type SessionSummary = Omit<SessionState, 'messages'>;

/**
 * One archived conversation, newest first. Mirrors the shape `archiveSession` builds at
 * `media/main.js:762` — image attachments are stripped (see `history.ts`) since archived
 * messages are never re-sent to a model, so keeping their base64 payloads around would only
 * bloat persisted state.
 */
export interface HistoryEntry {
	readonly id: string;
	readonly title: string;
	messages: TranscriptEntry[];
	readonly savedAt: number;
}

/**
 * Minimal subset of `vscode.Memento` that persistence needs. Declared locally rather than
 * imported so `src/session/` stays importable without `vscode` — `vscode.Memento` (e.g.
 * `context.workspaceState`) structurally satisfies this already, and a test passes a plain
 * in-memory object instead.
 */
export interface SessionMemento {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

/**
 * Minimal `PromiseLike` surface, declared locally for the same reason as {@link SessionMemento}
 * — `vscode.Thenable` has this exact shape, so a real `vscode.Memento.update` return value (and
 * a plain `Promise<void>`) both satisfy it without importing `vscode`.
 */
export interface Thenable<T> {
	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: (value: T) => TResult1 | Thenable<TResult1>,
		onrejected?: (reason: unknown) => TResult2 | Thenable<TResult2>
	): Thenable<TResult1 | TResult2>;
}

/**
 * Determinism seams injected into {@link SessionStore} and the free functions in `history.ts`.
 * Both default to the real implementations (`Date.now`, and the id scheme `main.js:75` uses:
 * `'s' + base36 time + random`); tests inject a fake clock and a counter so assertions on ids
 * and timestamps are exact instead of "close enough".
 */
export interface SessionDeps {
	now(): number;
	newId(): string;
}
