/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the Anthropic Messages client (src/providers/anthropic.ts):
// extended thinking per model, thinking-block replay across a tool round, the recovery
// when a backend refuses thinking, prefill per model, and refusals. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-anthropic.mjs
import assert from 'node:assert/strict';

const { AnthropicProvider, thinkingStyle } = await import(new URL('../out/providers/anthropic.js', import.meta.url));
const { OPEN_MARK, CLOSE_MARK } = await import(new URL('../out/persona/thinking.js', import.meta.url));
const { streamChatWithContinuation } = await import(new URL('../out/providers/types.js', import.meta.url));

/** An SSE response made of the given Messages API events. */
function sse(events) {
	const body = new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Installs a fetch stub answering with `responses` in order, recording url, headers and body. */
function stubFetch(responses) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
		return responses[Math.min(calls.length - 1, responses.length - 1)]();
	};
	return calls;
}

const text = t => [
	{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
];

const request = (model, extra = {}) => ({
	messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
	model,
	apiKey: 'sk-ant-api-key',
	baseUrl: 'https://api.anthropic.com/v1',
	maxTokens: 8_192,
	signal: new AbortController().signal,
	onToken: () => { },
	onNotice: () => { },
	...extra,
});

// 1. Which thinking each model takes, from the API's per-model rules.
assert.deepStrictEqual(
	['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6',
		'claude-haiku-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'].map(thinkingStyle),
	['always', 'always', 'default-on', 'default-on', 'adaptive-display', 'adaptive',
		'budget', 'budget', 'budget', 'budget', 'none'],
);

// 2. The request each style sends — and nothing when thinking is off.
{
	const sentThinking = async (model, mode = 'auto', maxTokens = 8_192) => {
		const calls = stubFetch([() => sse(text('ok'))]);
		await new AnthropicProvider(() => mode).streamChat(request(model, { maxTokens }));
		return calls[0].body.thinking;
	};
	assert.deepStrictEqual(await sentThinking('claude-opus-4-8'), { type: 'adaptive', display: 'summarized' });
	assert.deepStrictEqual(await sentThinking('claude-sonnet-4-6'), { type: 'adaptive' });
	assert.deepStrictEqual(await sentThinking('claude-haiku-4-5'), { type: 'enabled', budget_tokens: 4_096 });
	assert.deepStrictEqual(await sentThinking('claude-haiku-4-5', 'auto', 1_800), undefined, 'no room for a 1024 budget plus a reply');
	assert.deepStrictEqual(await sentThinking('claude-3-5-haiku-latest'), undefined);
	assert.deepStrictEqual(await sentThinking('claude-fable-5-1', 'off'), undefined, '"off" omits it; `disabled` is a 400 there');
}

// 3. Thinking streams into the transcript between the thinking marks; the answer stays clean.
{
	stubFetch([() => sse([
		{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing it.' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
		{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } },
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
	])]);
	let streamed = '';
	await new AnthropicProvider().streamChat(request('claude-opus-4-8', { onToken: t => { streamed += t; } }));
	assert.strictEqual(streamed, `${OPEN_MARK}Weighing it.${CLOSE_MARK}Answer.`);
}

// 4. An agent step returns its thinking blocks; the next request replays them with that tool
// round only (ahead of its tool_use), strips every earlier turn's, and opts into drop_block
// against Anthropic's own endpoint.
{
	stubFetch([() => sse([
		{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'S2' } },
		{ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'R' } },
		{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't2', name: 'read_file' } },
		{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' } },
		{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
	])]);
	const provider = new AnthropicProvider();
	const tools = [{ name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }];
	const step = await provider.runAgentStep({ ...request('claude-opus-4-8'), tools });
	assert.deepStrictEqual(step.thinkingBlocks, [{ type: 'thinking', thinking: 'plan', signature: 'S2' }, { type: 'redacted_thinking', data: 'R' }]);
	assert.deepStrictEqual(step.toolCalls, [{ id: 't2', name: 'read_file', args: { path: 'b.ts' } }]);

	const calls = stubFetch([() => sse(text('done'))]);
	const messages = [
		{ role: 'system', content: 'SYS' },
		{ role: 'user', content: 'go' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }], thinkingBlocks: [{ type: 'thinking', thinking: 'old', signature: 'S1' }] },
		{ role: 'tool', content: 'A', toolCallId: 't1' },
		{ role: 'assistant', content: '', toolCalls: step.toolCalls, thinkingBlocks: step.thinkingBlocks },
		{ role: 'tool', content: 'B', toolCallId: 't2' },
	];
	await provider.runAgentStep({ ...request('claude-opus-4-8'), messages, tools });
	const wire = calls[0].body.messages;
	assert.deepStrictEqual(wire[1].content.map(b => b.type), ['tool_use'], 'the earlier round goes without its thinking');
	assert.deepStrictEqual(wire[3].content.map(b => b.type), ['thinking', 'redacted_thinking', 'tool_use'], 'the current round replays it, first');
	assert.strictEqual(wire[3].content[0].signature, 'S2', 'verbatim');
	assert.deepStrictEqual(calls[0].body.thinking.block_binding, { prefix_mismatch_behavior: 'drop_block' });
	assert.match(calls[0].headers['anthropic-beta'], /thinking-binding-controls-2026-08-01/);

	// Off Anthropic's own endpoint the control is not sent; a thinking refusal is retried once
	// with all thinking stripped (the documented recovery) instead of failing the step.
	const retried = stubFetch([
		() => new Response(JSON.stringify({ error: { message: 'messages.1.content.0: Invalid `signature` in `thinking` block.' } }), { status: 400 }),
		() => sse(text('done')),
	]);
	await provider.runAgentStep({ ...request('claude-opus-4-8', { baseUrl: 'https://proxy.example/v1' }), messages, tools });
	assert.strictEqual(retried.length, 2);
	assert.strictEqual(retried[0].body.thinking.block_binding, undefined, 'no control off the first-party endpoint');
	assert.strictEqual(retried[1].body.thinking, undefined);
	assert.ok(!retried[1].body.messages.some(m => m.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking')));
	// A 400 about anything else is returned as-is, not retried.
	const other = stubFetch([() => new Response(JSON.stringify({ error: { message: 'max_tokens: too large' } }), { status: 400 })]);
	await assert.rejects(provider.runAgentStep({ ...request('claude-opus-4-8'), messages, tools }), /too large/);
	assert.strictEqual(other.length, 1);
}

// 5. Prefill only where the API takes it: current models reject it (and any request with
// thinking on), so a cut-off reply continues through a user turn instead of failing.
{
	assert.strictEqual(new AnthropicProvider().supportsPrefill('claude-sonnet-5'), false);
	assert.strictEqual(new AnthropicProvider().supportsPrefill('claude-haiku-4-5'), false, 'thinking is on for it');
	assert.strictEqual(new AnthropicProvider(() => 'off').supportsPrefill('claude-haiku-4-5'), true);
	assert.strictEqual(new AnthropicProvider().supportsPrefill('claude-3-5-haiku-latest'), true);

	const cut = [
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
		{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part one ' } },
		{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
	];
	const calls = stubFetch([() => sse(cut), () => sse(text('part two.'))]);
	const result = await streamChatWithContinuation(new AnthropicProvider(), request('claude-sonnet-5'));
	assert.strictEqual(result.text, 'Part one part two.');
	const second = calls[1].body.messages;
	assert.deepStrictEqual(second.map(m => m.role), ['user', 'assistant', 'user'], 'continued through a user turn, not a prefill');
}

// 6. A refusal says so, with the API's category, instead of reading as an empty reply.
{
	stubFetch([() => sse([{ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }])]);
	await assert.rejects(new AnthropicProvider().streamChat(request('claude-opus-5')), /declined this request \(cyber\)/);
}

console.log('test-anthropic: all assertions passed');
