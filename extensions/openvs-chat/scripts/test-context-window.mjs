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

console.log('test-context-window: all assertions passed');
