/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/agent/budgetedStream.ts, the one path that sizes every
// non-agent request (Ask/Plan without tools, Edit, Auto's plan and review phases). Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-budgeted-stream.mjs
import assert from 'node:assert/strict';

const { streamBudgeted } = await import(new URL('../out/agent/budgetedStream.js', import.meta.url));

/** A provider that records every request and answers from `replies` (an Error is thrown). */
function fakeProvider(replies) {
	const seen = [];
	return {
		seen,
		info: { id: 'fake', label: 'Fake', supportsTools: false, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async streamChat(request) {
			seen.push({ system: request.messages[0]?.content, maxTokens: request.maxTokens });
			const next = replies.shift() ?? 'ok';
			if (next instanceof Error) {
				throw next;
			}
			request.onToken(next);
			return { finishReason: 'stop' };
		},
	};
}

const bigSystem = 'FULL '.repeat(3_000); // ~3.75k tokens
const request = (provider, extra) => streamBudgeted(provider, {
	messages: [{ role: 'system', content: bigSystem }, { role: 'user', content: 'hi' }],
	model: 'm',
	apiKey: 'k',
	baseUrl: 'u',
	maxTokens: 1_000,
	contextBudget: 120_000,
	signal: new AbortController().signal,
	onToken: () => { },
	onNotice: () => { },
	...extra,
});

// A budget that carries the full prompt sends it, and reports no switch.
{
	const provider = fakeProvider(['hello']);
	const result = await request(provider, { compactSystem: 'COMPACT' });
	assert.deepStrictEqual(result, { text: 'hello', truncated: false, compactPrompt: false });
	assert.strictEqual(provider.seen[0].system, bigSystem);
}

// One that cannot sends the compact prompt instead — trimming never shrinks a system prompt.
{
	const provider = fakeProvider(['hello']);
	const result = await request(provider, { compactSystem: 'COMPACT', contextBudget: 5_400 });
	assert.strictEqual(result.compactPrompt, true);
	assert.strictEqual(provider.seen[0].system, 'COMPACT');
}

// A refusal naming a small ceiling retries inside it, and that retry gets the compact prompt.
{
	const provider = fakeProvider([
		new Error('Request too large for model `q` on tokens per minute (TPM): Limit 8000, Requested 13155, please reduce your message size and try again.'),
		'hello',
	]);
	const result = await request(provider, { compactSystem: 'COMPACT' });
	assert.deepStrictEqual(provider.seen.map(s => s.system), [bigSystem, 'COMPACT']);
	assert.strictEqual(result.compactPrompt, true);
}

// No compact prompt offered: exactly the old behavior.
{
	const provider = fakeProvider(['hello']);
	const result = await request(provider, { contextBudget: 5_400 });
	assert.strictEqual(result.compactPrompt, false);
	assert.strictEqual(provider.seen[0].system, bigSystem);
}

console.log('test-budgeted-stream: all assertions passed');
