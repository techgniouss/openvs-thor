/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/agent/contextWindow.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-context-window.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/agent/contextWindow.js', import.meta.url));

// Known families resolve to their real windows.
assert.strictEqual(m.contextWindowFor('claude-fable-5'), 200_000);
assert.strictEqual(m.contextWindowFor('claude-sonnet-4-5-20250929'), 200_000);
assert.strictEqual(m.contextWindowFor('gpt-4o-mini'), 128_000);
assert.strictEqual(m.contextWindowFor('gpt-5'), 400_000);
assert.strictEqual(m.contextWindowFor('deepseek-ai/DeepSeek-R1'), 64_000);
assert.strictEqual(m.contextWindowFor('moonshot-v1-128k'), 128_000);
assert.strictEqual(m.contextWindowFor('qwen-max'), 128_000);
assert.strictEqual(m.contextWindowFor('meta/llama-3.1-70b-instruct'), 128_000);

// Unknown models get the conservative default.
assert.strictEqual(m.contextWindowFor('totally-unknown-model'), 32_000);
assert.strictEqual(m.contextWindowFor(''), 32_000);

// Budget: 80% of window minus response headroom, floored at the minimum.
assert.strictEqual(m.contextBudgetFor('claude-fable-5', 8_192), Math.floor(200_000 * 0.8) - 8_192);
assert.strictEqual(m.contextBudgetFor('totally-unknown-model', 8_192), Math.floor(32_000 * 0.8) - 8_192);
// A user override wins outright.
assert.strictEqual(m.contextBudgetFor('claude-fable-5', 8_192, 50_000), 50_000);
// Headroom can never push the budget below the floor.
assert.strictEqual(m.contextBudgetFor('totally-unknown-model', 30_000), 8_000);

// A window reported by the provider's catalog is authoritative and beats the name
// patterns — including for models the table has never heard of, which otherwise get the
// 32k default and compact themselves to death a few file reads into a run.
{
	const catalog = [
		{ id: 'vendor/brand-new-model', contextLength: 262_144 },
		{ id: 'anthropic/claude-sonnet-5', contextLength: 1_000_000 },
		{ id: 'vendor/no-window-reported' },
	];
	assert.strictEqual(m.contextWindowFor('vendor/brand-new-model', catalog), 262_144,
		'the catalog wins over the 32k default');
	assert.strictEqual(m.contextWindowFor('anthropic/claude-sonnet-5', catalog), 1_000_000,
		'the catalog wins over a name-pattern match too');
	assert.strictEqual(m.contextWindowFor('vendor/no-window-reported', catalog), 32_000,
		'a catalog entry without a window falls back to the patterns');
	assert.strictEqual(m.contextWindowFor('not-in-catalog', catalog), 32_000,
		'a model missing from the catalog falls back to the patterns');
	assert.strictEqual(m.contextBudgetFor('vendor/brand-new-model', 8_192, 0, catalog),
		Math.floor(262_144 * 0.8) - 8_192, 'the budget follows the catalog window');
}

// Models added to the pattern table so they stop landing on the 32k default.
assert.strictEqual(m.contextWindowFor('x-ai/grok-4'), 128_000);
assert.strictEqual(m.contextWindowFor('z-ai/glm-4.6'), 128_000);
assert.strictEqual(m.contextWindowFor('minimax/minimax-m2'), 192_000);
assert.strictEqual(m.contextWindowFor('openai/gpt-oss-120b'), 128_000);
assert.strictEqual(m.contextWindowFor('mistralai/devstral-medium'), 128_000);
// Mistral's own API offers `-latest` aliases, so the family patterns can't be keyed to a
// version number; `groq/compound` carries no model family in its id at all.
assert.strictEqual(m.contextWindowFor('mistral-medium-latest'), 128_000);
assert.strictEqual(m.contextWindowFor('mistral-small-latest'), 128_000);
assert.strictEqual(m.contextWindowFor('@cf/mistralai/mistral-small-3.1-24b-instruct'), 128_000);
assert.strictEqual(m.contextWindowFor('groq/compound'), 128_000);
// Still 32k: the older open-weights checkpoints genuinely have a small window, and widening
// the family patterns above must not sweep them up.
assert.strictEqual(m.contextWindowFor('open-mistral-7b'), 32_000);
// Two families whose newest release broke the pattern that matched the previous ones, both
// caught by test-model-axes.mjs landing them on the 32k default.
assert.strictEqual(m.contextWindowFor('z-ai/glm-5.2'), 200_000);
assert.strictEqual(m.contextWindowFor('z-ai/glm-4.6'), 128_000, 'GLM-5 must not shadow GLM-4');
assert.strictEqual(m.contextWindowFor('@cf/google/gemma-4-26b-a4b-it'), 256_000);
assert.strictEqual(m.contextWindowFor('google/gemma-3-12b-it'), 8_000, 'Gemma 4 must not shadow Gemma 3');

console.log('test-context-window: all assertions passed');
