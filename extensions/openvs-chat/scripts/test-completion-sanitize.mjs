/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/sanitize.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-sanitize.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/sanitize.js', import.meta.url));

const limits = { maxLines: 6 };
const w = (prefix, suffix = '') => ({ prefix, suffix });

// One table, one snapshot — each row is a failure class a real model produced.
const cases = [
	['plain continuation passes through',
		'sum += n;', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['fenced block is unwrapped',
		'```ts\nsum += n;\n```', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['prose preamble around a fence is dropped',
		'Here is the completion:\n```ts\nsum += n;\n```\nHope that helps!',
		w('for (const n of xs) {\n\t'), 'sum += n;'],

	['prose with no fence and no continuation yields nothing',
		'Sure! I can help you complete this loop.', w('for (const n of xs) {\n\t'), ''],

	['restated prefix is removed',
		'for (const n of xs) {\n\tsum += n;', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['restated suffix is removed so brackets are not doubled',
		'sum += n;\n}', w('for (const n of xs) {\n\t', '\n}'), 'sum += n;'],

	['runaway output is capped at maxLines',
		Array.from({ length: 20 }, (_, i) => `line${i};`).join('\n'), w('function f() {\n\t'),
		Array.from({ length: 6 }, (_, i) => `line${i};`).join('\n')],

	['output is cut where the block exits',
		'sum += n;\n\t}\n\treturn sum;\n}\n\nfunction other() {}',
		w('function f() {\n\tfor (const n of xs) {\n\t\t'), 'sum += n;'],

	['a completion equal to text already present is discarded',
		'sum += n;', w('for (const n of xs) {\n\tsum += n;'), ''],

	['inline thinking is stripped',
		'<think>They want the accumulator.</think>sum += n;', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['whitespace-only output is nothing',
		'   \n  \n', w('const a = '), ''],

	['leading newline is preserved when the model opens a new line',
		'\n\treturn sum;', w('function f() {\n\tlet sum = 0;'), '\n\treturn sum;'],
];

assert.deepStrictEqual(
	cases.map(([name, raw, win]) => [name, m.sanitizeCompletion(raw, win, limits)]),
	cases.map(([name, , , expected]) => [name, expected]),
);

console.log('all assertions passed');
