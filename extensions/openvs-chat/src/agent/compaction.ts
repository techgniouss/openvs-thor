/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '../providers/types';
import { dropOrphanToolResults, estimateMessagesTokens } from './context';

/**
 * Conversation auto-compaction. Trimming (context.ts) is a lossy emergency valve —
 * it blanks old tool output and drops turns once the budget is already blown.
 * Compaction runs *before* that point: when the conversation crosses a share of the
 * model's context window, the old middle turns are replaced by a model-written
 * summary, preserving the task state in far fewer tokens.
 */

/** Share of the model's context window at which compaction kicks in. */
export const COMPACT_TRIGGER = 0.7;

/**
 * Share of the trim budget compaction must stay under. Trimming is the lossy fallback,
 * so compaction has to get there first; this leaves a margin for the token estimate
 * being approximate.
 */
const TRIM_HEADROOM = 0.9;

/** Recent turns always kept verbatim — they carry the working state. */
const KEEP_RECENT_TURNS = 6;

/** Below this many compactable turns, a summary would cost more than it saves. */
const MIN_COMPACTABLE = 4;

/** Response budget for the summary itself. */
const SUMMARY_MAX_TOKENS = 1_500;

/** Prefix of the synthetic turn that replaces compacted history. */
export const COMPACT_MARKER = '[Conversation summary — earlier turns were compacted]';

const SUMMARY_PROMPT =
	'Summarize the conversation above for your own future reference; older turns will be ' +
	'replaced by this summary. Structure it as:\n' +
	'## Goal\n## Decisions & findings\n## Files read or changed (exact paths)\n' +
	'## Verification state (commands run, results)\n## Pending work\n' +
	'Be specific, keep exact paths and identifiers, stay under 400 words. Output only the summary.';

/**
 * The estimated-token count at which compaction should run.
 *
 * Normally {@link COMPACT_TRIGGER} of the model's window. But the conversation is also
 * subject to `trimBudget` — the lossy trim that blanks old tool output — and on a small
 * window that budget bites first: it reserves the whole response allowance up front, so
 * for any window below roughly ten times `maxTokens` (a 32k local model, say) 70% of the
 * window lands *above* it. Trimming would then degrade the conversation before compaction
 * ever got a chance to summarize it. Clamping to the budget's headroom keeps compaction
 * first for every model, which is the entire point of having it.
 */
export function compactionThreshold(contextWindow: number, trimBudget?: number): number {
	const byWindow = contextWindow * COMPACT_TRIGGER;
	return trimBudget && trimBudget > 0 ? Math.min(byWindow, trimBudget * TRIM_HEADROOM) : byWindow;
}

/**
 * True when `messages` have grown past the point where compaction should run. Pass
 * `trimBudget` (the ceiling handed to {@link trimMessages}) wherever it is known, so the
 * threshold accounts for it — see {@link compactionThreshold}.
 */
export function shouldCompact(messages: ChatMessage[], contextWindow: number, trimBudget?: number): boolean {
	return contextWindow > 0 && estimateMessagesTokens(messages) > compactionThreshold(contextWindow, trimBudget);
}

/**
 * Index just past the first user turn, or -1 when there is none. Only a safe default
 * when the first user turn really is the task — see {@link compactMessages}'s `keepHead`.
 */
function firstTurnEnd(messages: ChatMessage[]): number {
	const firstUser = messages.findIndex(m => m.role === 'user');
	return firstUser === -1 ? -1 : firstUser + 1;
}

/**
 * Replaces the compactable middle of `messages` (everything between the head and the
 * last {@link KEEP_RECENT_TURNS}) with one summary turn produced by `summarize`.
 * Returns undefined when there is too little to compact or the summarizer
 * fails/returns nothing — callers then fall back to plain trimming.
 *
 * `keepHead` is how many leading messages to preserve verbatim. Pass it whenever the
 * caller knows the layout: an assembled request is `[system, attached context?, the
 * request, …]`, and the default — preserve through the first user turn — would then
 * protect the bulky context blob while summarizing away the request itself. Omit it
 * only for a bare conversation whose first user turn genuinely is the task.
 */
export async function compactMessages(
	messages: ChatMessage[],
	summarize: (messages: ChatMessage[], maxTokens: number) => Promise<string>,
	keepHead?: number,
): Promise<{ messages: ChatMessage[]; before: number; after: number; replaced: number } | undefined> {
	const start = keepHead === undefined ? firstTurnEnd(messages) : Math.min(Math.max(keepHead, 0), messages.length);
	if (start < 0) {
		return undefined;
	}
	const end = messages.length - KEEP_RECENT_TURNS;
	if (end - start < MIN_COMPACTABLE) {
		return undefined;
	}
	let summary: string;
	try {
		summary = (await summarize(
			[...messages.slice(0, end), { role: 'user', content: SUMMARY_PROMPT }],
			SUMMARY_MAX_TOKENS,
		)).trim();
	} catch {
		return undefined;
	}
	if (!summary) {
		return undefined;
	}
	const compacted = dropOrphanToolResults([
		...messages.slice(0, start),
		{ role: 'user', content: `${COMPACT_MARKER}\n\n${summary}` },
		...messages.slice(end),
	]);
	return {
		messages: compacted,
		before: estimateMessagesTokens(messages),
		after: estimateMessagesTokens(compacted),
		replaced: end - start,
	};
}
