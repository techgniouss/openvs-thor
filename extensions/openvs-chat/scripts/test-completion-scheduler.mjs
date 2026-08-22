/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the completion governance layer. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-scheduler.mjs
import assert from 'node:assert/strict';

const cacheMod = await import(new URL('../out/completions/cache.js', import.meta.url));
const healthMod = await import(new URL('../out/completions/health.js', import.meta.url));
const schedMod = await import(new URL('../out/completions/scheduler.js', import.meta.url));

// --- cache ------------------------------------------------------------------------------
{
	const cache = new cacheMod.CompletionCache(4);
	const k = cache.keyFor('m', 'const a = ', ';\n');
	cache.set(k, '1');
	assert.strictEqual(cache.get(k), '1');

	// The key covers the model, so switching models cannot serve a stale suggestion...
	assert.strictEqual(cache.get(cache.keyFor('other', 'const a = ', ';\n')), undefined);
	// ...and the suffix, so an edit below the cursor invalidates it.
	assert.strictEqual(cache.get(cache.keyFor('m', 'const a = ', ';\n\nmore')), undefined);

	// Returning to a position already asked about is served locally. This is the case the
	// editor's own forward stability does not cover: backspacing over a rejected suggestion.
	cache.set(cache.keyFor('m', 'const ab', ''), 'c = 1;');
	assert.strictEqual(cache.get(cache.keyFor('m', 'const ab', '')), 'c = 1;');

	// Bounded: the oldest entry is evicted rather than growing without limit.
	for (let i = 0; i < 6; i++) { cache.set(cache.keyFor('m', `p${i}`, ''), `v${i}`); }
	assert.strictEqual(cache.get(cache.keyFor('m', 'p0', '')), undefined, 'evicted');
	assert.strictEqual(cache.get(cache.keyFor('m', 'p5', '')), 'v5', 'retained');
}

// --- health -----------------------------------------------------------------------------
{
	const health = new healthMod.HealthTracker(3000, 5);
	assert.strictEqual(health.isSlow(), false, 'no samples means no opinion');
	// A single slow response is not a verdict — free tiers have cold starts, and tripping
	// on the first request would disable the feature on every fresh session.
	health.record(9000);
	assert.strictEqual(health.isSlow(), false);
	for (let i = 0; i < 4; i++) { health.record(9000); }
	assert.strictEqual(health.isSlow(), true, 'a consistently slow backend trips the breaker');
	// Recovery needs no restart.
	for (let i = 0; i < 5; i++) { health.record(300); }
	assert.strictEqual(health.isSlow(), false);
	health.record(9000);
	health.reset();
	assert.strictEqual(health.isSlow(), false, 'reset forgets history on a model change');
}

// --- quota gate -------------------------------------------------------------------------
{
	const sched = new schedMod.CompletionScheduler();
	const now = 1_000_000;
	const fresh = extra => ({ limitTokens: 8000, remainingTokens: 6000, resetMs: 30_000, at: now, ...extra });

	assert.strictEqual(sched.gate(fresh(), 0.15, now), 'ok');
	// Below the reserve, automatic completions stand down so Agent keeps the remainder.
	assert.strictEqual(sched.gate(fresh({ remainingTokens: 400 }), 0.15, now), 'paused-quota');
	// No data is not the same as no budget: most backends report nothing, and refusing on
	// no evidence would disable the feature for them entirely.
	assert.strictEqual(sched.gate(undefined, 0.15, now), 'ok');
	assert.strictEqual(sched.gate(fresh({ limitTokens: undefined }), 0.15, now), 'ok');
	// A stale reading is discarded rather than trusted — the window has probably refilled.
	assert.strictEqual(sched.gate(fresh({ remainingTokens: 400, at: now - 600_000 }), 0.15, now), 'ok');
}

// --- single flight ----------------------------------------------------------------------
{
	const sched = new schedMod.CompletionScheduler();
	let firstAborted = false;
	const first = sched.run(signal => new Promise(resolve => {
		signal.addEventListener('abort', () => { firstAborted = true; resolve('first'); });
	}));
	const second = await sched.run(async () => 'second');
	assert.strictEqual(await first, undefined, 'a superseded request resolves undefined, not stale text');
	assert.strictEqual(firstAborted, true, 'a new request aborts the one in flight');
	assert.strictEqual(second, 'second');

	// Disposal aborts whatever is outstanding, so nothing survives the provider.
	let thirdAborted = false;
	const third = sched.run(signal => new Promise(resolve => {
		signal.addEventListener('abort', () => { thirdAborted = true; resolve('third'); });
	}));
	sched.dispose();
	assert.strictEqual(await third, undefined);
	assert.strictEqual(thirdAborted, true);
}

// A request that genuinely fails (not superseded) rejects with the real error — this is
// the other half of the supersede-vs-error distinction run() exists to get right. Nothing
// else in this suite exercises the rethrow branch.
{
	const sched = new schedMod.CompletionScheduler();
	await assert.rejects(
		() => sched.run(async () => { throw new Error('boom'); }),
		/boom/,
		'an unsuperseded failure must reject with the real error, not resolve undefined',
	);
}

console.log('all assertions passed');
