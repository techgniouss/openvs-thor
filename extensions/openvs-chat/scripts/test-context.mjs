/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/agent/context.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-context.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/agent/context.js', import.meta.url));

const big = n => 'x'.repeat(n);

// estimateTokens: ~4 chars per token.
assert.strictEqual(m.estimateTokens(''), 0);
assert.strictEqual(m.estimateTokens('abcd'), 1);
assert.strictEqual(m.estimateTokens(big(4000)), 1000);

// A conversation that already fits is returned untouched (same array identity).
{
	const msgs = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'do the thing' },
	];
	assert.strictEqual(m.trimMessages(msgs, 10_000), msgs, 'no copy when nothing to trim');
	assert.strictEqual(m.trimMessages(msgs, 0), msgs, 'budget 0 disables trimming');
}

// Oversized old tool output is shortened; the system prompt, first request and recent
// turns survive intact.
{
	const msgs = [
		{ role: 'system', content: 'SYSTEM PROMPT' },
		{ role: 'user', content: 'ORIGINAL REQUEST' },
		{ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', args: {} }] },
		{ role: 'tool', content: `HEAD-OF-FILE ${big(40_000)}`, toolCallId: '1' },
		{ role: 'assistant', content: 'thinking about it' },
		{ role: 'tool', content: big(40_000), toolCallId: '2' },
		{ role: 'assistant', content: 'nearly there' },
		{ role: 'user', content: 'RECENT TURN' },
	];
	const out = m.trimMessages(msgs, 2_000);
	assert.ok(m.estimateMessagesTokens(out) <= 2_000, 'result fits the budget');
	assert.strictEqual(out[0].content, 'SYSTEM PROMPT', 'system prompt preserved');
	assert.ok(out.some(x => x.content === 'ORIGINAL REQUEST'), 'original request preserved');
	assert.ok(out.some(x => x.content === 'RECENT TURN'), 'most recent turn preserved');
	assert.ok(out.some(x => x.content.includes(m.TRIM_MARKER)), 'trimming is announced to the model');
	const head = out.find(x => x.content.startsWith('HEAD-OF-FILE'));
	assert.ok(head, 'the head of a trimmed tool result is kept so it stays identifiable');
	assert.notStrictEqual(out, msgs, 'the input array is not mutated in place');
	assert.strictEqual(msgs[3].content.length, 40_000 + 13, 'original messages untouched');
}

// When shortening tool results is not enough, whole middle turns are dropped with a note.
{
	const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first' }];
	for (let i = 0; i < 60; i++) {
		msgs.push({ role: 'assistant', content: `narration ${i} ${big(2_000)}` });
	}
	msgs.push({ role: 'user', content: 'LAST' });
	const out = m.trimMessages(msgs, 3_000);
	assert.ok(m.estimateMessagesTokens(out) <= 3_000, 'fits after dropping middle turns');
	assert.ok(out.some(x => /earlier message\(s\) removed/.test(x.content)), 'removal is announced');
	assert.strictEqual(out.at(-1).content, 'LAST', 'tail preserved');
}

// Trimming never leaves an orphaned tool result (a `tool` message whose assistant
// tool_call was dropped) — providers reject the whole request when that happens.
{
	const msgs = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'goal' },
	];
	// Many assistant(tool_call)+tool pairs, each pair heavy enough to force pass-2 drops.
	for (let i = 0; i < 40; i++) {
		msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', args: {} }] });
		msgs.push({ role: 'tool', content: big(3_000), toolCallId: `c${i}` });
	}
	msgs.push({ role: 'user', content: 'LAST' });
	const out = m.trimMessages(msgs, 4_000);
	assert.ok(m.estimateMessagesTokens(out) <= 4_000, 'fits the budget');
	const callIds = new Set();
	for (const x of out) {
		for (const c of x.toolCalls ?? []) { callIds.add(c.id); }
		if (x.role === 'tool') {
			assert.ok(callIds.has(x.toolCallId), `tool result ${x.toolCallId} has its assistant call`);
		}
	}
}

// Image payloads count toward the budget so a screenshot-heavy chat still gets trimmed.
{
	const msgs = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'first', images: [{ mimeType: 'image/png', data: big(200_000) }] },
		{ role: 'assistant', content: 'ok' },
		{ role: 'tool', content: big(20_000), toolCallId: 'x' },
		{ role: 'user', content: 'LAST' },
	];
	assert.ok(m.estimateMessagesTokens(msgs) > 50_000, 'image bulk is counted');
}

// isContextLengthError recognizes how each backend words the rejection.
for (const msg of [
	'This model\'s maximum context length is 128000 tokens',
	'Error code: 400 - context_length_exceeded',
	'input exceeds the context window',
	'Request too large: too many tokens',
	'prompt tokens exceed the limit',
]) {
	assert.ok(m.isContextLengthError(msg), `should detect: ${msg}`);
}
for (const msg of [
	'authentication failed (HTTP 401)',
	'rate limited (HTTP 429)',
	'The provider did not start responding within 150s',
]) {
	assert.ok(!m.isContextLengthError(msg), `should not detect: ${msg}`);
}

// The incremental token accounting inside trimMessages must agree exactly with a full
// recount. Both passes track a running total instead of re-measuring the whole transcript
// per iteration (that was quadratic, on a function called before every agent step), so a
// drift in the delta arithmetic would silently trim too much or too little.
{
	/** A transcript with bulky tool output in the middle, the shape trimming targets. */
	const build = n => {
		const out = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'the original request' },
		];
		for (let i = 0; i < n; i++) {
			out.push({ role: 'assistant', content: `step ${i}`, toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `f${i}.ts` } }] });
			out.push({ role: 'tool', toolCallId: `c${i}`, content: `file ${i} contents `.repeat(120) });
		}
		out.push({ role: 'assistant', content: 'summary' });
		return out;
	};

	const untrimmed = m.estimateMessagesTokens(build(12));
	// The floor is what remains when everything trimmable is gone: the protected head and
	// recent tail. It must be a real reduction, or every assertion below passes vacuously.
	const floor = m.estimateMessagesTokens(m.trimMessages(build(12), 1));
	assert.ok(floor < untrimmed / 2, `trimming must actually shrink the transcript (${untrimmed} → ${floor})`);

	for (const budget of [500, 2_000, 5_000, 20_000, 200_000]) {
		const trimmed = m.trimMessages(build(12), budget);
		const actual = m.estimateMessagesTokens(trimmed);
		// Either it fits, or it is already down to the floor — a budget below the protected
		// head and tail cannot be met, and that is by design.
		assert.ok(actual <= budget || actual <= floor,
			`budget ${budget}: trimmed to ~${actual} tokens, which is neither under budget nor at the floor (~${floor})`);
		// …and a budget the transcript genuinely exceeds must produce a real cut.
		if (budget < untrimmed && budget > floor) {
			assert.ok(actual < untrimmed, `budget ${budget}: nothing was trimmed at all`);
		}
		// The task itself is never trimmed away, whatever the budget.
		assert.ok(trimmed.some(x => x.content === 'the original request'),
			`budget ${budget}: the original request survived`);
		// No tool result may outlive the assistant turn that called it.
		const ids = new Set();
		for (const msg of trimmed) {
			for (const call of msg.toolCalls ?? []) { ids.add(call.id); }
			if (msg.role === 'tool' && msg.toolCallId) {
				assert.ok(ids.has(msg.toolCallId), `budget ${budget}: orphaned tool result ${msg.toolCallId}`);
			}
		}
	}

	// A conversation already under budget is returned untouched — the common case stays free.
	const small = build(1);
	assert.strictEqual(m.trimMessages(small, 1_000_000), small, 'a fitting conversation is not copied');
}

console.log('test-context: all assertions passed');
