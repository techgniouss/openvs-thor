/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the host-side prompt registry in src/session/prompts.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-prompt-registry.mjs
import assert from 'node:assert/strict';
import { PromptRegistry } from '../out/session/prompts.js';

const request = { type: 'approvalRequest', title: 'Overwrite src/foo.ts?' };

// 1. Register/resolve round trip: the id is minted from session/run/sequence, and resolving
// it delivers the reply to exactly the resolve callback that was registered.
{
	const registry = new PromptRegistry();
	let resolved;
	const id = registry.register('s1', 'r1', request, reply => { resolved = reply; }, () => { assert.fail('reject called'); });
	assert.strictEqual(id, 's1:r1:1');
	assert.ok(registry.resolve(id, { approved: true }));
	assert.deepStrictEqual(resolved, { approved: true });
	assert.strictEqual(registry.get(id), undefined, 'settled prompts are forgotten');
}

// 2. Resolving a nonexistent id, or one already resolved, returns false and does not call
// either callback again.
{
	const registry = new PromptRegistry();
	assert.strictEqual(registry.resolve('nope', {}), false, 'never registered');

	let resolveCount = 0;
	const id = registry.register('s1', 'r1', request, () => { resolveCount++; }, () => { assert.fail('reject called'); });
	assert.ok(registry.resolve(id, {}));
	assert.strictEqual(registry.resolve(id, {}), false, 'already answered once');
	assert.strictEqual(resolveCount, 1, 'the resolve callback only ran once');
}

// 3. `cancel` rejects instead of resolving, and reports whether the prompt was found.
{
	const registry = new PromptRegistry();
	let rejectedWith;
	const id = registry.register('s1', 'r1', request, () => { assert.fail('resolve called'); }, err => { rejectedWith = err; });
	const err = new Error('aborted');
	assert.ok(registry.cancel(id, err));
	assert.strictEqual(rejectedWith, err);
	assert.strictEqual(registry.cancel(id, err), false, 'already cancelled');
	assert.strictEqual(registry.cancel('nope', err), false, 'never registered');
}

// 4. `allPending` reflects exactly the currently-outstanding prompts, in registration order,
// and omits anything already settled.
{
	const registry = new PromptRegistry();
	assert.deepStrictEqual(registry.allPending(), []);
	const id1 = registry.register('s1', 'r1', { ...request, title: 'first' }, () => { }, () => { });
	const id2 = registry.register('s2', 'r2', { ...request, title: 'second' }, () => { }, () => { });
	assert.deepStrictEqual(registry.allPending().map(p => p.id), [id1, id2]);
	registry.resolve(id1, {});
	assert.deepStrictEqual(registry.allPending().map(p => p.id), [id2]);
	assert.strictEqual(registry.allPending()[0].sessionId, 's2');
	assert.strictEqual(registry.allPending()[0].request.title, 'second');
}

// 5. `settleAllUnanswered` resolves every pending prompt with an empty reply and clears the
// registry, without touching an already-settled one.
{
	const registry = new PromptRegistry();
	const replies = [];
	registry.register('s1', 'r1', request, reply => replies.push(reply), () => { });
	const id2 = registry.register('s2', 'r2', request, reply => replies.push(reply), () => { });
	registry.resolve(id2, { answer: 'already answered' });
	registry.settleAllUnanswered();
	assert.deepStrictEqual(replies, [{ answer: 'already answered' }, {}]);
	assert.deepStrictEqual(registry.allPending(), []);
	// Idempotent: nothing left to settle a second time.
	registry.settleAllUnanswered();
	assert.deepStrictEqual(replies, [{ answer: 'already answered' }, {}]);
}

console.log('test-prompt-registry: all assertions passed');
