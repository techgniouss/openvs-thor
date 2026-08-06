/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/rateLimits.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-rate-limits.mjs
//
// These headers are the only place a backend states the limit that actually stops an agent
// run — a per-request token allowance unrelated to the model's context window. Misreading
// one is silent: the run just keeps sending requests that get refused.
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/rateLimits.js', import.meta.url));

/** A Headers stand-in built from a plain object, matching the real lookup semantics. */
const headers = obj => new Headers(obj);

// Duration formats, all three shapes gateways actually send.
{
	const now = Date.UTC(2026, 0, 1, 12, 0, 0);
	assert.deepStrictEqual(
		[
			m.parseResetMs('7.5s'),
			m.parseResetMs('2m59.56s'),
			m.parseResetMs('1h2m3s'),
			m.parseResetMs('120ms'),
			m.parseResetMs('30'),
			m.parseResetMs('2026-01-01T12:00:45Z', now),
			m.parseResetMs('not a duration'),
			m.parseResetMs(''),
			m.parseResetMs(undefined),
		],
		[7_500, 179_560, 3_723_000, 120, 30_000, 45_000, undefined, undefined, undefined],
		'Go-style durations, bare seconds and RFC3339 instants all parse; nonsense stays undefined',
	);
	// `m` must not swallow the `ms` suffix — 120ms is not two minutes.
	assert.notStrictEqual(m.parseResetMs('120ms'), 120_000, 'ms is not minutes');
}

// Groq/OpenAI spelling and Anthropic's are both read, and a response with neither is silent.
{
	const groq = m.parseRateLimitHeaders(headers({
		'x-ratelimit-limit-tokens': '8000',
		'x-ratelimit-remaining-tokens': '1200',
		'x-ratelimit-reset-tokens': '7.5s',
	}), 1_000);
	const anthropic = m.parseRateLimitHeaders(headers({
		'anthropic-ratelimit-input-tokens-limit': '40000',
		'anthropic-ratelimit-input-tokens-remaining': '39000',
	}), 1_000);
	assert.deepStrictEqual(
		[groq, anthropic, m.parseRateLimitHeaders(headers({ 'content-type': 'application/json' }))],
		[
			{ limitTokens: 8_000, remainingTokens: 1_200, resetMs: 7_500, at: 1_000 },
			{ limitTokens: 40_000, remainingTokens: 39_000, resetMs: undefined, at: 1_000 },
			undefined,
		],
		'both header families parse; a response stating nothing yields nothing',
	);
}

// delayFor: wait only when waiting is clearly the right answer.
{
	const tracker = new m.RateLimitTracker();
	const note = (obj, at) => tracker.note('q', { headers: headers(obj) }, at);
	note({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '1000', 'x-ratelimit-reset-tokens': '10s' }, 0);
	assert.deepStrictEqual(
		[
			tracker.delayFor('q', 500, 0),      // fits what's left → send now
			tracker.delayFor('q', 5_000, 0),    // doesn't fit, window refills in 10s → wait
			tracker.delayFor('q', 5_000, 4_000), // 4s already elapsed → wait the remainder
			tracker.delayFor('q', 9_000, 0),    // bigger than the whole allowance → not a waiting problem
			tracker.delayFor('q', 5_000, 90_000), // reading is two windows old → worthless
			tracker.delayFor('other', 5_000, 0), // nothing known about this model
		],
		[0, 10_000, 6_000, 0, 0, 0],
		'pacing waits only for a request that fits the allowance but not the current window',
	);
}

// A reading with no reset can't be paced against — there is nothing to wait for.
{
	const tracker = new m.RateLimitTracker();
	tracker.note('q', { headers: headers({ 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '10' }) }, 0);
	assert.strictEqual(tracker.delayFor('q', 5_000, 0), 0, 'no reset header means no wait');
	assert.strictEqual(tracker.get('q').limitTokens, 8_000, 'but the ceiling is still recorded');
}

// The pace is capped: past half a minute, failing loudly beats hanging silently.
{
	const tracker = new m.RateLimitTracker();
	tracker.note('q', { headers: headers({ 'x-ratelimit-remaining-tokens': '1', 'x-ratelimit-reset-tokens': '10m' }) }, 0);
	assert.strictEqual(tracker.delayFor('q', 5_000, 0), 30_000, 'a long refill is capped, not obeyed');
}

// The transport wiring: apiFetch must hand every response to `onResponse` — including the
// ones it retries, since a 429 carries the most informative headers a backend ever sends —
// and must honour `pace` before sending rather than after failing.
{
	const { apiFetch } = await import(new URL('../out/providers/types.js', import.meta.url));
	const realFetch = globalThis.fetch;
	const statuses = [429, 200];
	const seen = [];
	let paced = 0;
	globalThis.fetch = async () => new Response('{}', {
		status: statuses.shift() ?? 200,
		headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': '0.01s' },
	});
	try {
		const response = await apiFetch('https://example.invalid/v1/chat', { method: 'POST', body: 'x'.repeat(400) },
			new AbortController().signal,
			{
				retries: 0,
				onResponse: r => seen.push(r.status),
				// 400 chars ≈ 100 tokens, so the estimate must reach the hook as a token count.
				pace: estimated => { paced = estimated; return 1; },
			});
		assert.deepStrictEqual(
			[seen, response.status, paced],
			[[429, 200], 200, 100],
			'both the retried 429 and the final 200 are reported; pacing is asked with the body size in tokens',
		);
	} finally {
		globalThis.fetch = realFetch;
	}
}

// Pacing applies to the first attempt only. Every retry path already waited a delay chosen
// for the failure it saw — a 429's own Retry-After most precisely — so pacing again would
// sleep twice for one refill while a run that has not stalled appears to hang.
{
	const { apiFetch } = await import(new URL('../out/providers/types.js', import.meta.url));
	const realFetch = globalThis.fetch;
	const statuses = [429, 200];
	let paceCalls = 0;
	globalThis.fetch = async () => new Response('{}', { status: statuses.shift() ?? 200, headers: { 'retry-after': '0' } });
	try {
		await apiFetch('https://example.invalid/v1/chat', { method: 'POST', body: 'x' }, new AbortController().signal,
			{ retries: 0, pace: () => { paceCalls++; return 0; } });
		assert.strictEqual(paceCalls, 1, 'the pacer is consulted once, not again on the 429 retry');
	} finally {
		globalThis.fetch = realFetch;
	}
}

// A signal that aborted BEFORE the wait started must not be slept through. `abort` fires
// once, so a listener added afterwards never hears it — the wait would run to completion,
// which is the one case (Stop landing mid-backoff) the interruptible sleep exists for.
{
	const { apiFetch } = await import(new URL('../out/providers/types.js', import.meta.url));
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response('{}', { status: 200 });
	const controller = new AbortController();
	controller.abort();
	const started = Date.now();
	try {
		await assert.rejects(
			() => apiFetch('https://example.invalid/v1/chat', { method: 'POST', body: 'x' }, controller.signal,
				{ retries: 0, pace: () => 10_000 }),
			e => e.name === 'AbortError',
		);
		assert.ok(Date.now() - started < 5_000, 'an already-aborted signal is not slept through');
	} finally {
		globalThis.fetch = realFetch;
	}
}

// A pacing wait must end the moment the user presses Stop, not when the timer elapses.
{
	const { apiFetch } = await import(new URL('../out/providers/types.js', import.meta.url));
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response('{}', { status: 200 });
	const controller = new AbortController();
	const started = Date.now();
	setTimeout(() => controller.abort(), 20);
	try {
		await assert.rejects(
			() => apiFetch('https://example.invalid/v1/chat', { method: 'POST', body: 'x' }, controller.signal,
				{ retries: 0, pace: () => 10_000 }),
			e => e.name === 'AbortError',
			'an aborted pace rejects instead of sleeping out the full wait',
		);
		assert.ok(Date.now() - started < 5_000, 'and it returns promptly rather than after the timer');
	} finally {
		globalThis.fetch = realFetch;
	}
}

// The 413 message and the detector that reads it are one contract across two modules: the
// wording here is what lets the agent loop shrink and retry instead of ending the run. A
// backend that sends an empty 413 body must still produce a message the detector matches.
{
	const { describeHttpError, retryNotice } = await import(new URL('../out/providers/types.js', import.meta.url));
	const { isContextLengthError, parseTokenLimit } = await import(new URL('../out/agent/context.js', import.meta.url));

	const withBody = await describeHttpError('Groq (free tier)', new Response(
		JSON.stringify({ error: { message: 'Request too large for model `q` on tokens per minute (TPM): Limit 8000, Requested 13155' } }),
		{ status: 413 },
	));
	const empty = await describeHttpError('Groq (free tier)', new Response('', { status: 413 }));
	assert.deepStrictEqual(
		[isContextLengthError(withBody), parseTokenLimit(withBody), isContextLengthError(empty)],
		[true, 8_000, true],
		'a 413 is detected and its ceiling parsed, and an empty-bodied 413 is still detected',
	);
	// A 429 for the same underlying ceiling must NOT be read as "shrink and retry": waiting
	// is what refills a per-minute quota, and the transport already does that.
	const rateLimited = await describeHttpError('Groq (free tier)', new Response(
		JSON.stringify({ error: { message: 'Rate limit reached for model `q` on tokens per minute (TPM): Limit 8000, Used 7900. Please try again in 6s.' } }),
		{ status: 429 },
	));
	assert.strictEqual(isContextLengthError(rateLimited), false, 'a 429 stays a wait, not a shrink');

	// Pacing is not a retry and must not claim to be one — nothing has failed.
	const paced = retryNotice('Groq (free tier)', { attempt: 0, delayMs: 7_500, reason: 'pacing' });
	assert.ok(/refills in 8s/.test(paced) && !/retrying/.test(paced), `pacing reads as a wait, not a failure: ${paced}`);
}

console.log('test-rate-limits: all assertions passed');
