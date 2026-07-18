/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';
const OPEN_MARK = '🤔 *Thinking…*\n\n';
const CLOSE_MARK = '\n\n---\n\n';

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
 */
export class ThinkingStreamParser {
	private buffer = '';
	private inThinking = false;

	constructor(private readonly emit: (text: string) => void) { }

	/** Feed one streamed delta; visible text is emitted synchronously. */
	push(delta: string): void {
		this.buffer += delta;
		for (; ;) {
			const tag = this.inThinking ? CLOSE_TAG : OPEN_TAG;
			const idx = this.buffer.indexOf(tag);
			if (idx !== -1) {
				const before = this.buffer.slice(0, idx);
				if (before) {
					this.emit(before);
				}
				this.emit(this.inThinking ? CLOSE_MARK : OPEN_MARK);
				this.inThinking = !this.inThinking;
				this.buffer = this.buffer.slice(idx + tag.length);
				continue;
			}
			// No full tag: emit everything except a trailing partial-tag candidate.
			const hold = partialTagSuffix(this.buffer, tag);
			const emitLen = this.buffer.length - hold;
			if (emitLen > 0) {
				this.emit(this.buffer.slice(0, emitLen));
				this.buffer = this.buffer.slice(emitLen);
			}
			return;
		}
	}

	/** Stream ended: emit anything still buffered (partial tags become literal text). */
	flush(): void {
		if (this.buffer) {
			this.emit(this.buffer);
			this.buffer = '';
		}
		this.inThinking = false;
	}
}

/** Applies the same tag→markdown conversion to a complete, non-streamed text. */
export function formatThinking(text: string): string {
	let out = '';
	const parser = new ThinkingStreamParser(t => { out += t; });
	parser.push(text);
	parser.flush();
	return out;
}
