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
// transport), that hasNativeWebSocket() reflects globalThis.WebSocket's actual presence, and
// the connection lifecycle itself against a stand-in WebSocket that models a dead link.
import assert from 'node:assert/strict';
import {
	buildByeEnvelope, buildHelloEnvelope, buildPairEnvelope, buildPingEnvelope, buildRevokeEnvelope,
	hasNativeWebSocket, nextBackoffMs, RemoteSocket,
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

// 4. Liveness on a dead link. The fake's close() only *starts* a close, as a real one does when
// the peer is gone: no close event follows. Two missed pongs, or a handshake that never opens,
// must still produce a fresh connection promptly — the old code called close() and waited for
// an event that can take minutes — and a late event from the abandoned socket must not disturb
// its replacement.
{
	const sockets = [];
	class DeadLinkSocket {
		static OPEN = 1;
		constructor(url) {
			this.url = url;
			this.readyState = 0;
			this.sent = [];
			this.listeners = {};
			sockets.push(this);
		}
		addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
		emit(type, event = {}) { for (const fn of this.listeners[type] ?? []) { fn(event); } }
		open() { this.readyState = 1; this.emit('open'); }
		send(data) { this.sent.push(JSON.parse(data)); }
		close() { this.closeRequested = true; }
	}
	const realWebSocket = globalThis.WebSocket;
	globalThis.WebSocket = DeadLinkSocket;
	const realRandom = Math.random;
	Math.random = () => 0; // reconnect immediately
	const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
	try {
		const statuses = [];
		const socket = new RemoteSocket({
			relayUrl: 'wss://relay.test', publicRoomId: 'room', hostToken: 'tok',
			timing: { heartbeatMs: 10, pongTimeoutMs: 5, connectTimeoutMs: 40 },
		});
		socket.onStatusChange(status => statuses.push(status));
		socket.connect();
		sockets[0].open();
		await wait(60); // two heartbeats go unanswered
		assert.ok(sockets[0].closeRequested, 'the silent socket was told to close');
		assert.ok(sockets.length >= 2, 'and a replacement was dialed without waiting for its close event');

		// The replacement never opens: the handshake timeout abandons it too.
		const pending = sockets[1];
		await wait(70);
		assert.ok(pending.closeRequested && sockets.length >= 3, 'a hung handshake is abandoned and retried');

		// A very late close event from the first socket changes nothing.
		const current = sockets.at(-1);
		current.open();
		const before = statuses.length;
		sockets[0].emit('close', { code: 1006 });
		assert.strictEqual(socket.getStatus(), 'connected');
		assert.strictEqual(statuses.length, before);
		socket.dispose();
	} finally {
		globalThis.WebSocket = realWebSocket;
		Math.random = realRandom;
	}
}

console.log('test-remote-socket: all assertions passed');
