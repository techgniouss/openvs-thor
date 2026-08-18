/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMode, HistoryEntry, SessionDeps, SessionMemento, SessionState, TranscriptEntry, Thenable } from './types';

/** Workspace-state key this store's persisted payload is saved under. */
export const PERSISTENCE_KEY = 'openvsChat.sessions';

/**
 * Total base64 image data kept in a persisted payload, newest message first, across every
 * session combined. Mirrors `MAX_PERSISTED_IMAGE_BYTES` at `media/main.js:229`: attachments
 * live in `messages` as base64, and the whole payload is re-serialized on every save, so a few
 * multi-megabyte screenshots would turn each save into a large synchronous write. Recent
 * images are the ones still worth restoring; older ones are replaced by a marker so the
 * transcript still shows one was there. Only what gets persisted is affected — a live
 * session's own `messages` are never touched by this budget.
 */
export const MAX_PERSISTED_IMAGE_BYTES = 2 * 1024 * 1024;

/** Remaining image-byte allowance, threaded through {@link messagesForState} across sessions. */
export interface PersistedImageBudget {
	left: number;
}

/**
 * Copies `messages` for persistence, keeping image data only while `budget` allows it.
 * `budget` is threaded through by the caller (see {@link buildPersistedState}) so the cap
 * applies globally, not per session. Ported from `messagesForState` at `media/main.js:237`:
 * spends the budget newest-message-first, since the tail of a conversation is what a reload
 * most needs intact.
 */
export function messagesForState(
	messages: readonly TranscriptEntry[],
	budget: PersistedImageBudget,
): TranscriptEntry[] {
	const out: TranscriptEntry[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m.images?.length) {
			out.push(m);
			continue;
		}
		const bytes = m.images.reduce((sum, img) => sum + img.data.length, 0);
		if (bytes <= budget.left) {
			budget.left -= bytes;
			out.push(m);
		} else {
			const count = m.images.length;
			const note = `\n\n_[${count} image${count === 1 ? '' : 's'} not kept after reload]_`;
			out.push({ role: m.role, content: (m.content || '') + note, kind: m.kind });
		}
	}
	return out.reverse();
}

/** One session's persisted shape — a {@link SessionState} minus its live-run fields. */
export interface PersistedSession {
	readonly id: string;
	readonly title: string;
	readonly messages: TranscriptEntry[];
	readonly queue: string[];
	readonly compactSummary?: string;
	readonly compactedUpTo?: number;
	readonly mode: ChatMode;
	readonly provider?: string;
	readonly model?: string;
}

/** The full payload saved under {@link PERSISTENCE_KEY}. */
export interface PersistedState {
	readonly sessions: PersistedSession[];
	readonly activeSessionId: string;
	readonly history: HistoryEntry[];
}

/**
 * Builds the payload to persist for a set of live sessions plus their archive. Ported from the
 * budget-allocation ordering in `saveState` at `media/main.js:259`: the image budget is spent
 * newest-message-first *within* a session (via {@link messagesForState}) and sessions are
 * given first claim on that shared budget active-first, so the tab the user is actually
 * looking at keeps its screenshots even if a background tab would otherwise have spent the
 * budget first. Archived history is always given a zero image budget, since archived messages
 * are never re-sent to a model and so buy nothing by staying attached.
 *
 * `sessions` and `history` are read but not mutated; the tab-strip order of the returned
 * `sessions` array matches the input, independent of the priority order used only to spend
 * the budget.
 */
export function buildPersistedState(
	sessions: readonly SessionState[],
	activeSessionId: string,
	history: readonly HistoryEntry[],
): PersistedState {
	const budget: PersistedImageBudget = { left: MAX_PERSISTED_IMAGE_BYTES };
	const byPriority = [...sessions].sort((a, b) =>
		(a.id === activeSessionId ? 0 : 1) - (b.id === activeSessionId ? 0 : 1));
	const kept = new Map<string, TranscriptEntry[]>();
	for (const s of byPriority) {
		kept.set(s.id, messagesForState(s.messages, budget));
	}
	return {
		sessions: sessions.map(s => ({
			id: s.id,
			title: s.title,
			messages: kept.get(s.id) ?? s.messages,
			queue: s.queue,
			compactSummary: s.compactSummary,
			compactedUpTo: s.compactedUpTo,
			mode: s.mode,
			provider: s.provider,
			model: s.model,
		})),
		activeSessionId,
		// Archived conversations are never re-sent to a model, so their image bytes buy
		// nothing at all and are dropped outright (a zero budget).
		history: history.map(h => ({ ...h, messages: messagesForState(h.messages, { left: 0 }) })),
	};
}

/** Persists `state` under {@link PERSISTENCE_KEY}. */
export function saveState(memento: SessionMemento, state: PersistedState): Thenable<void> {
	return memento.update(PERSISTENCE_KEY, state);
}

/** Reads back a previously {@link saveState}d payload, or `undefined` if none was ever saved. */
export function loadState(memento: SessionMemento): PersistedState | undefined {
	return memento.get<PersistedState | undefined>(PERSISTENCE_KEY, undefined);
}

// ---- Legacy (pre-Phase-1a webview state) migration --------------------------------

/** One session entry in the webview's pre-refactor `vscode.getState()` payload. */
export interface LegacyPersistedSession {
	readonly id?: string;
	readonly title?: string;
	readonly messages?: TranscriptEntry[];
	readonly queue?: string[];
	readonly compactSummary?: string;
	readonly compactedUpTo?: number;
}

/**
 * The webview's own pre-refactor `vscode.getState()` shape (see `media/main.js:184-213`),
 * including the pre-tabs single-`messages` form from before chat tabs existed at all.
 */
export interface LegacyPersistedState {
	readonly sessions?: readonly LegacyPersistedSession[];
	/** Pre-tabs single-conversation shape, present only in state saved before chat tabs existed. */
	readonly messages?: TranscriptEntry[];
	readonly mode?: string;
	readonly selectedProvider?: string;
	readonly history?: readonly HistoryEntry[];
}

/** What {@link adoptLegacyState} recovers from a pre-refactor payload. */
export interface AdoptedLegacyState {
	readonly sessions: SessionState[];
	readonly activeSessionId: string;
	readonly history: HistoryEntry[];
	readonly provider?: string;
}

/**
 * Imports a webview's pre-refactor `vscode.getState()` payload into the shape a
 * {@link SessionStore} can be {@link SessionStore.hydrate}d with. Ported from the restore
 * logic at `media/main.js:184-213`, including both migrations it performs: the pre-tabs
 * single-`messages` payload becomes one session, and a persisted `mode: 'edit'` (the mode
 * 'plan' replaced) becomes `'plan'`.
 *
 * Deliberately **does not** port the webview's own next step (`media/main.js:210-212`),
 * which archives every recovered session instead of restoring it live. That existed only
 * because the webview had nowhere to keep a live run across a reload; the host does. Keeping
 * these sessions live is the actual improvement this refactor buys — restoring a run across a
 * reload instead of it always being one click away in History — so archiving them here would
 * throw that improvement away before it ever ships. Nothing calls this function yet: it is
 * dead code until a later phase wires session ownership into the host.
 */
export function adoptLegacyState(state: LegacyPersistedState, deps: SessionDeps): AdoptedLegacyState {
	const history = Array.isArray(state.history) ? [...state.history] : [];
	const mode: ChatMode = state.mode === 'edit' ? 'plan' : ((state.mode as ChatMode) || 'ask');
	const provider = state.selectedProvider || undefined;

	const sessions: SessionState[] = Array.isArray(state.sessions) && state.sessions.length
		? state.sessions.map(s => ({
			id: s.id || deps.newId(),
			title: s.title || '',
			messages: Array.isArray(s.messages) ? s.messages : [],
			streaming: false,
			pending: null,
			queue: Array.isArray(s.queue) ? s.queue : [],
			todos: [],
			compactSummary: s.compactSummary,
			compactedUpTo: s.compactedUpTo,
			mode,
		}))
		: (Array.isArray(state.messages) && state.messages.length
			? [{
				id: deps.newId(),
				title: '',
				messages: state.messages,
				streaming: false,
				pending: null,
				queue: [],
				todos: [],
				mode,
			}]
			: []);

	return {
		sessions,
		activeSessionId: sessions[0]?.id ?? '',
		history,
		provider,
	};
}
