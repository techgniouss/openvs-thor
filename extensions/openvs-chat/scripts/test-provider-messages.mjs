/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for how OpenAI-compatible providers put an assistant turn carrying
// BOTH narration and tool calls on the wire. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-provider-messages.mjs
//
// This is the seam NVIDIA forced open: its gateway rejects `content` and `tool_calls` on
// one assistant message, and the old answer was to drop the narration. That left the model
// a transcript of its own tool calls with no record of why it made any of them, so every
// step re-derived the plan and re-read the same files. The split-turn form keeps it.
import assert from 'node:assert/strict';

const { NvidiaProvider } = await import(new URL('../out/providers/nvidia.js', import.meta.url));
const { KimiProvider } = await import(new URL('../out/providers/kimi.js', import.meta.url));
const { OpenRouterProvider } = await import(new URL('../out/providers/openrouter.js', import.meta.url));

/** One SSE response that is enough for readSSE to see a terminal event and finish. */
function completion(text = 'ok') {
	const body = new ReadableStream({
		start(controller) {
			const event = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });
			controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`));
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * Installs a fetch stub that answers with `responses` in order (the last one repeating),
 * recording the parsed body of every request.
 */
function stubFetch(responses) {
	const bodies = [];
	globalThis.fetch = async (_url, init) => {
		bodies.push(JSON.parse(init.body));
		return responses[Math.min(bodies.length - 1, responses.length - 1)]();
	};
	return bodies;
}

/** A conversation whose assistant turn carries narration AND a tool call. */
const conversation = [
	{ role: 'user', content: 'fix the parser' },
	{ role: 'assistant', content: 'Reading the parser first.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'p.ts' } }] },
	{ role: 'tool', content: 'file contents', toolCallId: 'c1' },
];

const request = provider => ({
	messages: conversation,
	tools: [{ name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }],
	model: 'm',
	apiKey: 'k',
	baseUrl: 'https://example.invalid/v1',
	maxTokens: 100,
	signal: new AbortController().signal,
	onToken: () => { },
	onNotice: () => { },
	provider,
});

/** The wire messages of the n-th recorded request. */
const sent = (bodies, n) => bodies[n].messages.map(m => ({
	role: m.role,
	content: m.content,
	tools: (m.tool_calls ?? []).map(t => t.function.name),
}));

// 1. A backend that takes the OpenAI shape keeps narration and tool calls on one turn.
{
	const bodies = stubFetch([() => completion()]);
	await new KimiProvider().runAgentStep(request());
	assert.deepStrictEqual(sent(bodies, 0), [
		{ role: 'user', content: 'fix the parser', tools: [] },
		{ role: 'assistant', content: 'Reading the parser first.', tools: ['read_file'] },
		{ role: 'tool', content: 'file contents', tools: [] },
	], 'inline form is unchanged');
}

// 2. NVIDIA rejects that combination, so the narration becomes its own assistant turn
// immediately before the tool-call turn — kept, not discarded.
{
	const bodies = stubFetch([() => completion()]);
	await new NvidiaProvider().runAgentStep(request());
	assert.deepStrictEqual(sent(bodies, 0), [
		{ role: 'user', content: 'fix the parser', tools: [] },
		{ role: 'assistant', content: 'Reading the parser first.', tools: [] },
		{ role: 'assistant', content: null, tools: ['read_file'] },
		{ role: 'tool', content: 'file contents', tools: [] },
	], 'narration is split into its own turn, not dropped');
}

// 3. Whether a gateway accepts two consecutive assistant turns can only be learned from the
// gateway. A 400 that complains about message shape demotes the session to dropping the
// narration and retries, rather than failing the step.
{
	const rejection = () => new Response(
		JSON.stringify({ error: { message: 'consecutive assistant messages are not supported' } }),
		{ status: 400 });
	const bodies = stubFetch([rejection, () => completion()]);
	const provider = new NvidiaProvider();
	await provider.runAgentStep(request());
	assert.strictEqual(bodies.length, 2, 'the rejected split form is retried');
	assert.deepStrictEqual(sent(bodies, 1), [
		{ role: 'user', content: 'fix the parser', tools: [] },
		{ role: 'assistant', content: null, tools: ['read_file'] },
		{ role: 'tool', content: 'file contents', tools: [] },
	], 'the retry drops the narration');

	// The demotion sticks for the session: re-probing on every call would pay for the same
	// rejection over and over.
	const later = stubFetch([() => completion()]);
	await provider.runAgentStep(request());
	assert.strictEqual(later.length, 1, 'no second probe');
	assert.deepStrictEqual(sent(later, 0).map(m => m.role), ['user', 'assistant', 'tool'],
		'later calls go straight to the drop form');
}

// 4. A 400 about anything else is a real failure: it must surface with the backend's own
// wording rather than being retried into a different, equally broken request.
{
	const bodies = stubFetch([() => new Response(
		JSON.stringify({ error: { message: 'model "m" does not exist' } }), { status: 400 })]);
	let threw;
	try {
		await new NvidiaProvider().runAgentStep(request());
	} catch (err) {
		threw = err;
	}
	assert.match(threw?.message ?? '', /does not exist/, 'the real error reaches the caller');
	assert.strictEqual(bodies.length, 1, 'an unrelated 400 is not retried');
}

// 5. An assistant turn with tool calls but no narration has nothing to split out — an empty
// assistant turn is rejected outright by several backends.
{
	const bodies = stubFetch([() => completion()]);
	await new NvidiaProvider().runAgentStep({
		...request(),
		messages: [
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '   ', toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] },
			{ role: 'tool', content: 'x', toolCallId: 'c1' },
		],
	});
	assert.deepStrictEqual(sent(bodies, 0).map(m => m.role), ['user', 'assistant', 'tool'],
		'whitespace-only narration produces no extra turn');
}

// 6. Anthropic and Gemini behind OpenRouter cache only what they are told to cache, so the
// system turn and the moving tail get explicit breakpoints. Without them an agent run
// re-reads the whole conversation at full price on every step.
{
	const withSystem = [{ role: 'system', content: 'you are thor' }, ...conversation];
	const bodies = stubFetch([() => completion()]);
	await new OpenRouterProvider().runAgentStep({ ...request(), model: 'anthropic/claude-sonnet-4.5', messages: withSystem });
	const sentMessages = bodies[0].messages;
	assert.deepStrictEqual(sentMessages[0].content,
		[{ type: 'text', text: 'you are thor', cache_control: { type: 'ephemeral' } }],
		'the system turn is a breakpoint');
	// The last turn carrying plain text is the tool result; the breakpoint moves there so
	// the next step's cache covers everything this step sent.
	assert.deepStrictEqual(sentMessages.at(-1).content,
		[{ type: 'text', text: 'file contents', cache_control: { type: 'ephemeral' } }],
		'the tail is a breakpoint too');
	assert.strictEqual(
		sentMessages.filter(m => Array.isArray(m.content) && m.content.some(p => p.cache_control)).length, 2,
		'exactly two breakpoints — the upstream allows four, and each one costs a cache write');
}

// 6b. Every other OpenRouter upstream caches a repeated prefix on its own, so the plain
// string form is left alone rather than converted for nothing.
{
	const withSystem = [{ role: 'system', content: 'you are thor' }, ...conversation];
	const bodies = stubFetch([() => completion()]);
	await new OpenRouterProvider().runAgentStep({ ...request(), model: 'openai/gpt-4o-mini', messages: withSystem });
	assert.strictEqual(bodies[0].messages[0].content, 'you are thor', 'no breakpoints where they buy nothing');
}

// 6c. A backend that caches nothing never gets them either.
{
	const withSystem = [{ role: 'system', content: 'you are thor' }, ...conversation];
	const bodies = stubFetch([() => completion()]);
	await new NvidiaProvider().runAgentStep({ ...request(), messages: withSystem });
	assert.strictEqual(bodies[0].messages[0].content, 'you are thor', 'NVIDIA gets the plain form');
}

// 7. Whether a long conversation is expensive is a property of the backend, and the agent
// loop reads it from here to decide how eagerly to compact.
{
	assert.deepStrictEqual(
		[
			new OpenRouterProvider().info.cachesPrompts === true,
			new NvidiaProvider().info.cachesPrompts === true,
			new KimiProvider().info.cachesPrompts === true,
		],
		[true, false, false],
		'caching is declared per provider, and defaults to off',
	);
}

console.log('test-provider-messages.mjs: all assertions passed');
