/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/persona/thinking.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-thinking.mjs
import assert from 'node:assert/strict';

const { ThinkingStreamParser, formatThinking, stripThinking, stripHistoryThinking } = await import(new URL('../out/persona/thinking.js', import.meta.url));

/** The rendered open marker, spelled once so the tests below stay readable. */
const MARK = '🤔 *Thinking…*\n\n';

/**
 * Feeds deltas through a parser and returns everything it emitted, with the duration
 * stamp normalized — the wall clock is not the thing under test, but its presence is.
 */
const run = (deltas, timing = false) => {
	let out = '';
	const p = new ThinkingStreamParser(t => { out += t; }, timing);
	for (const d of deltas) { p.push(d); }
	p.flush();
	return out.replace(/\[thought for \d+s\]/g, '[thought for Ns]');
};

// Whole message in one delta.
assert.equal(
	run(['<thinking>plan it</thinking>Answer.']),
	'🤔 *Thinking…*\n\nplan it\n\n---\n\nAnswer.');

// Tags split across chunk boundaries (the streaming case).
assert.equal(
	run(['<thin', 'king>a', 'b</thi', 'nking>ok']),
	'🤔 *Thinking…*\n\nab\n\n---\n\nok');

// With timing on (every live stream), the block carries how long it took, just inside
// its closing marker — the webview collapses to "Thought for Ns" and the transcript is
// re-rendered from this string long after any live timer is gone.
assert.equal(
	run(['<thinking>plan it</thinking>Answer.'], true),
	'🤔 *Thinking…*\n\nplan it\n\n[thought for Ns]\n\n---\n\nAnswer.');

// A stream that dies mid-thinking is still stamped, or the block reads "Thinking…" forever.
assert.equal(
	run(['<thinking>cut off'], true),
	'🤔 *Thinking…*\n\ncut off\n\n[thought for Ns]');

// The stamp lives inside the block, so history stripping still removes all of it.
assert.strictEqual(
	stripThinking(run(['<thinking>plan it</thinking>Answer.'], true).replace('Ns', '3s')),
	'Answer.');

// No tags: pure pass-through, byte-identical.
assert.equal(run(['hello ', 'world']), 'hello world');

// '<' that is not a thinking tag must not be swallowed (generics, HTML).
assert.equal(run(['a < b and <div>x</div>']), 'a < b and <div>x</div>');

// Unclosed tag: flush() must not lose the buffered content.
const unclosed = run(['<thinking>never closed. Answer here']);
assert.ok(unclosed.includes('never closed. Answer here'), 'unclosed content must survive flush');

// Partial open tag at end of stream flushes as literal text.
assert.equal(run(['tail <thin']), 'tail <thin');

// formatThinking: same conversion for complete (non-streamed) text.
assert.equal(
	formatThinking('<thinking>x</thinking>y'),
	'🤔 *Thinking…*\n\nx\n\n---\n\ny');
assert.equal(formatThinking('no tags'), 'no tags');

console.log('test-persona-thinking: all assertions passed');

// stripThinking: removes rendered thinking blocks from committed transcript text.
{
	const s = stripThinking;
	assert.strictEqual(typeof s, 'function');
	assert.strictEqual(s('🤔 *Thinking…*\n\nsome reasoning here\n\n---\n\nThe answer.'), 'The answer.');
	// Multiple blocks (multi-step replies concatenated).
	assert.strictEqual(
		s('🤔 *Thinking…*\n\nA\n\n---\n\nfirst🤔 *Thinking…*\n\nB\n\n---\n\nsecond'),
		'firstsecond');
	// Unclosed block (stream ended mid-thinking): everything from the marker goes.
	assert.strictEqual(s('answer part\n\n🤔 *Thinking…*\n\ndangling'), 'answer part');
	// No block: text untouched (same string).
	assert.strictEqual(s('plain answer with --- a rule'), 'plain answer with --- a rule');
	assert.strictEqual(s(''), '');
}
// stripHistoryThinking: strips reasoning from past assistant turns AND drops any turn
// that was nothing but reasoning. Sending an empty assistant message is rejected outright
// by several OpenAI-compatible gateways (NVIDIA among them), failing the whole request
// rather than just that turn.
{
	const h = stripHistoryThinking;
	assert.deepStrictEqual(
		h([
			{ role: 'user', content: 'q1' },
			{ role: 'assistant', content: `${MARK}reasoning\n\n---\n\nThe answer.` },
			{ role: 'user', content: 'q2' },
			{ role: 'assistant', content: `${MARK}only reasoning, no answer` },
			{ role: 'user', content: 'q3' },
		]),
		[
			{ role: 'user', content: 'q1' },
			{ role: 'assistant', content: 'The answer.' },
			{ role: 'user', content: 'q2' },
			{ role: 'user', content: 'q3' },
		],
		'a turn that was nothing but reasoning is dropped, not sent empty');
	// An assistant turn carrying tool calls or images survives even with empty text.
	assert.deepStrictEqual(
		h([{ role: 'assistant', content: `${MARK}x`, toolCalls: [{ id: 'c1' }] }]),
		[{ role: 'assistant', content: '', toolCalls: [{ id: 'c1' }] }]);
	// User turns are never touched, even when they quote the marker.
	assert.deepStrictEqual(
		h([{ role: 'user', content: `${MARK}quoted` }]),
		[{ role: 'user', content: `${MARK}quoted` }]);
	assert.deepStrictEqual(h([]), []);
}
console.log('test-persona-thinking stripThinking: all assertions passed');
