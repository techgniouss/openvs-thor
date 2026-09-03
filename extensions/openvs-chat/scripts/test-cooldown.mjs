/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/cooldown.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-cooldown.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/cooldown.js', import.meta.url));

// Plain rate limit -> short cooldown; not cooling before it, cooling during, clear after.
{
	const c = new m.CooldownTracker();
	const now = 1_000_000;
	assert.equal(c.isCoolingDown('groq', 'llama', now), false);
	const until = c.markCooldown('groq', 'llama', 'HTTP 429 rate limited, try again in 2s', now);
	assert.equal(until, now + 60_000, 'plain rate limit parks for 60s');
	assert.equal(c.isCoolingDown('groq', 'llama', now + 1), true);
	assert.equal(c.isCoolingDown('groq', 'llama', now + 60_001), false, 'cooldown expires');
}

// Daily/monthly exhaustion markers earn the much longer cooldown.
{
	const now = 0;
	const daily = [
		'exceeded your current quota, please check your plan (per day)',
		'RESOURCE_EXHAUSTED',
		'insufficient_quota',
		'You have run out of credits',
		'Payment required to access this resource',
		'unable to verify your membership benefits', // Kimi-style subscription refusal
	];
	for (const detail of daily) {
		const c2 = new m.CooldownTracker();
		const until = c2.markCooldown('p', 'm', detail, now);
		assert.equal(until, 900_000, `"${detail}" should earn the daily cooldown, got ${until}ms`);
	}
	// Sanity: markCooldown is case-insensitive.
	const c = new m.CooldownTracker();
	const until = c.markCooldown('p', 'm', 'RESOURCE_EXHAUSTED', now);
	assert.equal(until, 900_000);
}

// clear() ends a cooldown early, e.g. after a successful call on a different key.
{
	const c = new m.CooldownTracker();
	c.markCooldown('p', 'm', '429', 0);
	assert.equal(c.isCoolingDown('p', 'm', 1), true);
	c.clear('p', 'm');
	assert.equal(c.isCoolingDown('p', 'm', 1), false);
}

// Cooldowns are keyed by (provider, model) pair — cooling one model must not cool a
// sibling model on the same provider, since a per-model free-tier quota is common
// (e.g. Groq metering `qwen/qwen3.6-27b` separately from `llama-3.3-70b`).
{
	const c = new m.CooldownTracker();
	c.markCooldown('groq', 'model-a', '429', 0);
	assert.equal(c.isCoolingDown('groq', 'model-a', 1), true);
	assert.equal(c.isCoolingDown('groq', 'model-b', 1), false);
}

// remainingMs never goes negative and is 0 once expired or never set.
{
	const c = new m.CooldownTracker();
	assert.equal(c.remainingMs('p', 'm', 0), 0);
	c.markCooldown('p', 'm', '429', 0);
	assert.equal(c.remainingMs('p', 'm', 60_001), 0);
	assert.ok(c.remainingMs('p', 'm', 30_000) > 0);
}

console.log('All cooldown assertions passed.');
