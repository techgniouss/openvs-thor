/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

/**
 * The markers that delimit a rendered thinking block in the token stream. Exported so
 * the providers that stream native reasoning emit byte-identical markers — the webview
 * collapses a block by matching them, and a marker that differs by one character renders
 * as literal text in the middle of the answer.
 */
export const OPEN_MARK = '🤔 *Thinking…*\n\n';
export const CLOSE_MARK = '\n\n---\n\n';

/**
 * How long the block took, emitted just inside its closing marker.
 *
 * It has to live in the text rather than in a live timer: the transcript is re-rendered
 * from the stored string whenever the user switches tabs or reloads the window, long
 * after any timer is gone. {@link stripThinking} drops it with the rest of the block, so
 * the model never sees it.
 */
function durationNote(ms: number): string {
	return `\n\n[thought for ${Math.max(1, Math.round(ms / 1000))}s]`;
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagSuffix(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let len = max; len > 0; len--) {
		if (text.endsWith(tag.slice(0, len))) {
			return len;
		}
	}
	return 0;
}

/**
 * Streaming state machine that rewrites `<thinking>…</thinking>` blocks into the same
 * inline markdown convention native reasoning models already use ("🤔 *Thinking…*"
 * prefix, `---` separator — see openaiCompatible.ts). Text outside the tags passes
 * through untouched. Handles tags split across arbitrary chunk boundaries. On
 * malformed input (unclosed tag, partial tag at end of stream) `flush()` emits
 * whatever was buffered, so user-visible text is never dropped.
 *
 * It is also where every visible token stream converges — tag-based reasoning is
 * rewritten here, and native reasoning (already marked up by the provider) passes
 * through — so it is the one place that can time a thinking block, whoever produced it.
 */
export class ThinkingStreamParser {
	private buffer = '';
	private inThinking = false;
	/** When the current thinking block opened; 0 when not inside one. */
	private openedAt = 0;

	/**
	 * @param emit Sink for visible text.
	 * @param timing Stamp each block with how long it took. Off for
	 * {@link formatThinking}, which reformats finished text and has nothing to time.
	 */
	constructor(private readonly emit: (text: string) => void, private readonly timing = true) { }

	/** Emits one chunk, timing the thinking markers as they go past. */
	private send(text: string): void {
		if (this.timing) {
			if (text === OPEN_MARK) {
				this.openedAt = Date.now();
			} else if (text === CLOSE_MARK && this.openedAt) {
				this.emit(durationNote(Date.now() - this.openedAt));
				this.openedAt = 0;
			}
		}
		this.emit(text);
	}

	/** Feed one streamed delta; visible text is emitted synchronously. */
	push(delta: string): void {
		this.buffer += delta;
		for (; ;) {
			const tag = this.inThinking ? CLOSE_TAG : OPEN_TAG;
			const idx = this.buffer.indexOf(tag);
			if (idx !== -1) {
				const before = this.buffer.slice(0, idx);
				if (before) {
					this.send(before);
				}
				this.send(this.inThinking ? CLOSE_MARK : OPEN_MARK);
				this.inThinking = !this.inThinking;
				this.buffer = this.buffer.slice(idx + tag.length);
				continue;
			}
			// No full tag: emit everything except a trailing partial-tag candidate.
			const hold = partialTagSuffix(this.buffer, tag);
			const emitLen = this.buffer.length - hold;
			if (emitLen > 0) {
				this.send(this.buffer.slice(0, emitLen));
				this.buffer = this.buffer.slice(emitLen);
			}
			return;
		}
	}

	/** Stream ended: emit anything still buffered (partial tags become literal text). */
	flush(): void {
		if (this.buffer) {
			this.send(this.buffer);
			this.buffer = '';
		}
		// A stream that died inside a thinking block never emitted a closing marker, so
		// stamp it here — otherwise the block is stuck reading "Thinking…" forever.
		if (this.openedAt) {
			this.emit(durationNote(Date.now() - this.openedAt));
			this.openedAt = 0;
		}
		this.inThinking = false;
	}
}

/** Applies the same tag→markdown conversion to a complete, non-streamed text. */
export function formatThinking(text: string): string {
	let out = '';
	const parser = new ThinkingStreamParser(t => { out += t; }, false);
	parser.push(text);
	parser.flush();
	return out;
}

/**
 * Matches a rendered thinking block: the OPEN_MARK, lazily up to the CLOSE_MARK
 * separator or end of text (a stream that died inside a thinking block never
 * emitted the separator — everything after the marker was reasoning).
 */
const THINKING_BLOCK = /🤔 \*Thinking…\*\n\n[\s\S]*?(?:\n\n---\n\n|$)/g;

/**
 * Removes rendered thinking blocks from a committed reply. The transcript shown to
 * the user keeps them, but re-sending past reasoning as history on every subsequent
 * turn is pure token waste — the model never needs its own stale thinking back.
 */
export function stripThinking(text: string): string {
	if (!text.includes(OPEN_MARK)) {
		return text;
	}
	return text.replace(THINKING_BLOCK, '').trim();
}

/** The subset of a chat message {@link stripHistoryThinking} needs; keeps this module free of provider imports. */
interface HistoryMessage {
	role: string;
	content: string;
	images?: unknown[];
	toolCalls?: unknown[];
}

/**
 * Prepares webview history for dispatch: past assistant turns still carry their rendered
 * thinking blocks, and re-sending the model its own stale reasoning is pure token waste.
 *
 * A turn that was *nothing but* reasoning strips down to the empty string, and those must
 * be dropped rather than sent: several OpenAI-compatible gateways (NVIDIA among them)
 * reject an assistant message with empty content, which fails the whole request instead
 * of just that turn.
 */
export function stripHistoryThinking<T extends HistoryMessage>(history: T[]): T[] {
	const out: T[] = [];
	for (const m of history) {
		if (m.role !== 'assistant') {
			out.push(m);
			continue;
		}
		const content = stripThinking(m.content);
		if (content || m.images?.length || m.toolCalls?.length) {
			out.push({ ...m, content });
		}
	}
	return out;
}
