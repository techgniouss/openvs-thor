/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/context.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-context.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/context.js', import.meta.url));

const limits = { prefixChars: 20, suffixChars: 10, importChars: 200 };
const doc = (text, extra = {}) => ({
	text, languageId: 'typescript', relativePath: 'src/a.ts', eol: '\n', ...extra,
});

// Basic split at the cursor offset.
{
	const w = m.buildWindow(doc('const a = 1;\nconst b = '), 24, limits);
	assert.strictEqual(w.suffix, '');
	assert.ok(w.prefix.endsWith('const b = '));
	assert.strictEqual(w.languageId, 'typescript');
	assert.strictEqual(w.relativePath, 'src/a.ts');
}

// Windows are truncated from the near side: the characters closest to the cursor are the
// ones that matter, so prefix keeps its tail and suffix keeps its head.
{
	const w = m.buildWindow(doc('0123456789abcdefghijklmnopqrstuvwxyz'), 30, limits);
	assert.strictEqual(w.prefix.length, 20);
	assert.strictEqual(w.prefix, 'abcdefghijklmnopqrst', 'prefix keeps the 20 chars before the cursor');
	assert.strictEqual(w.suffix, 'uvwxyz', 'suffix is shorter than its cap here');
}

// File boundaries are not an error.
{
	assert.strictEqual(m.buildWindow(doc('abc'), 0, limits).prefix, '');
	assert.strictEqual(m.buildWindow(doc('abc'), 3, limits).suffix, '');
}

// CRLF: the window is normalized to LF so the overlap arithmetic in sanitize.ts is not
// thrown off by a stray \r, but the document's real EOL is carried for re-application.
{
	const w = m.buildWindow(doc('let x = 1;\r\nlet y = 2;\r\n', { eol: '\r\n' }), 24, limits);
	assert.strictEqual(w.eol, '\r\n');
	assert.ok(!w.prefix.includes('\r'), 'window is LF-normalized');
}

// The import block is extracted so it can be re-attached even when the cursor is far past
// it and the prefix window has slid off the top of the file.
{
	const text = 'import { readFile } from "fs";\nimport path from "path";\n\n' + 'x\n'.repeat(400) + 'const q = ';
	const w = m.buildWindow(doc(text), text.length, { prefixChars: 40, suffixChars: 10, importChars: 200 });
	assert.ok(w.imports.includes('import { readFile } from "fs";'));
	assert.ok(w.imports.includes('import path from "path";'));
	assert.ok(!w.prefix.includes('import'), 'the prefix window has slid past the imports');
}

// A file with no import block yields an empty string, not undefined.
assert.strictEqual(m.buildWindow(doc('const a = 1;'), 12, limits).imports, '');

// applyEol converts back on the way out, and leaves an LF document alone.
assert.strictEqual(m.applyEol('a\nb', '\r\n'), 'a\r\nb');
assert.strictEqual(m.applyEol('a\nb', '\n'), 'a\nb');

console.log('all assertions passed');
