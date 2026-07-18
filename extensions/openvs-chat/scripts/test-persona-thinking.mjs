// Standalone unit test for src/persona/thinking.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-thinking.mjs
import assert from 'node:assert/strict';

const { ThinkingStreamParser, formatThinking } = await import(new URL('../out/persona/thinking.js', import.meta.url));

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
