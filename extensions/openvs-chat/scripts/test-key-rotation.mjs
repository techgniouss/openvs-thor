/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/keyRotation.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-key-rotation.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/keyRotation.js', import.meta.url));

// A single-key provider never "rotates" — there is nothing to rotate to.
{
	const r = new m.KeyRotator();
	assert.equal(r.activeIndex('p', ['k1']), 0);
	assert.equal(r.rotate('p', ['k1']), false, 'single key: rotate is a no-op');
	assert.equal(r.activeIndex('p', ['k1']), 0);
}

// Two keys: rotate advances to the other one and stays there.
{
	const r = new m.KeyRotator();
	assert.equal(r.activeIndex('p', ['k1', 'k2']), 0);
	assert.equal(r.rotate('p', ['k1', 'k2']), true);
	assert.equal(r.activeIndex('p', ['k1', 'k2']), 1);
	// Rotating again marks k2 errored too — both are now errored, so the errored set
	// resets and rotation restarts from the first non-current key: with a 2-key pool
	// this cycles 0 -> 1 -> 0 -> 1 forever, which is correct behaviour.
	assert.equal(r.rotate('p', ['k1', 'k2']), true);
	assert.equal(r.activeIndex('p', ['k1', 'k2']), 0);
}

// Three keys: rotating through all of them resets the errored set and cycles rather
// than getting stuck once every key has failed once.
{
	const r = new m.KeyRotator();
	const keys = ['a', 'b', 'c'];
	assert.equal(r.activeIndex('p', keys), 0);
	r.rotate('p', keys); // a errored, active -> b
	assert.equal(r.activeIndex('p', keys), 1);
	r.rotate('p', keys); // b errored, active -> c
	assert.equal(r.activeIndex('p', keys), 2);
	r.rotate('p', keys); // c errored -> all 3 errored -> reset -> active -> a (first non-current)
	assert.equal(r.activeIndex('p', keys), 0);
}

// `clear` drops the errored mark so a key that recovers is trusted again immediately.
{
	const r = new m.KeyRotator();
	r.rotate('p', ['a', 'b']);
	assert.equal(r.activeIndex('p', ['a', 'b']), 1);
	r.clear('p');
	// clear does not change WHICH key is active, only forgets the "errored" history —
	// a later 429 on the current key must be able to mark it errored again.
	assert.equal(r.activeIndex('p', ['a', 'b']), 1);
}

// State is independent per provider id.
{
	const r = new m.KeyRotator();
	r.rotate('openrouter', ['x', 'y']);
	assert.equal(r.activeIndex('openrouter', ['x', 'y']), 1);
	assert.equal(r.activeIndex('mistral', ['x', 'y']), 0);
}

// activeIndex clamps to the current key list length — a key removed from settings
// after it became active must not crash or return an out-of-range index.
{
	const r = new m.KeyRotator();
	r.rotate('p', ['a', 'b', 'c']); // active -> index 1
	assert.equal(r.activeIndex('p', ['a', 'b', 'c']), 1);
	assert.equal(r.activeIndex('p', ['only-one-left']), 0);
}

console.log('All keyRotation assertions passed.');
