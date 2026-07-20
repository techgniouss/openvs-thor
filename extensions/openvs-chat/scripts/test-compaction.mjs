// Standalone unit test for src/agent/compaction.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-compaction.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/agent/compaction.js', import.meta.url));
const big = n => 'x'.repeat(n);

const convo = (middleCount, middleSize) => [
	{ role: 'system', content: 'SYSTEM' },
	{ role: 'user', content: 'ORIGINAL REQUEST' },
	...Array.from({ length: middleCount }, (_, i) => ({ role: 'assistant', content: `step ${i}: ${big(middleSize)}` })),
	{ role: 'user', content: 'recent question' },
	{ role: 'assistant', content: 'recent answer' },
];

// shouldCompact: fires above 70% of the window, not below.
assert.strictEqual(m.shouldCompact(convo(2, 100), 100_000), false);
assert.strictEqual(m.shouldCompact(convo(40, 8_000), 100_000), true); // ~80k tokens > 70k

// compactMessages: middle replaced by one summary turn; head and recent tail intact.
{
	const messages = convo(20, 4_000);
	const seen = [];
	const res = await m.compactMessages(messages, async (msgs, maxTokens) => {
		seen.push({ count: msgs.length, maxTokens });
		return 'THE SUMMARY';
	});
	assert.ok(res, 'compaction produced a result');
	assert.strictEqual(res.messages[0].content, 'SYSTEM');
	assert.strictEqual(res.messages[1].content, 'ORIGINAL REQUEST');
	const summaryMsg = res.messages[2];
	assert.strictEqual(summaryMsg.role, 'user');
	assert.ok(summaryMsg.content.startsWith(m.COMPACT_MARKER), 'summary carries the marker');
	assert.ok(summaryMsg.content.includes('THE SUMMARY'));
	// The last 6 original turns survive verbatim.
	assert.deepStrictEqual(res.messages.slice(3), messages.slice(-6));
	assert.ok(res.before > res.after, 'token estimate shrank');
	assert.strictEqual(res.replaced, messages.length - 2 - 6);
	// The summarizer saw the compactable turns plus the instruction, with a small budget.
	assert.strictEqual(seen.length, 1);
	assert.ok(seen[0].maxTokens <= 2_000);
}

// Too little middle to compact → undefined (never loops on its own summary).
assert.strictEqual(await m.compactMessages(convo(2, 100), async () => 'S'), undefined);

// Summarizer failure or empty summary → undefined (caller falls back to trimming).
assert.strictEqual(await m.compactMessages(convo(20, 4_000), async () => { throw new Error('boom'); }), undefined);
assert.strictEqual(await m.compactMessages(convo(20, 4_000), async () => '   '), undefined);

// Orphaned tool results at the keep-boundary are dropped, not sent.
{
	const messages = [
		{ role: 'system', content: 'SYSTEM' },
		{ role: 'user', content: 'REQ' },
		...Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: big(4_000) + i })),
		// Tail starts with tool results whose calls sit in the compacted region.
		{ role: 'tool', content: 'orphan result', toolCallId: 'call-1' },
		{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
		{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
		{ role: 'user', content: 'q3' },
	];
	const res = await m.compactMessages(messages, async () => 'S');
	assert.ok(res);
	assert.ok(!res.messages.some(x => x.role === 'tool'), 'orphan tool result dropped');
}

console.log('test-compaction: all assertions passed');

// compactionThreshold: normally 70% of the window, but never above the point where the
// lossy trim would already have kicked in — trimming must never get first crack.
{
	// Whichever is lower governs. For a 200k window the trim budget's headroom is just
	// under the 70% mark, so it wins by a hair (136.6k vs 140k) — still ~68% of the
	// window, and still guaranteed to precede the trim.
	assert.strictEqual(m.compactionThreshold(200_000, 151_808), 151_808 * 0.9);
	assert.ok(m.compactionThreshold(200_000, 151_808) < 151_808, 'compaction fires before trimming');
	// The nominal 70% governs once the window dwarfs the response reservation.
	assert.strictEqual(m.compactionThreshold(1_000_000, 791_808), 700_000);
	// Small window: 0.7*32000 = 22400 would land ABOVE the 17408 trim budget, so the
	// budget's headroom governs instead and compaction still precedes trimming.
	assert.strictEqual(m.compactionThreshold(32_000, 17_408), Math.min(22_400, 17_408 * 0.9));
	assert.ok(m.compactionThreshold(32_000, 17_408) < 17_408, 'compaction fires before trimming');
	assert.ok(m.compactionThreshold(64_000, 43_008) < 43_008, 'compaction fires before trimming');
	// No budget supplied: pure window behavior, unchanged.
	assert.strictEqual(m.compactionThreshold(100_000), 70_000);
	assert.strictEqual(m.compactionThreshold(100_000, 0), 70_000);
}

// shouldCompact honors the budget-aware threshold when a trim budget is supplied.
{
	// ~20k estimated tokens: under 70% of a 32k window (22.4k) but over the budget-aware
	// threshold (15.7k), so it must compact rather than wait for the lossy trim.
	const msgs = convo(10, 8_000);
	assert.strictEqual(m.shouldCompact(msgs, 32_000), false, 'window-only threshold would not fire');
	assert.strictEqual(m.shouldCompact(msgs, 32_000, 17_408), true, 'budget-aware threshold fires');
}
console.log('test-compaction thresholds: all assertions passed');

// keepHead: an assembled request is [system, attached context, the request, ...]. The
// default "preserve through the first user turn" would protect the bulky context blob
// and summarize away the request itself — keepHead is what prevents that.
{
	const assembled = [
		{ role: 'system', content: 'SYSTEM' },
		{ role: 'user', content: 'Context for the request:\n\n' + big(40_000) },
		{ role: 'user', content: 'THE ACTUAL REQUEST' },
		...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: 'work ' + i })),
		...Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: 'recent ' + i })),
	];
	// HAZARD PIN, not an endorsement: omitting keepHead on an assembled request loses the
	// request itself. No caller may do this — every call site passes a real head — and
	// this assertion exists so that if one ever stops, the cost is visible here.
	const naive = await m.compactMessages(assembled, async () => 'SUMMARY');
	assert.ok(!naive.messages.some(x => x.content === 'THE ACTUAL REQUEST'),
		'omitting keepHead on an assembled request drops the request — callers must pass one');

	// With keepHead the head is preserved verbatim and only later turns are summarized.
	const res = await m.compactMessages(assembled, async () => 'SUMMARY', 3);
	assert.deepStrictEqual(res.messages.slice(0, 3), assembled.slice(0, 3), 'head kept verbatim');
	assert.ok(res.messages.some(x => x.content === 'THE ACTUAL REQUEST'), 'the request survives');
	assert.ok(res.messages[3].content.startsWith(m.COMPACT_MARKER), 'summary follows the head');
	assert.deepStrictEqual(res.messages.slice(4), assembled.slice(-6), 'recent turns kept verbatim');
	// replaced counts only post-head messages, so it stays in the webview's terms.
	assert.strictEqual(res.replaced, assembled.length - 3 - 6);

	// Out-of-range keepHead leaves nothing compactable rather than throwing.
	assert.strictEqual(await m.compactMessages(assembled, async () => 'S', 999), undefined);
	// keepHead 0 protects nothing — including the system prompt, which then lands in the
	// compacted region. Callers must pass a real head; this pins the consequence so the
	// behavior is a documented hazard rather than a surprise.
	const noHead = await m.compactMessages(assembled, async () => 'S', 0);
	assert.strictEqual(noHead.messages[0].role, 'user', 'keepHead 0 drops the system prompt');
	assert.ok(noHead.messages[0].content.startsWith(m.COMPACT_MARKER));
}
console.log('test-compaction keepHead: all assertions passed');

// The summarizer payload must be a plain chat request: no assistant tool_calls and no
// role:'tool' turns. It is sent with no `tools` declared, and the slice is cut at a
// fixed offset from the tail, so unflattened it is an invalid request — OpenAI rejects
// an unanswered tool_calls, Anthropic rejects tool blocks when tools is undefined.
{
	const msgs = [
		{ role: 'system', content: 'SYS' },
		{ role: 'user', content: 'REQ' },
	];
	for (let i = 0; i < 8; i++) {
		msgs.push({ role: 'assistant', content: big(3_000), toolCalls: [{ id: 'c' + i, name: 'read_file', args: { path: 'a.ts' } }] });
		msgs.push({ role: 'tool', content: big(3_000), toolCallId: 'c' + i });
	}
	for (let i = 0; i < 6; i++) { msgs.push({ role: 'user', content: 'recent ' + i }); }

	let sent;
	const res = await m.compactMessages(msgs, async payload => { sent = payload; return 'SUMMARY'; }, 2);
	assert.ok(res, 'compaction ran');
	assert.ok(!sent.some(x => x.toolCalls?.length), 'no assistant tool_calls reach the summarizer');
	assert.ok(!sent.some(x => x.role === 'tool'), 'no tool-role turns reach the summarizer');
	// The information survives as text rather than being dropped.
	assert.ok(sent.some(x => x.content.includes('[tool call: read_file(')), 'tool calls survive as prose');
	assert.ok(sent.some(x => x.content.startsWith('[tool result]')), 'tool results survive as prose');
	// The compacted conversation itself still carries real tool structure where it is valid.
	assert.ok(res.messages.slice(0, 2).every(x => !x.toolCalls), 'head unchanged');
}
console.log('test-compaction summarizer payload: all assertions passed');
