/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure comparison logic for Phase 1b ("shadow mode") of "remote control": the host keeps its
 * own {@link SessionStore} copy of session state, built only from traffic it already sees,
 * while the webview stays authoritative. This module holds just the comparison — it is
 * exercised directly by `scripts/test-session-shadow.mjs` and, like the rest of `src/session/`,
 * imports nothing from `vscode`. The wiring that calls it (reading `chatViewProvider.ts`'s
 * already-computed history, deciding whether to log, writing to an `OutputChannel`) has to live
 * in `chatViewProvider.ts` itself, since that wiring needs `vscode` and this file must not.
 */

/**
 * Minimal transcript-entry shape {@link compareTranscripts} needs. Satisfied structurally by
 * both `TranscriptEntry` (this store's own shape) and the webview's `ChatMessage` (what a
 * `'send'` message actually carries), so a shadow check can compare across the two without
 * either importing the other's type.
 */
export interface ComparableEntry {
	readonly role: string;
	readonly content: string;
	/** Set only on a UI notice (see `TranscriptEntry.kind`); never present on `ChatMessage`. */
	readonly kind?: string;
}

/** One entry's role and (truncated) content, as reported in a {@link TranscriptDivergence}. */
export interface DivergentEntry {
	readonly role: string;
	readonly content: string;
}

/**
 * One divergence found between the host's shadow copy and what the webview actually sent.
 * `index` is the first position the two disagree at, within the *sendable* view of both sides
 * (see {@link compareTranscripts}'s notice filter). `expected`/`actual` are that entry on each
 * side; either is `undefined` when that side simply has no entry there — i.e. the other side is
 * longer, which is itself the divergence being reported.
 */
export interface TranscriptDivergence {
	readonly index: number;
	readonly expectedLength: number;
	readonly actualLength: number;
	readonly expected?: DivergentEntry;
	readonly actual?: DivergentEntry;
}

/** A log line stays readable and never dumps a full multi-KB tool result verbatim. */
const TRUNCATE_LEN = 80;

function truncate(content: string): string {
	return content.length > TRUNCATE_LEN ? `${content.slice(0, TRUNCATE_LEN)}…` : content;
}

/**
 * Ported from `tidyResponse` at `media/main.js:1849-1859`: the webview normalizes a finished
 * assistant turn's text (trailing whitespace per line, runs of 3+ blank lines, leading/trailing
 * trim) before storing and re-sending it as history. The host's shadow copy stores the raw text
 * an `agentStepEnd`/streaming result carried instead, so without this, a whitespace-only
 * difference the webview itself introduces on every turn would be reported as a divergence on
 * every comparison — a permanent false positive, not a real drift between the two copies.
 *
 * Fence-aware like the original: content inside a fenced ``` code block is left byte-for-byte
 * untouched, since collapsing blank lines or trailing spaces there would be a real content
 * change (e.g. inside a here-doc or a language that is whitespace-significant), and the
 * comparator must still catch that as a divergence.
 */
export function normalizeForComparison(text: string): string {
	if (!text) {
		return text;
	}
	const parts = text.split(/(```[\s\S]*?```)/g);
	const cleaned = parts.map((part, i) => {
		if (i % 2 === 1) {
			return part; // odd chunks are fenced code blocks — keep as-is
		}
		return part
			.replace(/[ \t]+$/gm, '')      // trailing whitespace per line
			.replace(/\n{3,}/g, '\n\n');   // no runs of blank lines
	}).join('');
	return cleaned.trim();
}

function describeEntry(entry: ComparableEntry | undefined): DivergentEntry | undefined {
	return entry ? { role: entry.role, content: truncate(entry.content) } : undefined;
}

/**
 * Drops entries that were never sendable to begin with — mirrors the `kind` half of
 * `SessionStore.sendableMessages`'s own filter. Without this, a UI notice present on only one
 * side (e.g. the store's shadow copy carries an `'info'` entry the webview's payload never had
 * reason to include) would be reported as a divergence, even though `sendableMessages` already
 * excludes it from what either side would actually send to a model — a false positive.
 */
function sendableView(entries: readonly ComparableEntry[]): ComparableEntry[] {
	return entries.filter(e => !e.kind);
}

/**
 * Compares two transcripts, filtering both to their sendable view first, and returns the first
 * place they disagree — or `undefined` when they match. Content is compared through
 * {@link normalizeForComparison} on both sides first, so a whitespace-only difference the
 * webview's own `tidyResponse` introduces is not reported as a divergence. Pure and
 * side-effect-free: `chatViewProvider.ts` decides what to do with the result (log it, gated on
 * `openvsChat.remote.traceSessions`, or nothing at all).
 */
export function compareTranscripts(
	expected: readonly ComparableEntry[],
	actual: readonly ComparableEntry[],
): TranscriptDivergence | undefined {
	const e = sendableView(expected);
	const a = sendableView(actual);
	const shared = Math.min(e.length, a.length);
	for (let i = 0; i < shared; i++) {
		if (e[i].role !== a[i].role || normalizeForComparison(e[i].content) !== normalizeForComparison(a[i].content)) {
			return {
				index: i,
				expectedLength: e.length,
				actualLength: a.length,
				expected: describeEntry(e[i]),
				actual: describeEntry(a[i]),
			};
		}
	}
	if (e.length !== a.length) {
		return {
			index: shared,
			expectedLength: e.length,
			actualLength: a.length,
			expected: describeEntry(e[shared]),
			actual: describeEntry(a[shared]),
		};
	}
	return undefined;
}
