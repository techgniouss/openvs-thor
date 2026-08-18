/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionStore } from '../session/store';
import { SessionState, SessionSummary } from '../session/types';

/**
 * Phase 5 of "remote control": what a newly-connected remote sink is caught up with. Minimal
 * on purpose — the plan's "Multi-sink egress" section describes a fuller catch-up (replay-ring
 * lookup by `seq` first, live run state, unanswered prompts re-posted) that this task does not
 * build; `remoteService.ts` calls {@link buildCatchUpMessages} once on connect and posts the
 * result via `bus.postTo`, which is enough for a phone to render its tab strip and the active
 * conversation instead of starting from nothing. The transcript half of that catch-up — tail-
 * windowed to `SessionStore.windowedMessages`'s default (30 turns / 48KB) — is no longer
 * duplicated here: it calls straight through to the same method `postTranscript` uses, so the
 * two "what does a reconnecting client get" implementations can't drift apart.
 */

/**
 * {@link SessionState} minus its transcript. Duplicated from `chatViewProvider.ts`'s private
 * `toSessionSummary` rather than importing it (that method isn't exported, and the mapping
 * itself is a handful of field picks, not logic worth threading a new export through the host's
 * largest file for) — keep this in sync with `toSessionSummary` by hand if `SessionSummary`
 * gains a field.
 */
function toSessionSummary(session: SessionState): SessionSummary {
	return {
		id: session.id,
		title: session.title,
		streaming: session.streaming,
		pending: session.pending,
		queue: session.queue,
		todos: session.todos,
		runId: session.runId,
		runMode: session.runMode,
		steerable: session.steerable,
		compactSummary: session.compactSummary,
		compactedUpTo: session.compactedUpTo,
		mode: session.mode,
		provider: session.provider,
		model: session.model,
	};
}

/**
 * Builds the catch-up frames for a remote sink that just connected: every session's metadata
 * (no transcripts — mirrors `postSessions()`), followed by the active session's tail-windowed
 * transcript (mirrors `postTranscript()`'s default window).
 */
export function buildCatchUpMessages(store: SessionStore): Array<Record<string, unknown> & { type: string }> {
	const activeId = store.getActiveId();
	return [
		{
			type: 'sessions',
			sessions: store.getSessions().map(toSessionSummary),
			activeSessionId: activeId,
		},
		{
			type: 'transcript',
			sessionId: activeId,
			...store.windowedMessages(activeId),
		},
	];
}
