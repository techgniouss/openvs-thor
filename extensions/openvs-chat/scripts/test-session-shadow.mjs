/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the shadow-mode comparison in src/session/shadow.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-session-shadow.mjs
//
// src/session/ imports nothing from `vscode`, so — like test-session-store.mjs — this needs
// no Module._load stub: the compiled module is imported directly. This tests only the pure
// comparison; the chatViewProvider.ts wiring that calls it (seeding, persistence, the output
// channel) is exercised by hand via the Extension Development Host, same as everything else
// under "Rendering appearance" in the repo's CLAUDE.md.
import assert from 'node:assert/strict';
import { compareTranscripts } from '../out/session/shadow.js';

// 1. Identical transcripts diverge in nothing.
{
	const expected = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'hello' },
	];
	const actual = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'hello' },
	];
	assert.strictEqual(compareTranscripts(expected, actual), undefined);
}

// 2. Differing content at index 2 is named by that index, with both sides' role/content.
{
	const expected = [
		{ role: 'user', content: 'first' },
		{ role: 'assistant', content: 'reply' },
		{ role: 'user', content: 'store version' },
	];
	const actual = [
		{ role: 'user', content: 'first' },
		{ role: 'assistant', content: 'reply' },
		{ role: 'user', content: 'webview version' },
	];
	assert.deepStrictEqual(compareTranscripts(expected, actual), {
		index: 2,
		expectedLength: 3,
		actualLength: 3,
		expected: { role: 'user', content: 'store version' },
		actual: { role: 'user', content: 'webview version' },
	});
}

// 3. A length mismatch is reported at the first index past the shorter side — the missing
// side's entry is `undefined`, which is itself the divergence being reported.
{
	const expected = [{ role: 'user', content: 'hi' }];
	const actual = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'hello' },
	];
	assert.deepStrictEqual(compareTranscripts(expected, actual), {
		index: 1,
		expectedLength: 1,
		actualLength: 2,
		expected: undefined,
		actual: { role: 'assistant', content: 'hello' },
	});
}

// 4. A kind-bearing notice present on only one side is NOT a divergence: sendableMessages
// already filters those out on the store side, so an 'info'/'error'/'auto' entry never reaches
// a model on either side, and reporting it would be a false positive.
{
	const expected = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'a notice', kind: 'info' },
		{ role: 'assistant', content: 'hello' },
	];
	const actual = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'hello' },
	];
	assert.strictEqual(compareTranscripts(expected, actual), undefined);
}

// 5. A long entry is truncated in the report so a log line never dumps a full multi-KB tool
// result verbatim.
{
	const long = 'x'.repeat(200);
	const expected = [{ role: 'assistant', content: long }];
	const actual = [{ role: 'assistant', content: `${long}y` }];
	const divergence = compareTranscripts(expected, actual);
	assert.ok(divergence);
	assert.strictEqual(divergence.expected.content.length, 81, '80 chars plus the ellipsis');
	assert.ok(divergence.expected.content.endsWith('…'));
}

// 6. Content differing only by trailing spaces and a triple blank line is not a divergence:
// tidyResponse (media/main.js:1849-1859) applies this same normalization to the webview's own
// stored/re-sent history, so this is noise, not real drift.
{
	const expected = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'line one   \nline two\n\n\n\nline three' },
	];
	const actual = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'line one\nline two\n\nline three' },
	];
	assert.strictEqual(compareTranscripts(expected, actual), undefined);
}

// 7. The same kind of whitespace difference located inside a fenced code block IS a
// divergence: whitespace inside a fence is content (indentation, here-docs), not noise, and
// tidyResponse itself leaves fenced content untouched.
{
	const expected = [
		{ role: 'assistant', content: '```\nline one   \nline two\n\n\n\nline three\n```' },
	];
	const actual = [
		{ role: 'assistant', content: '```\nline one\nline two\n\nline three\n```' },
	];
	assert.ok(compareTranscripts(expected, actual));
}

console.log('test-session-shadow: all assertions passed');
