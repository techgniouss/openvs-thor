/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for readSSE in src/providers/types.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-sse.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/types.js', import.meta.url));

/** Builds a Response whose body emits the given strings as separate chunks. */
function sse(chunks, { stallAfter } = {}) {
	const body = new ReadableStream({
		async pull(controller) {
			const next = chunks.shift();
			if (next === undefined) {
				if (stallAfter) {
					return new Promise(() => { /* never settles: simulates a dead connection */ });
				}
				controller.close();
				return;
			}
			controller.enqueue(new TextEncoder().encode(next));
		},
	});
	return new Response(body);
}

const never = new AbortController().signal;
const collect = () => {
	const seen = [];
	return { seen, onEvent: d => seen.push(d) };
};

// 1. Normal stream: every data line is delivered, [DONE] is not.
{
	const { seen, onEvent } = collect();
	await m.readSSE(sse(['data: {"a":1}\n', 'data: {"a":2}\n', 'data: [DONE]\n']), onEvent, never);
	assert.deepStrictEqual(seen, ['{"a":1}', '{"a":2}'], 'data lines delivered, [DONE] swallowed');
}

// 2. A final event without its trailing newline is still delivered (it carries finish_reason).
{
	const { seen, onEvent } = collect();
	await m.readSSE(sse(['data: {"a":1}\n', 'data: {"finish_reason":"stop"}']), onEvent, never);
	assert.deepStrictEqual(seen, ['{"a":1}', '{"finish_reason":"stop"}'], 'trailing line flushed');
}

// 3. Events split across chunk boundaries reassemble.
{
	const { seen, onEvent } = collect();
	await m.readSSE(sse(['data: {"a"', ':1}\ndata: {"b":2}\n']), onEvent, never);
	assert.deepStrictEqual(seen, ['{"a":1}', '{"b":2}'], 'split lines reassembled');
}

// 4. A stream that ends without the provider's terminal event is an error, not a clean finish.
{
	let threw;
	try {
		await m.readSSE(sse(['data: {"a":1}\n']), () => { }, never, {
			label: 'TestProvider',
			sawTerminal: () => false,
		});
	} catch (err) {
		threw = err;
	}
	assert.ok(threw, 'abnormal end must reject');
	assert.match(threw.message, /ended before it was complete/, 'explains the dropped connection');
	assert.match(threw.message, /^TestProvider:/, 'names the provider');
}

// 5. [DONE] counts as a terminal event even when the provider saw no finish_reason.
{
	await m.readSSE(sse(['data: {"a":1}\n', 'data: [DONE]\n']), () => { }, never, {
		label: 'TestProvider',
		sawTerminal: () => false,
	});
}

// 6. sawTerminal reporting true resolves normally.
{
	await m.readSSE(sse(['data: {"a":1}\n']), () => { }, never, {
		label: 'TestProvider',
		sawTerminal: () => true,
	});
}

// 7. Without options the old permissive behaviour is preserved (no terminal check).
{
	await m.readSSE(sse(['data: {"a":1}\n']), () => { }, never);
}

// 8. A stalled stream is aborted by the idle timeout rather than hanging forever.
{
	let threw;
	try {
		await m.readSSE(sse(['data: {"a":1}\n'], { stallAfter: true }), () => { }, never, {
			label: 'TestProvider',
			idleMs: 60,
		});
	} catch (err) {
		threw = err;
	}
	assert.ok(threw, 'stalled stream must reject');
	assert.match(threw.message, /stalled/, 'explains the stall');
}

// 9. A caller abort surfaces as AbortError.
{
	const ac = new AbortController();
	ac.abort();
	let threw;
	try {
		await m.readSSE(sse(['data: {"a":1}\n']), () => { }, ac.signal);
	} catch (err) {
		threw = err;
	}
	assert.strictEqual(threw?.name, 'AbortError', 'aborted read reports AbortError');
}

// 10. normalizeFinishReason maps every backend spelling onto the shared set.
assert.strictEqual(m.normalizeFinishReason('length'), 'length');
assert.strictEqual(m.normalizeFinishReason('max_tokens'), 'length');
assert.strictEqual(m.normalizeFinishReason('tool_use'), 'tool_calls');
assert.strictEqual(m.normalizeFinishReason('content_filter'), 'filtered');
assert.strictEqual(m.normalizeFinishReason('refusal'), 'refused');
assert.strictEqual(m.normalizeFinishReason('end_turn'), 'stop');
assert.strictEqual(m.normalizeFinishReason(undefined), undefined);

// --- streamChatWithContinuation -------------------------------------------------
// A truncated response whose text is only whitespace must not be continued: the prefill
// turn it would build is empty after the trailing-whitespace strip, which Anthropic
// rejects with HTTP 400 — turning a blank reply into a hard failure.
{
	let calls = 0;
	const prefillProvider = {
		info: { id: 'p', label: 'P', supportsAssistantPrefill: true },
		async streamChat(request) {
			calls++;
			request.onToken('   \n  ');
			return { truncated: true };
		},
		async listModels() { return []; },
	};
	const out = await m.streamChatWithContinuation(prefillProvider, {
		messages: [{ role: 'user', content: 'hi' }],
		model: 'm', apiKey: 'k', baseUrl: 'u', maxTokens: 10, signal: never,
		onToken: () => { },
	});
	assert.strictEqual(calls, 1, 'a whitespace-only truncated reply is not continued');
	assert.strictEqual(out.truncated, true, 'the caller still learns it was cut off');
	assert.strictEqual(out.text.trim(), '', 'the empty text is reported as-is, not hidden');
}

// Real text is still continued, and the accumulated result is returned in order.
{
	const chunksOut = ['part one', ' part two'];
	let calls = 0;
	const provider = {
		info: { id: 'p', label: 'P', supportsAssistantPrefill: true },
		async streamChat(request) {
			request.onToken(chunksOut[calls]);
			calls++;
			return { truncated: calls < 2 };
		},
		async listModels() { return []; },
	};
	const out = await m.streamChatWithContinuation(provider, {
		messages: [{ role: 'user', content: 'hi' }],
		model: 'm', apiKey: 'k', baseUrl: 'u', maxTokens: 10, signal: never,
		onToken: () => { },
	});
	assert.deepStrictEqual(out, { text: 'part one part two', truncated: false });
}

// --- repeat-loop guard ----------------------------------------------------------
// The signature of a model stuck in a loop, and the near misses that must not trip it.
{
	const bullet = "- Unused variable 'e' etc; ignore.\n";
	const cycle = '- The first of the pair.\n- The second of the pair.\n';
	assert.deepStrictEqual([
		m.endsInRepeatLoop(bullet.repeat(9)),
		// Mid-stream, the last line is a half-written copy of the one above it.
		m.endsInRepeatLoop(bullet.repeat(9) + "- Unused variable 'e' etc; ig"),
		// A cycle of lines is the same failure; it needs fewer repeats to be unmistakable.
		m.endsInRepeatLoop(cycle.repeat(5)),
		m.endsInRepeatLoop(bullet.repeat(4)),
		m.endsInRepeatLoop(cycle.repeat(2)),
		// Formatting, not a loop: closing braces and table rules repeat legitimately.
		m.endsInRepeatLoop('}\n'.repeat(12)),
		m.endsInRepeatLoop('| --- |\n'.repeat(12)),
		// A loop the model pulled out of is not a loop any more.
		m.endsInRepeatLoop(bullet.repeat(9) + 'So: three real findings, listed above.\nDone.'),
		m.endsInRepeatLoop(''),
	], [true, true, true, false, false, false, false, false, false]);
}

// A loop that fills its budget arrives as a max-token cutoff, indistinguishable from a
// long answer being clipped — so the continuation rounds used to hand it another budget,
// eight times over. It must be stopped at the first cutoff instead, with a notice.
{
	const line = 'The same sentence, over and over.\n';
	let calls = 0;
	const notices = [];
	const looper = {
		info: { id: 'p', label: 'P', supportsAssistantPrefill: true },
		async streamChat(request) {
			calls++;
			request.onToken(line.repeat(9));
			return { truncated: true };
		},
		async listModels() { return []; },
	};
	const out = await m.streamChatWithContinuation(looper, {
		messages: [{ role: 'user', content: 'hi' }],
		model: 'm', apiKey: 'k', baseUrl: 'u', maxTokens: 10, signal: never,
		onToken: () => { },
		onNotice: text => notices.push(text),
	});
	assert.deepStrictEqual(
		[calls, out.truncated, out.text === line.repeat(9), notices.length],
		[1, false, true, 1],
		'a repeating reply is returned as-is after one call, not continued');
}

// Mid-stream: the guard aborts the provider rather than letting the loop run to the end of
// its budget, and what streamed before the abort is kept.
{
	const line = 'The same sentence, over and over.\n';
	const seen = [];
	let aborted = false;
	const streamer = {
		info: { id: 'p', label: 'P', supportsAssistantPrefill: true },
		async streamChat(request) {
			for (let i = 0; i < 400; i++) {
				if (request.signal.aborted) { aborted = true; break; }
				request.onToken(line);
			}
			if (request.signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			return { truncated: false };
		},
		async listModels() { return []; },
	};
	const out = await m.streamChatWithContinuation(streamer, {
		messages: [{ role: 'user', content: 'hi' }],
		model: 'm', apiKey: 'k', baseUrl: 'u', maxTokens: 10, signal: never,
		onToken: delta => seen.push(delta),
		onNotice: () => { },
	});
	assert.deepStrictEqual(
		[aborted, seen.length < 400, out.text.startsWith(line), out.truncated],
		[true, true, true, false],
		'the loop is cut off mid-stream and its text is kept');
}

// The mid-stream scan only ever looks at a bounded tail, so a loop that starts after a
// legitimate first round is still caught — the earlier text and the new chunk have to be
// stitched together for that, which is the part a naive tail-of-the-chunk check misses.
{
	const line = 'The same sentence, over and over.\n';
	let calls = 0;
	const notices = [];
	const provider = {
		info: { id: 'p', label: 'P', supportsAssistantPrefill: true },
		async streamChat(request) {
			calls++;
			if (calls === 1) {
				request.onToken('A long and perfectly sensible answer. '.repeat(200));
				return { truncated: true };
			}
			// Delivered in small pieces so the scan runs on the stitched tail, not one chunk.
			for (let i = 0; i < 40; i++) {
				if (request.signal.aborted) { throw new DOMException('Aborted', 'AbortError'); }
				request.onToken(line);
			}
			return { truncated: false };
		},
		async listModels() { return []; },
	};
	const out = await m.streamChatWithContinuation(provider, {
		messages: [{ role: 'user', content: 'hi' }],
		model: 'm', apiKey: 'k', baseUrl: 'u', maxTokens: 10, signal: never,
		onToken: () => { },
		onNotice: text => notices.push(text),
	});
	assert.deepStrictEqual(
		[calls, notices.length, out.truncated, out.text.startsWith('A long and')],
		[2, 1, false, true],
		'a loop that begins in a continuation round is caught too');
}

// The user's own Stop still surfaces as an abort, even from inside a repeating response —
// swallowing it would report a cancelled run as a completed one.
{
	const line = 'The same sentence, over and over.\n';
	const controller = new AbortController();
	const stopper = {
		info: { id: 'p', label: 'P', supportsAssistantPrefill: true },
		async streamChat(request) {
			request.onToken(line.repeat(9));
			controller.abort();
			throw new DOMException('Aborted', 'AbortError');
		},
		async listModels() { return []; },
	};
	await assert.rejects(() => m.streamChatWithContinuation(stopper, {
		messages: [{ role: 'user', content: 'hi' }],
		model: 'm', apiKey: 'k', baseUrl: 'u', maxTokens: 10, signal: controller.signal,
		onToken: () => { },
	}), err => m.isAbortError(err));
}

console.log('test-sse: all assertions passed');
