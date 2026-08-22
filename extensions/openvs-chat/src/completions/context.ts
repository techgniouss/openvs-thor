/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionWindow } from './types';

/**
 * The parts of a text document this module needs. Declared structurally rather than taken
 * as a `vscode.TextDocument` so the windowing logic can be tested without an editor.
 */
export interface WindowDocument {
	readonly text: string;
	readonly languageId: string;
	readonly relativePath: string;
	readonly eol: '\n' | '\r\n';
}

/** Character budgets for the pieces of a {@link CompletionWindow}. */
export interface WindowLimits {
	readonly prefixChars: number;
	readonly suffixChars: number;
	/** Cap on the extracted import block, so a generated file's 500-line header can't dominate. */
	readonly importChars: number;
}

/** Line starts that count as part of a file's leading import block, across common languages. */
const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|#include\b|using\b|require\b|const\s+\{?[\w,\s}]*\}?\s*=\s*require\(|package\b|use\s+\S+;)/;

/**
 * Extracts the text around `offset` that a completion request is built from.
 *
 * Both windows are truncated from the far side: the characters nearest the cursor are the
 * ones that determine the completion, so the prefix keeps its tail and the suffix its head.
 * Everything is normalized to LF — the overlap arithmetic in `sanitize.ts` compares model
 * output against these strings, and a stray `\r` on one side of that comparison silently
 * defeats it. The document's real EOL travels on the window so {@link applyEol} can put it
 * back before the text is inserted.
 */
export function buildWindow(doc: WindowDocument, offset: number, limits: WindowLimits): CompletionWindow {
	const text = doc.text.replace(/\r\n/g, '\n');
	// The offset was measured against the original text; \r removal shifts it left by one
	// per preceding CRLF, so recompute it rather than trusting the caller's number.
	const removed = countCrLf(doc.text.slice(0, offset));
	const cursor = Math.max(0, Math.min(text.length, offset - removed));
	const before = text.slice(0, cursor);
	const after = text.slice(cursor);
	return {
		prefix: before.slice(-limits.prefixChars),
		suffix: after.slice(0, limits.suffixChars),
		languageId: doc.languageId,
		relativePath: doc.relativePath,
		imports: extractImports(text, limits.importChars),
		eol: doc.eol,
	};
}

/** How many CRLF pairs occur in `text`. */
function countCrLf(text: string): number {
	let count = 0;
	for (let i = text.indexOf('\r\n'); i !== -1; i = text.indexOf('\r\n', i + 2)) {
		count++;
	}
	return count;
}

/**
 * The file's leading import block, capped at `maxChars`.
 *
 * Sent separately from the prefix because in any file longer than the prefix budget the
 * window has slid past the top, and without the imports the model invents library names
 * instead of using the ones the file actually pulls in. Scanning stops at the first
 * non-blank, non-import line so a file body is never swept up.
 */
function extractImports(text: string, maxChars: number): string {
	const kept: string[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim() || line.trimStart().startsWith('//')) {
			continue;
		}
		if (!IMPORT_LINE.test(line)) {
			break;
		}
		kept.push(line);
	}
	return kept.join('\n').slice(0, maxChars);
}

/** Re-applies a document's end-of-line sequence to LF-normalized text before insertion. */
export function applyEol(text: string, eol: '\n' | '\r\n'): string {
	return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}
