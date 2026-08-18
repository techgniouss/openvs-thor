/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the pure, transport-free pieces of src/remote/socket.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-socket.mjs
//
// This task cannot practically test a real socket: no relay is deployed in this environment,
// and per the "remote control" plan's Phase 4 staging none should be stood up here either. What
// IS testable without a live connection: the backoff/jitter calculation (extracted as a pure
// function), the envelope-building for hello/ping/pair/bye (pure functions independent of the
// transport), and that hasNativeWebSocket() reflects globalThis.WebSocket's actual presence.
import assert from 'node:assert/strict';
import {
	buildByeEnvelope, buildHelloEnvelope, buildPairEnvelope, buildPingEnvelope, buildRevokeEnvelope,
	hasNativeWebSocket, nextBackoffMs,
} from '../out/remote/socket.js';

// 1. hasNativeWebSocket() reflects globalThis.WebSocket's actual presence. Trivially true in
// this Node test environment (Node 24 exposes a native WebSocket); the `false` case can't be
// exercised here without deleting a global out from under whatever else uses it in-process,
// which is out of scope for a unit test — it would have to be checked by hand or in a
// dedicated sandboxed process instead.
{
	assert.strictEqual(typeof globalThis.WebSocket, 'function', 'sanity: this Node runtime has a native WebSocket');
	assert.strictEqual(hasNativeWebSocket(), true);
}

// 2. nextBackoffMs: full jitter, capped at 30s, growing with attempt number.
{
	// rng pinned to 1 (the top of the jitter range) isolates the cap calculation itself.
	assert.strictEqual(nextBackoffMs(0, () => 1), 1_000, 'attempt 0: base 1s, no growth yet');
	assert.strictEqual(nextBackoffMs(1, () => 1), 2_000, 'attempt 1: doubles');
	assert.strictEqual(nextBackoffMs(2, () => 1), 4_000, 'attempt 2: doubles again');
	assert.strictEqual(nextBackoffMs(10, () => 1), 30_000, 'clamped at the 30s cap well before attempt 10');
	// rng pinned to 0 is always "no wait", regardless of the cap — full jitter's whole point.
	assert.strictEqual(nextBackoffMs(5, () => 0), 0);
	// A negative attempt is treated as attempt 0, not an exponent that shrinks the base.
	assert.strictEqual(nextBackoffMs(-3, () => 1), 1_000);
}

// 3. Envelope builders: exact shape, `seq` threaded through, `v: 1` always.
{
	assert.deepStrictEqual(buildHelloEnvelope(1, 'tok123'), { v: 1, t: 'c', seq: 1, p: { c: 'hello', role: 'host', roomToken: 'tok123' } });
	assert.deepStrictEqual(buildPingEnvelope(2), { v: 1, t: 'c', seq: 2, p: { c: 'ping' } });
	assert.deepStrictEqual(buildPairEnvelope(3), { v: 1, t: 'c', seq: 3, p: { c: 'pair' } });
	assert.deepStrictEqual(buildRevokeEnvelope(4, 'device-9'), { v: 1, t: 'c', seq: 4, p: { c: 'revoke', deviceId: 'device-9' } });
	assert.deepStrictEqual(buildByeEnvelope(5), { v: 1, t: 'c', seq: 5, p: { c: 'bye' } });
	assert.deepStrictEqual(buildByeEnvelope(6, 'dispose'), { v: 1, t: 'c', seq: 6, p: { c: 'bye', reason: 'dispose' } });
}

console.log('test-remote-socket: all assertions passed');
