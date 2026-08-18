/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HistoryEntry, SessionDeps, SessionState } from './types';

/**
 * How many archived conversations are kept. Mirrors `HISTORY_LIMIT` at `media/main.js:182` —
 * chosen as "enough to find last week's chat" without letting persisted state grow without
 * bound over months of use.
 */
export const HISTORY_LIMIT = 50;

/**
 * Archives `session` into `history`, returning the updated list (newest first). `history` is
 * left untouched (and returned as-is) when the session has nothing worth keeping — every
 * message in it is a UI notice (`kind` set), never something the user actually said or the
 * model actually answered — mirroring the skip guard at the top of `archiveSession` in
 * `media/main.js:762`.
 *
 * Image attachments are stripped from the archived copy: archived conversations are never
 * re-sent to a model, so the base64 payloads would only bloat persisted state — `persistence.ts`
 * additionally gives archived history a zero image budget for the same reason, but this
 * function does the actual stripping (into a `🖼 (image attachment not kept in history)`
 * marker) so the shape is right even before persistence ever sees it.
 *
 * A session already present in `history` (re-archiving the same id) is replaced, not
 * duplicated, and the result is trimmed to {@link HISTORY_LIMIT}.
 */
export function archiveSession(
	history: readonly HistoryEntry[],
	session: SessionState,
	deps: SessionDeps,
): HistoryEntry[] {
	if (!session.messages.some(m => !m.kind)) {
		return history as HistoryEntry[];
	}
	const firstUserMessage = session.messages.find(m => m.role === 'user' && !m.kind);
	const title = session.title || (firstUserMessage?.content || 'Untitled chat').slice(0, 28);
	const entry: HistoryEntry = {
		id: session.id,
		title,
		messages: session.messages.map(m => m.images?.length
			? { role: m.role, content: `🖼 (image attachment not kept in history)\n${m.content}`, kind: m.kind }
			: m),
		savedAt: deps.now(),
	};
	const withoutSelf = history.filter(h => h.id !== session.id);
	const merged = [entry, ...withoutSelf];
	return merged.length > HISTORY_LIMIT ? merged.slice(0, HISTORY_LIMIT) : merged;
}

/**
 * Merges `incoming` (typically the extension host's persisted archive) into `current`
 * (typically what a client already has in memory), keeping the newest copy of each
 * conversation id and trimming to {@link HISTORY_LIMIT}. Mirrors `mergeHistory` at
 * `media/main.js:786`.
 */
export function mergeHistory(
	current: readonly HistoryEntry[],
	incoming: readonly HistoryEntry[],
): HistoryEntry[] {
	const byId = new Map<string, HistoryEntry>();
	for (const h of [...incoming, ...current]) {
		if (!h || !h.id) {
			continue;
		}
		const prev = byId.get(h.id);
		if (!prev || (h.savedAt || 0) > (prev.savedAt || 0)) {
			byId.set(h.id, h);
		}
	}
	return [...byId.values()]
		.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
		.slice(0, HISTORY_LIMIT);
}
