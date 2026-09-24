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
 * instead of using the ones the file actually pulls in. Scanning stops at the first line that
 * is neither an import nor file preamble, so a file body is never swept up.
 *
 * Preamble — block comments (a license header), `#` comments and preprocessor guards, a
 * shebang, `'use strict'`-style directives, a Python module docstring — is stepped over, and
 * an import is followed until its brackets close (`import {` … `} from 'x';`, Go's
 * `import (` … `)`). Stopping at the first non-import line returned nothing for any file
 * with a header comment and cut every multi-line import at its first name.
 */
function extractImports(text: string, maxChars: number): string {
	const kept: string[] = [];
	let comment: string | undefined; // the terminator of the block comment/docstring we are in
	let open = 0; // unclosed brackets of the import statement being followed
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (open > 0) {
			kept.push(line);
			open += bracketBalance(line);
			continue;
		}
		if (comment) {
			if (trimmed.includes(comment)) {
				comment = undefined;
			}
			continue;
		}
		if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#!') || DIRECTIVE.test(trimmed)) {
			continue;
		}
		if (IMPORT_LINE.test(line)) {
			kept.push(line);
			open = Math.max(0, bracketBalance(line));
			continue;
		}
		const opener = BLOCK_OPENERS.find(([start]) => trimmed.startsWith(start));
		if (opener) {
			if (!trimmed.slice(opener[0].length).includes(opener[1])) {
				comment = opener[1];
			}
			continue;
		}
		if (trimmed.startsWith('#')) {
			continue; // a `#` comment, or a preprocessor line that is not an #include
		}
		break;
	}
	return kept.join('\n').slice(0, maxChars);
}

/** `'use strict';`, `"use client"`, … */
const DIRECTIVE = /^(['"])use [\w -]+\1;?$/;

/** Block constructs that may precede the imports, each with its terminator. */
const BLOCK_OPENERS: ReadonlyArray<readonly [string, string]> = [['/*', '*/'], ['"""', '"""'], ["'''", "'''"]];

/** Opening minus closing brackets on a line. */
function bracketBalance(line: string): number {
	let balance = 0;
	for (const ch of line) {
		if (ch === '{' || ch === '(') {
			balance++;
		} else if (ch === '}' || ch === ')') {
			balance--;
		}
	}
	return balance;
}

/** Re-applies a document's end-of-line sequence to LF-normalized text before insertion. */
export function applyEol(text: string, eol: '\n' | '\r\n'): string {
	return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}
