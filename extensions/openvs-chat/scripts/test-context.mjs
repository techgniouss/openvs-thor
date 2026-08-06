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
const GROQ_413 = 'Groq (free tier): request failed (HTTP 413). Request too large for model `qwen/qwen3.6-27b` in organization `org_01k` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 13155, please reduce your message size and try again.';
for (const msg of [
	'This model\'s maximum context length is 128000 tokens',
	'Error code: 400 - context_length_exceeded',
	'input exceeds the context window',
	'Request too large: too many tokens',
	'prompt tokens exceed the limit',
	GROQ_413,
]) {
	assert.ok(m.isContextLengthError(msg), `should detect: ${msg}`);
}
for (const msg of [
	'authentication failed (HTTP 401)',
	'rate limited (HTTP 429)',
	'The provider did not start responding within 150s',
	// A 429 for the *same* TPM ceiling must stay a wait-and-retry: shrinking the
	// conversation doesn't refill a per-minute quota, and the transport already backs off.
	'Groq (free tier): rate limited (HTTP 429). Rate limit reached for model `qwen/qwen3.6-27b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 900. Please try again in 6s.',
]) {
	assert.ok(!m.isContextLengthError(msg), `should not detect: ${msg}`);
}

// parseTokenLimit pulls the ceiling out of the rejection, so the retry lands under it in
// one hop instead of halving a 120k budget down toward 8k over several dead requests.
assert.strictEqual(m.parseTokenLimit(GROQ_413), 8000);
assert.strictEqual(m.parseTokenLimit('This model\'s maximum context length is 128000 tokens, however you requested 130000'), 128000);
assert.strictEqual(m.parseTokenLimit('exceeded the limit of 32,000 tokens'), 32000);
// No number, or one too small to be a token budget, leaves the caller to halve blindly.
assert.strictEqual(m.parseTokenLimit('input exceeds the context window'), undefined);
assert.strictEqual(m.parseTokenLimit('Rate limit reached, retry limit 3 exceeded'), undefined);

// trimMessages must actually FIT the budget it was given, including when the only thing
// left over it is tool output the function normally protects. One fresh read is 24k
// characters — on a small budget that single result exceeds the whole allowance, and
// returning it anyway produced a request the caller sent and the provider refused. The
// protection has to yield to the budget, not the other way round.
{
	const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'REQ' }];
	for (let i = 0; i < 20; i++) {
		msgs.push({ role: 'assistant', content: `step ${i}`, toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `f${i}.ts` } }] });
		msgs.push({ role: 'tool', content: 'x'.repeat(24_000), toolCallId: `c${i}` });
	}
	for (const budget of [6_000, 2_000, 1_000]) {
		const out = m.trimMessages(msgs, budget);
		assert.ok(m.estimateMessagesTokens(out) <= budget,
			`a ${budget}-token budget is met, not merely approached (got ${m.estimateMessagesTokens(out)})`);
	}
	// Still a usable conversation: the task and the newest result's head both survive.
	const out = m.trimMessages(msgs, 2_000);
	assert.deepStrictEqual(out.slice(0, 2), msgs.slice(0, 2), 'the task itself is never trimmed away');
	assert.ok(out.at(-1).content.startsWith('x'.repeat(200)), 'the newest result keeps its identifying head');
}

// pruneToolOutput drops output the model no longer needs sent, at any budget. The three
// rules are asserted together on one transcript so their interaction is what's pinned, not
// three separate happy paths.
{
	const opts = { readTools: ['read_file', 'list_files', 'search_files'], wholeFileWriteTool: 'write_file', keepRecentTurns: 2 };
	const call = (id, name, args) => ({ role: 'assistant', content: '', toolCalls: [{ id, name, args }] });
	const dump = (id, tag) => ({ role: 'tool', toolCallId: id, content: `${tag} ${'x'.repeat(1_000)}` });
	const before = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'go' },
		// Read of a.ts, then the identical read again later — the first is dominated.
		call('c1', 'read_file', { path: 'a.ts' }), dump('c1', 'A-FIRST'),
		// Read of b.ts, later replaced wholesale — the read is dead.
		call('c2', 'read_file', { path: 'b.ts' }), dump('c2', 'B-READ'),
		// Read of c.ts, later only *edited* — a targeted edit leaves the dump mostly right,
		// so eliding it would force a re-read that costs more than it saves.
		call('c3', 'read_file', { path: 'c.ts' }), dump('c3', 'C-READ'),
		call('c4', 'write_file', { path: 'b.ts', content: 'new' }), dump('c4', 'WROTE-B'),
		call('c5', 'edit_file', { path: 'c.ts' }), dump('c5', 'EDITED-C'),
		call('c6', 'read_file', { path: 'a.ts' }), dump('c6', 'A-SECOND'),
		call('c7', 'read_file', { path: 'd.ts' }), dump('c7', 'D-RECENT'),
	];
	const after = m.pruneToolOutput(before, opts);
	const body = id => after.find(x => x.toolCallId === id).content;
	assert.deepStrictEqual(
		[
			body('c1').includes(m.SUPERSEDED_MARKER),
			body('c2').includes(m.SUPERSEDED_MARKER),
			body('c3').includes(m.SUPERSEDED_MARKER),
			body('c6') === before.find(x => x.toolCallId === 'c6').content,
			body('c7') === before.find(x => x.toolCallId === 'c7').content,
		],
		[true, true, false, true, true],
		'duplicate read and whole-file-overwritten read are elided; edit_file does not elide; recent output is verbatim',
	);
	// The head survives, so the model can tell what it is being offered a re-read of.
	assert.ok(body('c1').startsWith('A-FIRST'), 'an elided result keeps its identifying head');
	// Old output goes regardless of what replaced it, which is where the bulk actually is.
	assert.ok(body('c3').includes(m.DECAY_MARKER), 'output older than the kept turns is elided by age');
	// Nothing is dropped, only shortened: dropping turns is trimMessages' job and needs the
	// orphan handling this pass deliberately does not do.
	assert.strictEqual(after.length, before.length, 'pruning never removes a message');
	// Unchanged input must come back as the same array, so the common case allocates nothing.
	assert.strictEqual(m.pruneToolOutput(after, opts), after, 'a second pass is a no-op');
}

// elidedToolCallIds reports what the model can no longer read, however it was lost.
{
	const before = [
		{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', args: {} }, { id: 'b', name: 'read_file', args: {} }] },
		{ role: 'tool', toolCallId: 'a', content: 'kept' },
		{ role: 'tool', toolCallId: 'b', content: 'original' },
		{ role: 'tool', toolCallId: 'c', content: 'dropped entirely' },
	];
	const after = [
		{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', args: {} }, { id: 'b', name: 'read_file', args: {} }] },
		{ role: 'tool', toolCallId: 'a', content: 'kept' },
		{ role: 'tool', toolCallId: 'b', content: 'shortened…' },
	];
	assert.deepStrictEqual(m.elidedToolCallIds(before, after), ['b', 'c'],
		'shortened and dropped both count; untouched does not');
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

// The tool schemas ride along with every agent request, so they have to be charged against
// the same budget. Counting only the messages understated every request by a fixed amount.
{
	const tools = [
		{
			name: 'read_file',
			description: 'Read a file from the workspace.',
			parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path.' } }, required: ['path'] },
		},
		{ name: 'noop', description: '', parameters: { type: 'object', properties: {} } },
	];
	assert.strictEqual(m.estimateToolsTokens([]), 0, 'no tools cost nothing');
	// The nested parameter schema is most of the cost, so a tool with one is worth several
	// times one without — the reason this is measured on the serialized form.
	const [described, bare] = tools.map(t => m.estimateToolsTokens([t]));
	assert.ok(described > bare * 2, 'a real parameter schema dominates the estimate');
	assert.strictEqual(m.estimateToolsTokens(tools), described + bare, 'tools sum');
}

console.log('test-context: all assertions passed');
