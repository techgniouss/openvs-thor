/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for Phase 7c — the device-token-age and idle-disconnect sweep decisions
// in src/remote/devices.ts, plus fetchDevices's request shape. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-devices.mjs
//
// src/remote/devices.ts is vscode-free, like test-remote-socket.mjs's socket.ts and
// test-remote-push.mjs's push.ts, so this imports the compiled module directly — no
// Module._load stub needed.
import assert from 'node:assert/strict';
import { fetchDevices, shouldDisconnectForIdle, shouldRevokeForTokenAge } from '../out/remote/devices.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// 1. shouldRevokeForTokenAge: exclusive boundary — exactly `deviceTokenDays` old is not yet
// revoked, only strictly older than that is, matching the plan's own
// `Date.now() - device.createdAt > deviceTokenDays * 86_400_000` phrasing.
{
	const days = 30;
	const createdAt = 0;
	assert.equal(shouldRevokeForTokenAge(createdAt, days, days * DAY_MS), false,
		'exactly at the threshold is not yet revoked (exclusive boundary)');
	assert.equal(shouldRevokeForTokenAge(createdAt, days, days * DAY_MS - 1), false,
		'just under the threshold is not revoked');
	assert.equal(shouldRevokeForTokenAge(createdAt, days, days * DAY_MS + 1), true,
		'just over the threshold is revoked');
	// A freshly created device (age 0) is never revoked, regardless of the configured threshold.
	assert.equal(shouldRevokeForTokenAge(1_000, days, 1_000), false, 'age zero is never revoked');
}

// 2. shouldDisconnectForIdle: same exclusive-boundary shape, hours instead of days.
{
	const hours = 12;
	const lastActivityAt = 0;
	assert.equal(shouldDisconnectForIdle(lastActivityAt, hours, hours * HOUR_MS), false,
		'exactly at the threshold does not disconnect (exclusive boundary)');
	assert.equal(shouldDisconnectForIdle(lastActivityAt, hours, hours * HOUR_MS - 1), false,
		'just under the threshold does not disconnect');
	assert.equal(shouldDisconnectForIdle(lastActivityAt, hours, hours * HOUR_MS + 1), true,
		'just over the threshold disconnects');
	// Activity recorded this instant never triggers a disconnect, regardless of threshold.
	assert.equal(shouldDisconnectForIdle(5_000, hours, 5_000), false, 'zero idle time never disconnects');
}

// 3. fetchDevices: hits `${relayUrl}/api/devices?room=<publicRoomId>` with an `Authorization:
// Bearer <hostToken>` header — the same room/token convention `socket.ts`'s `RemoteSocket`
// already uses to dial `/ws/host` (query param for the room, header for the token) — and
// parses `{devices: [...]}`, dropping anything that isn't a well-formed DeviceInfo.
{
	const realFetch = globalThis.fetch;
	let seenUrl;
	let seenHeaders;
	globalThis.fetch = async (url, init) => {
		seenUrl = url;
		seenHeaders = init?.headers;
		return new Response(JSON.stringify({
			devices: [
				{ id: 'd1', name: 'Pixel 8', createdAt: 1000, lastSeenAt: 2000, revokedAt: null },
				{ id: 'd2', name: 'malformed — missing name' }, // dropped: not a well-formed DeviceInfo
				'not even an object', // dropped
			],
		}), { status: 200, headers: { 'Content-Type': 'application/json' } });
	};
	try {
		const devices = await fetchDevices('https://relay.example/', 'ROOMROOMROOM', 'tok-abc');
		assert.equal(seenUrl, 'https://relay.example/api/devices?room=ROOMROOMROOM',
			'a trailing slash on relayUrl is trimmed, and the room id is a query param');
		assert.equal(seenHeaders.Authorization, 'Bearer tok-abc', 'the host token is a bearer header, not a query param');
		assert.deepStrictEqual(devices, [{ id: 'd1', name: 'Pixel 8', createdAt: 1000, lastSeenAt: 2000, revokedAt: null }],
			'malformed entries are dropped, not thrown on');
	} finally {
		globalThis.fetch = realFetch;
	}
}

// 4. fetchDevices throws on a non-2xx response, so a caller (RemoteService's sweep) can tell
// "the relay said no" from "there are no devices".
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response('host token mismatch', { status: 403 });
	try {
		await assert.rejects(() => fetchDevices('https://relay.example', 'ROOM', 'bad-token'), /403/);
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log('test-remote-devices: all assertions passed');
