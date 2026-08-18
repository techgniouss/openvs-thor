/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/remote/pairing.ts's revokeDevice — the ack-based revoke confirmation. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-pairing.mjs
//
// No real RemoteSocket/relay involved (same "no relay stood up here" stance as
// test-remote-socket.mjs's own doc): revokeDevice only ever calls a socket's `onMessage` and
// `sendControl`, so a plain fake implementing exactly those two methods stands in — JS doesn't
// check `RemoteSocket`'s nominal type at runtime, only that the shape is there.
import assert from 'node:assert/strict';
import { revokeDevice } from '../out/remote/pairing.js';

/** A minimal fake RemoteSocket: records every `sendControl` call and lets the test feed envelopes into `onMessage` subscribers on demand. */
function fakeSocket() {
	const handlers = new Set();
	const sent = [];
	return {
		sendControl(frame) { sent.push(frame); },
		onMessage(handler) {
			handlers.add(handler);
			return { dispose: () => handlers.delete(handler) };
		},
		/** Test-only helper: delivers `envelope` to every still-subscribed handler, as `RemoteSocket.handleRawMessage` would. */
		feed(envelope) { for (const h of [...handlers]) { h(envelope); } },
		sent,
	};
}

// 1. Sends exactly `{c: 'revoke', deviceId}` and resolves once a matching `revoked` ack arrives.
{
	const socket = fakeSocket();
	const done = revokeDevice(socket, 'device-1');
	assert.deepStrictEqual(socket.sent, [{ c: 'revoke', deviceId: 'device-1' }], 'revokeDevice sends the revoke control frame immediately');

	let resolved = false;
	done.then(() => { resolved = true; });
	await Promise.resolve(); // let the fresh .then() callback's microtask queue settle
	assert.strictEqual(resolved, false, 'not resolved before any ack arrives');

	socket.feed({ v: 1, t: 'c', seq: 1, p: { c: 'revoked', deviceId: 'device-1' } });
	await done;
	assert.strictEqual(resolved, true, 'resolves once the matching revoked ack arrives');
}

// 2. An ack for a *different* device id (another revoke racing on the same socket) must not
// resolve this call — each revokeDevice() call only waits for its own device's ack.
{
	const socket = fakeSocket();
	const done = revokeDevice(socket, 'device-a');
	let resolved = false;
	done.then(() => { resolved = true; });

	socket.feed({ v: 1, t: 'c', seq: 1, p: { c: 'revoked', deviceId: 'device-b' } });
	await Promise.resolve();
	await Promise.resolve();
	assert.strictEqual(resolved, false, 'a revoked ack for a different deviceId is ignored');

	socket.feed({ v: 1, t: 'c', seq: 2, p: { c: 'revoked', deviceId: 'device-a' } });
	await done;
	assert.strictEqual(resolved, true, 'resolves once this call\'s own deviceId is acked');
}

// 3. Non-'revoked' traffic on the same socket (any other control or app message) is ignored,
// not mistaken for the ack.
{
	const socket = fakeSocket();
	const done = revokeDevice(socket, 'device-x');
	let resolved = false;
	done.then(() => { resolved = true; });

	socket.feed({ v: 1, t: 'c', seq: 1, p: { c: 'pong' } });
	socket.feed({ v: 1, t: 'm', seq: 2, p: { type: 'sessions', sessions: [] } });
	await Promise.resolve();
	await Promise.resolve();
	assert.strictEqual(resolved, false, 'unrelated control/app traffic does not resolve the revoke');

	socket.feed({ v: 1, t: 'c', seq: 3, p: { c: 'revoked', deviceId: 'device-x' } });
	await done;
	assert.strictEqual(resolved, true);
}

// 4. The message subscription is disposed once resolved — a late, duplicate `revoked` for the
// same device (e.g. the relay retrying its own send) must not throw or double-resolve.
{
	const socket = fakeSocket();
	const done = revokeDevice(socket, 'device-dup');
	socket.feed({ v: 1, t: 'c', seq: 1, p: { c: 'revoked', deviceId: 'device-dup' } });
	await done;
	assert.doesNotThrow(() => {
		socket.feed({ v: 1, t: 'c', seq: 2, p: { c: 'revoked', deviceId: 'device-dup' } });
	}, 'a duplicate ack after resolution is a harmless no-op, not a crash');
}

console.log('test-remote-pairing: all assertions passed');
