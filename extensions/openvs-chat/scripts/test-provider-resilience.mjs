/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/resilience.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-provider-resilience.mjs
//
// Stubs the `vscode` module the same way test-auto-router.mjs does, so ProviderRegistry's
// SecretStorage dependency resolves to an in-memory fake instead of the real extension host.
import assert from 'node:assert/strict';
import Module from 'node:module';

/** Minimal in-memory SecretStorage — get/store/delete only, no change events needed here. */
class FakeSecretStorage {
	constructor() { this.map = new Map(); }
	async get(key) { return this.map.get(key); }
	async store(key, value) { this.map.set(key, value); }
	async delete(key) { this.map.delete(key); }
	onDidChange() { return { dispose() { } }; }
}

const vscodeStub = {
	workspace: {
		getConfiguration: () => ({ get: () => undefined, async update() { } }),
	},
	ConfigurationTarget: { Global: 1 },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return originalLoad(request, parent, isMain);
};

const { ProviderRegistry } = await import(new URL('../out/providers/registry.js', import.meta.url));
const { withProviderResilience } = await import(new URL('../out/providers/resilience.js', import.meta.url));

const PID = 'mistral'; // a real provider id registered by ProviderRegistry's constructor

// Success on the first try: no rotation, cooldown cleared.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'key-1');
	const result = await withProviderResilience(registry, PID, 'model-x', async apiKey => {
		assert.equal(apiKey, 'key-1');
		return 'ok';
	});
	assert.equal(result, 'ok');
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), false);
}

// 429 with a spare key: rotates and retries once, succeeds on the second key.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'key-1');
	await registry.setExtraApiKeys(PID, ['key-2']);
	let calls = 0;
	const result = await withProviderResilience(registry, PID, 'model-x', async apiKey => {
		calls++;
		if (apiKey === 'key-1') {
			throw new Error(`${PID}: rate limited (HTTP 429) — try again shortly.`);
		}
		return `used ${apiKey}`;
	});
	assert.equal(calls, 2);
	assert.equal(result, 'used key-2');
	// The cooldown recorded against the first key's failure is cleared once the RETRY
	// succeeds: the (provider, model) pair is not actually out of capacity — only that
	// one key was — so Auto-mode routing must not skip this pair on the strength of a
	// failure the rotation already recovered from.
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), false);
}

// 429 with no spare key: no rotation possible, the original error propagates and a
// cooldown is still recorded so the next request skips straight past this pair.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'only-key');
	let calls = 0;
	await assert.rejects(
		() => withProviderResilience(registry, PID, 'model-x', async () => {
			calls++;
			throw new Error(`${PID}: rate limited (HTTP 429) — try again shortly.`);
		}),
		/HTTP 429/,
	);
	assert.equal(calls, 1, 'no spare key means no retry');
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), true);
}

// A non-401/403/429 failure (e.g. a 500 or a network error) is never retried with a
// different key — rotating keys cannot fix a backend outage, and doing so anyway would
// silently double the number of requests sent during an incident.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'key-1');
	await registry.setExtraApiKeys(PID, ['key-2']);
	let calls = 0;
	await assert.rejects(
		() => withProviderResilience(registry, PID, 'model-x', async () => {
			calls++;
			throw new Error(`${PID}: request failed (HTTP 503). service unavailable`);
		}),
		/HTTP 503/,
	);
	assert.equal(calls, 1);
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), false, '503 is not a quota signal');
}

console.log('All provider-resilience assertions passed.');

Module._load = originalLoad;
