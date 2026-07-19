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

console.log('test-context: all assertions passed');
