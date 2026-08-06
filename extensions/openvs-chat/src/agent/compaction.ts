/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '../providers/types';
import { dropOrphanToolResults, estimateMessagesTokens, trimMessages } from './context';

/**
 * Conversation auto-compaction. Trimming (context.ts) is a lossy emergency valve —
 * it blanks old tool output and drops turns once the budget is already blown.
 * Compaction runs *before* that point: when the conversation crosses a share of the
 * model's context window, the old middle turns are replaced by a model-written
 * summary, preserving the task state in far fewer tokens.
 */

/**
 * Share of the model's context window at which compaction kicks in on a backend that does
 * NOT cache prompt prefixes (NVIDIA's gateway, most local/self-hosted endpoints).
 *
 * Deliberately well under the window rather than just inside it. An agent step re-sends
 * the entire conversation, so with no caching the per-step cost is the conversation's
 * current size and the run's total cost is quadratic in its length. Letting the history
 * grow to 70% of a 128k window meant every step past that point paid ~85k tokens of
 * prefill before the model emitted a character. Compacting earlier trades a handful of
 * extra summarizer calls for a prompt that stays roughly half the size for the rest of
 * the run, which is the better bargain by a wide margin.
 */
export const COMPACT_TRIGGER = 0.45;

/**
 * The same share on a backend that DOES cache prompt prefixes (see
 * `ProviderInfo.cachesPrompts`).
 *
 * There the bargain inverts. A long prompt is served from cache — cheap and quick to first
 * token — while compaction costs a summarizer call *and* rewrites the middle of the
 * conversation, which invalidates the cached prefix and makes the next step pay full
 * price for everything. So compaction stays where it was: a measure for staying inside
 * the window, not a cost control.
 */
export const CACHED_COMPACT_TRIGGER = 0.7;

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

/**
 * Response budget for the summary itself. Exported because callers must deduct it from what
 * they allow the summarizer to *send*: a backend charges the reservation and the prompt
 * against the same per-request allowance, so budgeting only the prompt overshoots by exactly
 * this much.
 */
export const SUMMARY_MAX_TOKENS = 1_500;

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
 * Normally `trigger` ({@link COMPACT_TRIGGER}, or {@link CACHED_COMPACT_TRIGGER} on a
 * caching backend) of the model's window. But the conversation is also subject to
 * `trimBudget` — the lossy trim that blanks old tool output — and on a small window that
 * budget can bite first: it reserves the whole response allowance up front, so for a
 * tight window (or a user-pinned `maxContextTokens`) the share can land *above* it.
 * Trimming would then degrade the conversation before compaction ever got a chance to
 * summarize it. Clamping to the budget's headroom keeps compaction first for every model,
 * which is the entire point of having it.
 */
export function compactionThreshold(contextWindow: number, trimBudget?: number, trigger = COMPACT_TRIGGER): number {
	const byWindow = contextWindow * trigger;
	return trimBudget && trimBudget > 0 ? Math.min(byWindow, trimBudget * TRIM_HEADROOM) : byWindow;
}

/**
 * True when `messages` have grown past the point where compaction should run. Pass
 * `trimBudget` (the ceiling handed to {@link trimMessages}) wherever it is known, so the
 * threshold accounts for it — see {@link compactionThreshold}.
 */
export function shouldCompact(
	messages: ChatMessage[],
	contextWindow: number,
	trimBudget?: number,
	trigger?: number,
	/** Tokens the request carries beyond the messages — the tool schemas. See `estimateToolsTokens`. */
	extraTokens = 0,
): boolean {
	return contextWindow > 0
		&& estimateMessagesTokens(messages) + extraTokens > compactionThreshold(contextWindow, trimBudget, trigger);
}

/**
 * Whether there is currently enough middle to be worth summarizing. Distinct from a
 * compaction *failure*: this is transient — a run that has not yet accumulated enough
 * turns will qualify a few steps later — so callers must not treat it as terminal.
 */
export function canCompact(messages: ChatMessage[], keepHead?: number): boolean {
	const start = keepHead === undefined ? firstTurnEnd(messages) : Math.min(Math.max(keepHead, 0), messages.length);
	return start >= 0 && (messages.length - KEEP_RECENT_TURNS) - start >= MIN_COMPACTABLE;
}

/**
 * Rewrites tool calls and tool results as plain prose turns.
 *
 * The summarizer is a normal chat completion with no `tools` declared, and the slice it
 * summarizes is cut at a fixed offset from the tail — so it routinely ends mid tool
 * sequence. Sent as-is that is an invalid request: OpenAI rejects an assistant
 * `tool_calls` with no answering `tool` messages, and Anthropic rejects `tool_use` /
 * `tool_result` blocks whenever `tools` is undefined, which is always here. Both 400s
 * were swallowed by the caller's catch, so compaction silently degraded to the lossy
 * trim it exists to replace. Flattening keeps the same information as text.
 */
function flattenToolTurns(messages: ChatMessage[]): ChatMessage[] {
	return messages.map(m => {
		if (m.role === 'tool') {
			return { role: 'user' as const, content: `[tool result] ${m.content}` };
		}
		if (m.toolCalls?.length) {
			const calls = m.toolCalls.map(c => `[tool call: ${c.name}(${safeArgs(c.args)})]`).join('\n');
			return { role: 'assistant' as const, content: m.content ? `${m.content}\n${calls}` : calls };
		}
		return m;
	});
}

/** Compact, non-throwing rendering of tool arguments for the summarizer transcript. */
function safeArgs(args: Record<string, unknown>): string {
	try {
		const s = JSON.stringify(args) ?? '';
		return s.length > 200 ? `${s.slice(0, 200)}…` : s;
	} catch {
		return '';
	}
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
 *
 * `maxInputTokens` bounds what the summarizer is *sent*. Without it this function asked the
 * model to read the entire conversation up to the tail, at full size — making the summarizer
 * call the largest single request a run ever made, larger than any agent step, since those
 * are trimmed to the context budget and this was not. On a backend with a tight per-request
 * allowance it therefore failed every time, twice in a row, and compaction switched itself
 * off for the rest of the run — on exactly the providers whose cost it exists to control.
 * Trimming happens *before* the tool turns are flattened, so the pass can still recognize
 * bulky tool output and blank it, keeping the narration a summary is actually made of.
 */
export async function compactMessages(
	messages: ChatMessage[],
	summarize: (messages: ChatMessage[], maxTokens: number) => Promise<string>,
	keepHead?: number,
	maxInputTokens?: number,
): Promise<{ messages: ChatMessage[]; before: number; after: number; replaced: number } | undefined> {
	const start = keepHead === undefined ? firstTurnEnd(messages) : Math.min(Math.max(keepHead, 0), messages.length);
	if (start < 0) {
		return undefined;
	}
	const end = messages.length - KEEP_RECENT_TURNS;
	if (end - start < MIN_COMPACTABLE) {
		return undefined;
	}
	const slice = messages.slice(0, end);
	const bounded = maxInputTokens && maxInputTokens > 0;
	// Two stages, because they can do different things. The first runs while tool turns are
	// still tool turns, so it can recognize a bulky file dump and blank it while leaving the
	// narration a summary is actually made of. The second runs on the finished payload,
	// because flattening ADDS characters — a `[tool result] ` prefix per turn — and a bound
	// measured before that is not the bound the request is judged by. Usually a no-op; on a
	// transcript of many small tool turns it was a 300-token overshoot, which is exactly the
	// margin a tight per-request allowance does not have.
	const payload = [
		...flattenToolTurns(bounded ? trimMessages(slice, maxInputTokens) : slice),
		{ role: 'user' as const, content: SUMMARY_PROMPT },
	];
	let summary: string;
	try {
		summary = (await summarize(bounded ? trimMessages(payload, maxInputTokens) : payload, SUMMARY_MAX_TOKENS)).trim();
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
