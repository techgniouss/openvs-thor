/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/stats.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-stats.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/stats.js', import.meta.url));

const stats = new m.CompletionStats();
// No samples means no opinion, not a zero score — a model must not be ranked last merely
// for being new, or the first bad run would permanently bury a good backend.
assert.strictEqual(stats.rateFor('a'), undefined);

for (let i = 0; i < 10; i++) { stats.shown('a'); }
for (let i = 0; i < 7; i++) { stats.accepted('a'); }
assert.strictEqual(stats.rateFor('a'), 0.7);

// A partial accept counts as an accept: the user took part of it, which is the signal.
// Scoring it as a rejection would punish exactly the multi-line completions worth having.
stats.shown('b');
stats.partial('b', 12);
assert.strictEqual(stats.rateFor('b'), undefined, 'one sample is not enough to rank on');
for (let i = 0; i < 9; i++) { stats.shown('b'); stats.rejected('b'); }
assert.strictEqual(Math.round(stats.rateFor('b') * 100), 10);

const report = stats.report();
assert.deepStrictEqual(report.map(r => r.model).sort(), ['a', 'b']);
assert.deepStrictEqual(
	report.find(r => r.model === 'a'),
	{ model: 'a', shown: 10, accepted: 7, rate: 0.7 },
);

console.log('all assertions passed');
