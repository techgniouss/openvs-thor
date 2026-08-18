/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the token-batching coalescer in src/remote/coalescer.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-coalescer.mjs
//
// src/remote/coalescer.ts is vscode-free and pure, so — like test-session-bus.mjs — this
// imports the compiled module directly, no Module._load stub needed. Timing is asserted
// exactly (not "eventually") via a hand-rolled fake clock: `setTimeout`/`clearTimeout` never
// touch a real timer, and `advance(ms)` fires whatever is due, in `fireAt` order.
import assert from 'node:assert/strict';
import { TokenCoalescer } from '../out/remote/coalescer.js';

/** A fake clock: `deps` to inject into a TokenCoalescer, `advance(ms)` to drive it. */
function fakeClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		deps: {
			now: () => now,
			setTimeout: (fn, ms) => {
				const id = nextId++;
				timers.set(id, { fireAt: now + ms, fn });
				return id;
			},
			clearTimeout: id => { timers.delete(id); },
		},
		advance(ms) {
			now += ms;
			for (; ;) {
				let dueId;
				let dueFireAt = Infinity;
				for (const [id, t] of timers) {
					if (t.fireAt <= now && t.fireAt < dueFireAt) {
						dueId = id;
						dueFireAt = t.fireAt;
					}
				}
				if (dueId === undefined) {
					break;
				}
				const t = timers.get(dueId);
				timers.delete(dueId);
				t.fn();
			}
		},
	};
}

// 1. Many tokens within the window coalesce into one batch with concatenated delta.
{
	const clock = fakeClock();
	const emitted = [];
	const coalescer = new TokenCoalescer(m => emitted.push(m), clock.deps);
	coalescer.feed({ type: 'token', sessionId: 's1', delta: 'a' });
	coalescer.feed({ type: 'token', sessionId: 's1', delta: 'b' });
	coalescer.feed({ type: 'token', sessionId: 's1', delta: 'c' });
	assert.deepStrictEqual(emitted, [], 'nothing flushes before the window elapses or 2KB is reached');
	clock.advance(100);
	assert.deepStrictEqual(emitted, [{ type: 'token', sessionId: 's1', delta: 'abc' }],
		'the default 100ms window flushes one concatenated batch');
}

// 2. A toolStart mid-stream flushes the pending batch first and is itself emitted immediately,
// un-reordered — the ordering barrier.
{
	const clock = fakeClock();
	const emitted = [];
	const coalescer = new TokenCoalescer(m => emitted.push(m), clock.deps);
	coalescer.feed({ type: 'token', sessionId: 's1', delta: 'a' });
	coalescer.feed({ type: 'token', sessionId: 's1', delta: 'b' });
	coalescer.feed({ type: 'toolStart', sessionId: 's1', tool: 'run_command' });
	assert.deepStrictEqual(emitted, [
		{ type: 'token', sessionId: 's1', delta: 'ab' },
		{ type: 'toolStart', sessionId: 's1', tool: 'run_command' },
	], 'the buffered prose flushes ahead of the tool block, in order, with no timer needed');
}

// 3. The 8KB hard cap forces an early flush: a delta large enough to blow through the cap
// flushes whatever was already buffered first, then is flushed itself immediately (it alone
// exceeds the ordinary 2KB flush trigger too).
{
	const clock = fakeClock();
	const emitted = [];
	const coalescer = new TokenCoalescer(m => emitted.push(m), clock.deps);
	coalescer.feed({ type: 'token', sessionId: 's1', delta: 'x' });
	const huge = 'y'.repeat(9_000);
	coalescer.feed({ type: 'token', sessionId: 's1', delta: huge });
	assert.deepStrictEqual(emitted, [
		{ type: 'token', sessionId: 's1', delta: 'x' },
		{ type: 'token', sessionId: 's1', delta: huge },
	], 'the small buffered batch is flushed before the oversized delta, which is flushed on its own');
}

// 4. setRttMs changes the effective window: a fast RTT flushes at 60ms, not the 100ms default.
{
	const clock = fakeClock();
	const emitted = [];
	const coalescer = new TokenCoalescer(m => emitted.push(m), clock.deps);
	coalescer.setRttMs(30); // < 80ms -> 60ms window
	coalescer.feed({ type: 'token', sessionId: 's1', delta: 'a' });
	clock.advance(59);
	assert.deepStrictEqual(emitted, [], 'not yet — the adapted window has not elapsed');
	clock.advance(1);
	assert.deepStrictEqual(emitted, [{ type: 'token', sessionId: 's1', delta: 'a' }],
		'flushes right at the RTT-adapted 60ms window, not the 100ms default');
}

console.log('test-remote-coalescer: all assertions passed');
