/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/chatgptBackend.ts, the ChatGPT-subscription route
// the OpenAI provider takes for a ChatGPT sign-in token. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-chatgpt-backend.mjs
import assert from 'node:assert/strict';
import Module from 'node:module';

// oauth.ts (for the JWT helpers) imports the host API; none of it is reached here.
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const { chatgptAgentStep, chatgptStreamChat } = await import(new URL('../out/providers/chatgptBackend.js', import.meta.url));
const { OPEN_MARK, CLOSE_MARK } = await import(new URL('../out/persona/thinking.js', import.meta.url));

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })}.sig`;

/** An SSE response made of the given Responses API events. */
function sse(events) {
	const body = new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stubFetch(responses) {
	const bodies = [];
	globalThis.fetch = async (_url, init) => {
		bodies.push(JSON.parse(init.body));
		return responses[Math.min(bodies.length - 1, responses.length - 1)]();
	};
	return bodies;
}

const request = extra => ({
	messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
	model: 'gpt-5.4',
	apiKey: TOKEN,
	baseUrl: '',
	maxTokens: 1000,
	signal: new AbortController().signal,
	onToken: () => { },
	onNotice: () => { },
	...extra,
});

// 1. The reasoning summary is asked for and streams between the thinking marks, apart from the answer.
{
	const bodies = stubFetch([() => sse([
		{ type: 'response.reasoning_summary_text.delta', delta: 'Considering.' },
		{ type: 'response.output_text.delta', delta: 'Done.' },
		{ type: 'response.completed' },
	])]);
	let streamed = '';
	await chatgptStreamChat('ChatGPT', request({ onToken: t => { streamed += t; } }));
	assert.deepStrictEqual(bodies[0].reasoning, { summary: 'auto' });
	assert.strictEqual(streamed, `${OPEN_MARK}Considering.${CLOSE_MARK}Done.`);
}

// 2. If the backend ever refuses the reasoning field, the request is retried without it.
{
	const bodies = stubFetch([
		() => new Response(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning.summary' } }), { status: 400 }),
		() => sse([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed' }]),
	]);
	const step = await chatgptAgentStep('ChatGPT', { ...request(), tools: [] });
	assert.strictEqual(step.content, 'ok');
	assert.deepStrictEqual([bodies.length, 'reasoning' in bodies[1]], [2, false]);
}

// 3. A model a ChatGPT sign-in cannot serve is replaced — and the user is told which one answered.
{
	const bodies = stubFetch([() => sse([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed' }])]);
	const notices = [];
	await chatgptStreamChat('ChatGPT', request({ model: 'gpt-4o', onNotice: t => notices.push(t) }));
	assert.strictEqual(bodies[0].model, 'gpt-5.4-mini');
	assert.match(notices.join('\n'), /gpt-4o isn't available with a ChatGPT sign-in, so gpt-5\.4-mini answered/);
}

console.log('test-chatgpt-backend: all assertions passed');
