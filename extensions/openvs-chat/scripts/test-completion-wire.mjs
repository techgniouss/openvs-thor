/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the completion transport contract. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-wire.mjs
import assert from 'node:assert/strict';

const types = await import(new URL('../out/providers/types.js', import.meta.url));
const rl = await import(new URL('../out/providers/rateLimits.js', import.meta.url));

// A completion request must not inherit the chat timeout: 150s of waiting for ghost text
// is dead weight, and a retried completion is stale by the time it lands. `rateLimitRetries:
// 0` on top of `retries: 0` — apiFetch's own 429 retry budget is otherwise independent of
// `retries` (see the `rateLimitRetries` override test in test-rate-limits.mjs), so without it
// a completion would still sleep out up to RATE_LIMIT_RETRIES worth of 429 backoffs.
assert.deepStrictEqual(types.COMPLETION_FETCH_OPTS, { timeoutMs: 2500, retries: 0, rateLimitRetries: 0 });

// modelSupportsFim: empty/absent patterns mean "no FIM", unlike toolModelPatterns where
// empty means "everything". A provider that says nothing must not be assumed capable.
const none = { fimModelPatterns: [] };
const some = { fimModelPatterns: ['codestral', 'qwen.*coder'] };
assert.strictEqual(types.modelSupportsFim(none, 'codestral-latest'), false);
assert.strictEqual(types.modelSupportsFim({}, 'codestral-latest'), false);
assert.strictEqual(types.modelSupportsFim(some, 'codestral-latest'), true);
assert.strictEqual(types.modelSupportsFim(some, 'Qwen2.5-Coder-7B'), true, 'case-insensitive');
assert.strictEqual(types.modelSupportsFim(some, 'mistral-large-latest'), false);

// noteOnlyOpts records headers but never paces: a completion that sleeps out a refill
// window arrives after the cursor moved. fetchOpts (chat/agent) keeps both halves.
{
	const tracker = new rl.RateLimitTracker();
	const opts = tracker.noteOnlyOpts('m');
	assert.deepStrictEqual(Object.keys(opts), ['onResponse']);
	assert.strictEqual('pace' in opts, false, 'completions must never pace');
	assert.deepStrictEqual(Object.keys(tracker.fetchOpts('m')).sort(), ['onResponse', 'pace'],
		'chat/agent path is unchanged');

	const headers = new Headers({
		'x-ratelimit-limit-tokens': '8000',
		'x-ratelimit-remaining-tokens': '1200',
		'x-ratelimit-reset-tokens': '30s',
	});
	opts.onResponse(new Response(null, { headers }));
	const snap = tracker.get('m');
	assert.strictEqual(snap.limitTokens, 8000);
	assert.strictEqual(snap.remainingTokens, 1200);
}

// --- FIM wire formats -------------------------------------------------------------------
// Pinned the same way test-provider-messages.mjs pins the chat shapes: the request body is
// the contract with the backend, and a silent change to it is a 400 on the typing path.
{
	const { OpenAICompatibleProvider } = await import(new URL('../out/providers/openaiCompatible.js', import.meta.url));
	const { MistralProvider } = await import(new URL('../out/providers/mistral.js', import.meta.url));
	const { CustomProvider } = await import(new URL('../out/providers/custom.js', import.meta.url));

	const req = {
		prefix: 'function add(a, b) {\n\t', suffix: '\n}\n', model: 'codestral-latest',
		apiKey: 'k', baseUrl: 'https://api.example.com/v1', maxTokens: 96,
		stop: ['\n\n'], signal: new AbortController().signal,
	};

	const custom = new CustomProvider();
	assert.strictEqual(custom.fimUrl(req.baseUrl), 'https://api.example.com/v1/completions',
		'OpenAI-compatible FIM is the legacy completions endpoint');
	assert.deepStrictEqual(JSON.parse(custom.fimBody(req)), {
		model: 'codestral-latest',
		prompt: 'function add(a, b) {\n\t',
		suffix: '\n}\n',
		max_tokens: 96,
		temperature: 0.1,
		stream: false,
		stop: ['\n\n'],
	});

	// Mistral serves FIM at its own path; La Plateforme does not expose /completions at all.
	const mistral = new MistralProvider();
	assert.strictEqual(mistral.fimUrl(req.baseUrl), 'https://api.example.com/v1/fim/completions');

	// Capability is opt-in per provider and per model.
	assert.ok(mistral.info.fimModelPatterns.length > 0);
	assert.strictEqual(types.modelSupportsFim(mistral.info, 'codestral-latest'), true);
	assert.strictEqual(types.modelSupportsFim(mistral.info, 'mistral-large-latest'), false,
		'only the coding models do FIM');
	assert.strictEqual(typeof mistral.completeFim, 'function');
	assert.strictEqual(typeof custom.completeFim, 'function');

	// A provider with no FIM endpoint must not inherit one by accident.
	const { AnthropicProvider } = await import(new URL('../out/providers/anthropic.js', import.meta.url));
	assert.strictEqual(new AnthropicProvider().completeFim, undefined,
		'Anthropic has no FIM endpoint and must fall back to the chat path');
}

// --- completeFim end-to-end wiring --------------------------------------------------------
// The block above pins fimUrl/fimBody in isolation; this drives completeFim itself through
// a stubbed fetch — the same way test-provider-messages.mjs pins the chat wire forms — so a
// bug in how the pieces are wired together, or in the response-parsing fallback, actually
// fails a test instead of passing by construction.
{
	const { CustomProvider } = await import(new URL('../out/providers/custom.js', import.meta.url));

	/** Installs a fetch stub that answers with `responses` in order, recording each request. */
	function stubFetch(responses) {
		const requests = [];
		globalThis.fetch = async (url, init) => {
			requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
			return responses[Math.min(requests.length - 1, responses.length - 1)]();
		};
		return requests;
	}

	const custom = new CustomProvider();

	// Non-streaming legacy-completions shape: choices[].text.
	let requests = stubFetch([() => new Response(
		JSON.stringify({ choices: [{ text: 'sum += n;' }] }),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	)]);
	const result = await custom.completeFim({
		prefix: 'function add(a, b) {\n\t', suffix: '\n}\n', model: 'qwen2.5-coder',
		apiKey: 'k', baseUrl: 'https://api.example.com/v1', maxTokens: 96,
		stop: ['\n\n'], signal: new AbortController().signal,
	});
	assert.strictEqual(result, 'sum += n;', 'completeFim parses a non-streaming {choices:[{text}]} response');
	assert.strictEqual(requests.length, 1);
	assert.strictEqual(requests[0].url, 'https://api.example.com/v1/completions');
	assert.deepStrictEqual(requests[0].body, {
		model: 'qwen2.5-coder', prompt: 'function add(a, b) {\n\t', suffix: '\n}\n',
		max_tokens: 96, temperature: 0.1, stream: false, stop: ['\n\n'],
	});
	assert.strictEqual(requests[0].headers['Authorization'], 'Bearer k',
		'the api key reaches the request as a bearer header');

	// A chat-shaped reply on the same endpoint (choices[].message.content) is also parsed —
	// this is the fallback half of `choice?.text ?? choice?.message?.content ?? ''`.
	stubFetch([() => new Response(
		JSON.stringify({ choices: [{ message: { content: 'chat-shaped' } }] }),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	)]);
	const chatShaped = await custom.completeFim({
		prefix: 'x', suffix: '', model: 'qwen2.5-coder', apiKey: 'k',
		baseUrl: 'https://api.example.com/v1', maxTokens: 10, stop: [],
		signal: new AbortController().signal,
	});
	assert.strictEqual(chatShaped, 'chat-shaped');

	// The capability guard throws at the completeFim call site itself, not just inside the
	// underlying modelSupportsFim() helper this test already checks in isolation above.
	await assert.rejects(
		() => custom.completeFim({
			prefix: '', suffix: '', model: 'llama3.1', apiKey: 'k',
			baseUrl: 'https://api.example.com/v1', maxTokens: 10, stop: [],
			signal: new AbortController().signal,
		}),
		/has no FIM endpoint/,
	);

	// Fix 3: an HTTP error response must reject, not silently parse to '' as "no suggestion".
	// Without the `!response.ok` check a 404 (bad local model name) or a revoked key parses
	// to `{}`, `completeFim` resolves to '', and the failure is invisible forever.
	requests = stubFetch([() => new Response(
		JSON.stringify({ error: { message: 'model not found' } }),
		{ status: 404, headers: { 'Content-Type': 'application/json' } },
	)]);
	await assert.rejects(
		() => custom.completeFim({
			prefix: 'x', suffix: '', model: 'qwen2.5-coder', apiKey: 'k',
			baseUrl: 'https://api.example.com/v1', maxTokens: 10, stop: [],
			signal: new AbortController().signal,
		}),
		/404|model not found/,
		'a non-2xx FIM response rejects instead of resolving to an empty completion',
	);
}

// --- isCompletion transport override (Fix 1) ----------------------------------------------
// The chat-fallback branch (`streamChat`) of a completion request must apply the same tight,
// never-pace budget `completeFim` already uses when `isCompletion` is set, not the full chat
// transport (150s timeout, an extra retry, and a `pace` hook that can sleep out a rate-limit
// window) — see `ChatRequest.isCompletion`'s doc comment. This primes the provider's rate-limit
// tracker with a reading that WOULD force a multi-second wait under the normal chat fetchOpts,
// then proves a request marked `isCompletion: true` both resolves promptly (no pace sleep) and
// still records the response (`rateLimit()` updates, proving `onResponse`/`noteOnlyOpts` fired).
{
	const { CustomProvider } = await import(new URL('../out/providers/custom.js', import.meta.url));

	/** One SSE response with a terminal `finish_reason`, enough for streamChat to complete. */
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

	const chatRequest = extra => ({
		messages: [{ role: 'user', content: 'hi' }], model: 'm', apiKey: 'k',
		baseUrl: 'https://api.example.com/v1', maxTokens: 10,
		signal: new AbortController().signal, onToken: () => { },
		...extra,
	});

	const provider = new CustomProvider();
	const realFetch = globalThis.fetch;
	try {
		// Prime the tracker with a reading a `pace` hook would act on: almost no tokens left,
		// refilling in 3s. `apiFetch` hands every response to `onResponse` regardless of which
		// path made the call, so any request recording this reading is enough — the stream
		// itself is deliberately malformed (no terminal event) and rejects, which is fine here.
		globalThis.fetch = async () => new Response('{}', {
			status: 200,
			headers: {
				'x-ratelimit-limit-tokens': '8000',
				'x-ratelimit-remaining-tokens': '1',
				'x-ratelimit-reset-tokens': '3s',
			},
		});
		await provider.streamChat(chatRequest()).catch(() => { /* priming body isn't real SSE */ });
		assert.ok(provider.rateLimit('m'), 'the priming call recorded a rate-limit reading');

		globalThis.fetch = async () => completion();
		const started = Date.now();
		await provider.streamChat(chatRequest({ isCompletion: true }));
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 1500,
			`isCompletion must never pace out a rate-limit window (took ${elapsed}ms against a reading ` +
			'that forces a multi-second wait under the normal chat fetchOpts)');
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log('all assertions passed');
