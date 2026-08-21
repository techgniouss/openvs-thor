/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The cursor context a completion is judged against. LF-normalized (see `context.ts`). */
export interface SanitizeWindow {
	readonly prefix: string;
	readonly suffix: string;
}

/** Shape limits applied to a completion. */
export interface SanitizeLimits {
	/** Hard cap on returned lines. Automatic requests use a small value; explicit ones more. */
	readonly maxLines: number;
}

/**
 * Turns a model's raw reply into insertable ghost text, or into an empty string when there
 * is nothing usable in it.
 *
 * This exists because none of the backends here are completion models. Asked to continue
 * code, a chat model returns a fenced block, a sentence introducing the block, the prefix it
 * was given, and the suffix it was given — often all four. Each rule below corresponds to a
 * failure actually observed from the free-tier models this extension targets, and they run
 * in a fixed order because later rules assume earlier ones have already fired.
 */
export function sanitizeCompletion(raw: string, window: SanitizeWindow, limits: SanitizeLimits): string {
	let text = stripThinking(raw);
	text = unwrapFence(text, window);
	text = stripRestatedPrefix(text, window.prefix);
	text = stripRestatedSuffix(text, window.suffix);
	text = capLines(text, limits.maxLines);
	text = cutAtBlockExit(text, window.prefix);
	if (!text.trim()) {
		return '';
	}
	// A suggestion identical to what is already there is not a suggestion.
	if (window.suffix.startsWith(text)) {
		return '';
	}
	return text;
}

/**
 * Removes an inline reasoning block. `reasoning_content` is dropped at the provider layer;
 * this catches models that write the same thing into ordinary content instead.
 *
 * Falls back to end-of-text when there is no closing tag, not just a matched pair — unlike
 * `persona/thinking.ts`'s `stripThinkingTags` (case-sensitive, `<thinking>` only, no
 * unclosed-tag fallback), which exists for a full agent turn that is never deliberately cut
 * short. A completion request is: `COMPLETION_FETCH_OPTS` gives it a 2500ms timeout with no
 * retry, so a reasoning model's `<think>` block cut off mid-thought is an expected outcome,
 * not a rare one, and without the fallback the unclosed tag and its contents would pass
 * straight through as ghost text instead of being stripped to nothing.
 */
function stripThinking(text: string): string {
	return text.replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '');
}

/**
 * Keeps only the code when the model wrapped its answer in a fence, and drops leading prose
 * when it did not.
 *
 * When a fence is present it is unambiguous: everything outside it is commentary. Without
 * one, a line is treated as prose if it reads as a sentence and does not continue the
 * prefix's own indentation or syntax — the conservative reading, since returning prose as
 * ghost text is far worse than returning nothing.
 */
function unwrapFence(text: string, window: SanitizeWindow): string {
	const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/.exec(text);
	if (fence) {
		return trimTrailingNewline(fence[1]);
	}
	if (!/^\s*(here|sure|certainly|of course|okay|ok\b|this |the |i )/i.test(text)) {
		return text;
	}
	// Prose with no fence: keep only from the first line that plausibly is code.
	const lines = text.split('\n');
	const start = lines.findIndex(line => looksLikeCode(line, window.prefix));
	return start === -1 ? '' : lines.slice(start).join('\n');
}

/** Whether a line reads as code rather than as a sentence about code. */
function looksLikeCode(line: string, prefix: string): boolean {
	if (!line.trim()) {
		return false;
	}
	if (/[{};()=<>[\]]/.test(line)) {
		return true;
	}
	// An indented line inside an indented context is probably a continuation.
	const indent = /\n([ \t]*)$/.exec(prefix)?.[1] ?? '';
	return indent.length > 0 && line.startsWith(indent);
}

/**
 * Length of the longest overlap where a suffix of `a` equals a prefix of `b` (0 when there
 * is none). The shared scan behind both {@link stripRestatedPrefix} and
 * {@link stripRestatedSuffix} — they are the same overlap in opposite directions, and used
 * to be two independent copies that had already drifted (only one carried an empty-input
 * guard, itself redundant here: when either string is empty `max` is 0 and the loop below
 * never runs regardless).
 */
function overlapLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	for (let n = max; n > 0; n--) {
		if (a.endsWith(b.slice(0, n))) {
			return n;
		}
	}
	return 0;
}

/**
 * Drops a restated prefix. Models frequently echo the code they were given before adding
 * to it; inserted verbatim that duplicates whatever is already on screen. The longest
 * suffix of the prefix that the output opens with is the overlap to remove.
 */
function stripRestatedPrefix(text: string, prefix: string): string {
	return text.slice(overlapLength(prefix, text));
}

/**
 * Drops a restated suffix, which is what produces doubled closing brackets: the model
 * closes the block the editor has already closed below the cursor.
 */
function stripRestatedSuffix(text: string, suffix: string): string {
	return text.slice(0, text.length - overlapLength(text, suffix));
}

/** Hard cap on length. A model asked for one line will sometimes write a module. */
function capLines(text: string, maxLines: number): string {
	const lines = text.split('\n');
	return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n');
}

/**
 * Stops the completion where it leaves the block the cursor is in.
 *
 * A model given a cursor inside a function will sometimes finish the function, close it,
 * and start the next one. The signal for that is a line that both dedents *and* opens with
 * a closing bracket — dedent alone is not enough: a weaker free-tier model that skips
 * indentation entirely produces flat, unindented multi-line output that looks identical to
 * a block exit on line two under a pure indent comparison, and truncating that down to one
 * line is a far worse failure than leaving a few extra lines for `capLines` to bound.
 *
 * Scoped to bracket languages (JS/TS/C-family) by design — the closing-bracket check is
 * what lets a genuine dedent be told apart from a model that simply never indented. It is
 * a deliberate no-op for bracket-less languages (Python, YAML, Ruby): a block exit there is
 * still bounded by `capLines`'s `maxLines`, just not cut precisely. Extending this to
 * keyword-based dedent signals (`return`, `elif`, `end`, ...) needs its own test coverage
 * for those languages' completion shapes before it belongs in this file.
 */
function cutAtBlockExit(text: string, prefix: string): string {
	const indent = /(?:^|\n)([ \t]*)[^\n]*$/.exec(prefix)?.[1] ?? '';
	if (!indent) {
		return text;
	}
	const lines = text.split('\n');
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			continue;
		}
		const lineIndent = /^[ \t]*/.exec(line)?.[0] ?? '';
		const closesBlock = /^[ \t]*[}\)\]]/.test(line);
		if (lineIndent.length < indent.length && closesBlock) {
			return lines.slice(0, i).join('\n').replace(/\s+$/, '');
		}
	}
	return text;
}

/** Removes a single trailing newline left by a fence's closing line. */
function trimTrailingNewline(text: string): string {
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}
