// Standalone unit test for src/persona/thinking.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-thinking.mjs
import assert from 'node:assert/strict';

const { ThinkingStreamParser, formatThinking, stripThinking } = await import(new URL('../out/persona/thinking.js', import.meta.url));

/** Feeds deltas through a parser and returns everything it emitted. */
const run = deltas => {
	let out = '';
	const p = new ThinkingStreamParser(t => { out += t; });
	for (const d of deltas) { p.push(d); }
	p.flush();
	return out;
};

// Whole message in one delta.
assert.equal(
	run(['<thinking>plan it</thinking>Answer.']),
	'🤔 *Thinking…*\n\nplan it\n\n---\n\nAnswer.');

// Tags split across chunk boundaries (the streaming case).
assert.equal(
	run(['<thin', 'king>a', 'b</thi', 'nking>ok']),
	'🤔 *Thinking…*\n\nab\n\n---\n\nok');

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
console.log('test-persona-thinking stripThinking: all assertions passed');
