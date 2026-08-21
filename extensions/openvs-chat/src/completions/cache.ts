/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How much of each side of the cursor identifies a cache entry. */
const KEY_PREFIX_CHARS = 1024;
const KEY_SUFFIX_CHARS = 512;
/** Joins the key parts. A control character, so it cannot occur in source text. */
const KEY_SEPARATOR = '\u0000';

/**
 * Remembers recent completions so a cursor position already asked about costs nothing.
 *
 * The editor's `enableForwardStability` already covers typing *through* a suggestion, which
 * is the common case. What it does not cover is coming back: backspacing over a rejected
 * suggestion, undoing, or moving away and returning — each of which would otherwise be a
 * fresh request against a metered free tier for an answer that is already known.
 *
 * Insertion-ordered and bounded, so a long editing session cannot grow it without limit.
 */
export class CompletionCache {
	private readonly entries = new Map<string, string>();

	constructor(private readonly maxEntries = 100) { }

	/**
	 * The identity of a cursor position for caching purposes.
	 *
	 * Includes the model, because the same position answered by a different backend is a
	 * different answer, and the suffix, because an edit below the cursor changes what a
	 * correct completion is even when everything above it is untouched. Also includes the
	 * imports block — sent to the model separately from `prefix` and capable of changing what
	 * a correct completion is on its own (a new import in scope) even when the cursor's
	 * immediate surroundings did not change — and `invoked`, because an explicit request asks
	 * for more lines than an automatic one and must not be answered from a shorter entry an
	 * automatic request left behind at the same position.
	 */
	keyFor(model: string, prefix: string, suffix: string, imports = '', invoked = false): string {
		return [model, prefix.slice(-KEY_PREFIX_CHARS), suffix.slice(0, KEY_SUFFIX_CHARS), imports, invoked ? '1' : '0']
			.join(KEY_SEPARATOR);
	}

	get(key: string): string | undefined {
		return this.entries.get(key);
	}

	set(key: string, value: string): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) {
				this.entries.delete(oldest.value);
			}
		}
	}

	clear(): void {
		this.entries.clear();
	}
}
