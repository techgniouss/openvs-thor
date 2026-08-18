// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
// Tests the pure routing/takeover decisions in src/room.ts, plus `WorkspaceRoom.webSocketMessage`
// itself against a fake `DurableObjectState`.
//
// `WorkspaceRoom` deliberately does not extend the ambient `DurableObject` base class from
// `cloudflare:workers` (see room.ts's own top-of-file doc), so it has no *value*-level dependency
// on a module that only exists inside the Workers runtime — everything it touches at the type
// level (`DurableObjectState`, `WebSocket`, `Request`, …) is erased by Node's built-in TypeScript
// stripping. The one real runtime global it reaches for, `WebSocketRequestResponsePair`, is
// feature-detected in the constructor — this file defines a minimal stand-in for it before
// importing room.ts, the same way the extension's tests stub `vscode` via `Module._load`.
//
// Deliberately NOT exercised here: `fetch()` (the HTTP upgrade path, which needs a real/fake
// `WebSocketPair` and touches pairing/token HTTP handlers already covered by test-pairing.mjs and
// test-tokens.mjs) and the SQLite-backed TOFU host-claim flow. This file is scoped to what's
// genuinely unit-testable without reproducing the Workers runtime: the routing decision, the
// host-takeover decision, and the heartbeat frame shapes — plus `webSocketMessage`'s dispatch of
// both, driven against sockets registered directly (as if already connected) via a fake
// `DurableObjectState` implementing exactly the surface room.ts's message path calls:
// `acceptWebSocket`, `getWebSockets`, `getTags`, `storage.sql.exec`, `setWebSocketAutoResponse`,
// `blockConcurrencyWhile`.
import assert from 'node:assert/strict';

globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
	constructor(request, response) {
		this.request = request;
		this.response = response;
	}
};

const {
	HOST_TAG, HOST_TAKEOVER_CLOSE_CODE, HEARTBEAT_PING_JSON, HEARTBEAT_PONG_JSON,
	routeAppMessage, socketsToDisplaceForNewHost, clientTag, isHostTag, isClientTag, WorkspaceRoom,
} = await import('../src/room.ts');
const { isEnvelope, isControlFrame } = await import('../src/protocol.ts');
const { mintToken, hashForStorage } = await import('../src/tokens.ts');

// ---- Fakes -------------------------------------------------------------------------------------

class FakeWebSocket {
	constructor(label) {
		this.label = label;
		this.sent = [];
		this.closed = undefined;
		this._attachment = null;
	}
	send(message) { this.sent.push(message); }
	close(code, reason) { this.closed = { code, reason }; }
	serializeAttachment(value) { this._attachment = value; }
	deserializeAttachment() { return this._attachment; }
}

/**
 * Stand-in for `SqlStorage`. `applyMigrations`' `CREATE TABLE` statements are no-ops (nothing
 * asserts on those), but every other statement `room.ts` actually issues is pattern-matched
 * against a small in-memory table set — enough to drive `handlePending`/`raisePush`'s SQL for
 * real, including the device-token auth path, without pulling in a real SQLite engine. Matched
 * by statement shape (table + verb), not full parsing — the fixed, small set of queries `room.ts`
 * issues makes that tractable; a query this file doesn't recognize returns an empty result rather
 * than throwing, matching the original always-empty fake's behavior for anything unexercised.
 */
function fakeSql() {
	const device = [];
	const pairing = [];
	const push = [];
	const meta = [];
	const pending = [];
	let nextPendingId = 1;

	function result(rows) {
		return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: function* () { yield* rows; } };
	}

	function exec(sql, ...params) {
		const s = sql.trim();
		if (/^CREATE TABLE/i.test(s)) {
			return result([]);
		}
		if (/^SELECT v FROM meta WHERE k = \?/.test(s)) {
			const [k] = params;
			return result(meta.filter(r => r.k === k));
		}
		if (/^INSERT INTO meta/.test(s)) {
			const [k, v] = params;
			meta.push({ k, v });
			return result([]);
		}
		if (/^SELECT codeHash, expiresAt, usedAt FROM pairing WHERE codeHash = \?/.test(s)) {
			const [codeHash] = params;
			return result(pairing.filter(r => r.codeHash === codeHash));
		}
		if (/^INSERT OR REPLACE INTO pairing/.test(s)) {
			const [codeHash, expiresAt] = params;
			const i = pairing.findIndex(r => r.codeHash === codeHash);
			if (i !== -1) { pairing.splice(i, 1); }
			pairing.push({ codeHash, expiresAt, usedAt: null });
			return result([]);
		}
		if (/^UPDATE pairing SET usedAt/.test(s)) {
			const [usedAt, codeHash] = params;
			const row = pairing.find(r => r.codeHash === codeHash);
			if (row) { row.usedAt = usedAt; }
			return result([]);
		}
		if (/^DELETE FROM pairing WHERE expiresAt/.test(s)) {
			const [now] = params;
			for (let i = pairing.length - 1; i >= 0; i--) {
				if (pairing[i].expiresAt < now || pairing[i].usedAt !== null) { pairing.splice(i, 1); }
			}
			return result([]);
		}
		if (/^INSERT INTO device/.test(s)) {
			// room.ts's own INSERT hardcodes `lastSeenAt` and `revokedAt` as NULL literals in the
			// SQL text (see handlePairClaim's doc), so it binds only 5 params; the direct raw-SQL
			// test below (test 8's device fixture) still binds all 6 positionally. Both are
			// supported here — `lastSeenAt` simply falls back to `null` when room.ts's 5-param form
			// is used.
			const [id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt] = params;
			device.push({ id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt: lastSeenAt ?? null, revokedAt: null });
			return result([]);
		}
		if (/^SELECT tokenHash FROM device WHERE id = \?/.test(s)) {
			const [id] = params;
			return result(device.filter(r => r.id === id).map(r => ({ tokenHash: r.tokenHash })));
		}
		if (/^SELECT revokedAt FROM device WHERE id = \?/.test(s)) {
			const [id] = params;
			return result(device.filter(r => r.id === id).map(r => ({ revokedAt: r.revokedAt })));
		}
		if (/^SELECT name, lastSeenAt FROM device WHERE id = \?/.test(s)) {
			const [id] = params;
			return result(device.filter(r => r.id === id).map(r => ({ name: r.name, lastSeenAt: r.lastSeenAt })));
		}
		if (/^SELECT id, name, createdAt, lastSeenAt, revokedAt FROM device ORDER BY createdAt DESC/.test(s)) {
			const sorted = [...device].sort((a, b) => b.createdAt - a.createdAt);
			return result(sorted.map(r => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, revokedAt: r.revokedAt })));
		}
		if (/^UPDATE device SET lastSeenAt/.test(s)) {
			const [lastSeenAt, id] = params;
			const row = device.find(r => r.id === id);
			if (row) { row.lastSeenAt = lastSeenAt; }
			return result([]);
		}
		if (/^UPDATE device SET revokedAt/.test(s)) {
			const [revokedAt, id] = params;
			const row = device.find(r => r.id === id);
			if (row) { row.revokedAt = revokedAt; }
			return result([]);
		}
		if (/^INSERT INTO push/.test(s)) {
			const [deviceId, endpoint, p256dh, auth, createdAt] = params;
			push.push({ deviceId, endpoint, p256dh, auth, createdAt, failureCount: 0 });
			return result([]);
		}
		if (/^SELECT deviceId, endpoint, p256dh, auth FROM push/.test(s)) {
			return result(push.map(r => ({ deviceId: r.deviceId, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth })));
		}
		if (/^UPDATE push SET failureCount/.test(s)) {
			const [deviceId, endpoint] = params;
			const row = push.find(r => r.deviceId === deviceId && r.endpoint === endpoint);
			if (row) { row.failureCount++; }
			return result([]);
		}
		if (/^DELETE FROM push WHERE deviceId = \?/.test(s)) {
			const [deviceId] = params;
			for (let i = push.length - 1; i >= 0; i--) {
				if (push[i].deviceId === deviceId) { push.splice(i, 1); }
			}
			return result([]);
		}
		if (/^DELETE FROM push WHERE failureCount/.test(s)) {
			const [threshold] = params;
			for (let i = push.length - 1; i >= 0; i--) {
				if (push[i].failureCount >= threshold) { push.splice(i, 1); }
			}
			return result([]);
		}
		if (/^INSERT INTO pending/.test(s)) {
			const [title, body, tag, sessionId, createdAt] = params;
			pending.push({ id: nextPendingId++, title, body, tag, sessionId, createdAt });
			return result([]);
		}
		if (/^DELETE FROM pending/.test(s)) {
			const [limit] = params;
			const keep = new Set([...pending].sort((a, b) => b.id - a.id).slice(0, limit).map(r => r.id));
			for (let i = pending.length - 1; i >= 0; i--) {
				if (!keep.has(pending[i].id)) { pending.splice(i, 1); }
			}
			return result([]);
		}
		if (/^SELECT title, body, tag, sessionId FROM pending/.test(s)) {
			const sorted = [...pending].sort((a, b) => b.id - a.id).slice(0, 1);
			return result(sorted.map(r => ({ title: r.title, body: r.body, tag: r.tag, sessionId: r.sessionId })));
		}
		return result([]);
	}

	return { exec };
}

class FakeDurableObjectState {
	constructor() {
		this.entries = []; // { ws, tags }
		this.autoResponsePair = undefined;
		this.storage = { sql: fakeSql(), getAlarm: async () => null, setAlarm: async () => {} };
	}
	acceptWebSocket(ws, tags) {
		const entry = { ws, tags: tags || [] };
		this.entries.push(entry);
		const originalClose = ws.close.bind(ws);
		// Mirrors the real runtime: once a hibernatable socket is closed it stops appearing in
		// getWebSockets(). Without this, a "closed" socket the test just displaced would still
		// show up as a relay target one line later.
		ws.close = (code, reason) => {
			originalClose(code, reason);
			const i = this.entries.indexOf(entry);
			if (i !== -1) { this.entries.splice(i, 1); }
		};
	}
	getWebSockets(tag) {
		const matching = tag === undefined ? this.entries : this.entries.filter(e => e.tags.includes(tag));
		return matching.map(e => e.ws);
	}
	getTags(ws) {
		const entry = this.entries.find(e => e.ws === ws);
		return entry ? entry.tags : [];
	}
	setWebSocketAutoResponse(pair) { this.autoResponsePair = pair; }
	async blockConcurrencyWhile(cb) { return cb(); }
}

const FAKE_ENV = { RELAY_PEPPER: 'x', VAPID_PUBLIC: '', VAPID_PRIVATE: '', VAPID_SUBJECT: '' };

// ---- 1. routeAppMessage: pure fan-out decision --------------------------------------------------

{
	const allTags = [HOST_TAG, clientTag('a'), clientTag('b'), clientTag('c')];
	const fromHost = routeAppMessage(HOST_TAG, allTags);
	assert.deepEqual([...fromHost].sort(), [clientTag('a'), clientTag('b'), clientTag('c')].sort(),
		'a host frame fans out to every connected client');
	assert.ok(!fromHost.includes(HOST_TAG), 'a host frame is never routed back to the host');

	const fromClient = routeAppMessage(clientTag('a'), allTags);
	assert.deepEqual(fromClient, [HOST_TAG], "a client's frame goes to the host only");
	assert.ok(!fromClient.includes(clientTag('a')), "a client's frame is never routed back to itself");

	assert.deepEqual(routeAppMessage(clientTag('a'), [clientTag('a'), clientTag('b')]), [],
		'a client frame with no host connected has nowhere to go — dropped, not broadcast to other clients');
}

// ---- 2. socketsToDisplaceForNewHost: pure takeover decision ------------------------------------

{
	const entries = [
		{ tag: HOST_TAG, socket: 'old-host' },
		{ tag: clientTag('a'), socket: 'client-a' },
		{ tag: clientTag('b'), socket: 'client-b' },
	];
	assert.deepEqual(socketsToDisplaceForNewHost(entries), ['old-host'], 'only the existing host-tagged socket is displaced');
	assert.deepEqual(socketsToDisplaceForNewHost([{ tag: clientTag('a'), socket: 'client-a' }]), [],
		'no host connected yet means nothing to displace');
}

// ---- 3. Tag predicates ---------------------------------------------------------------------------

{
	assert.equal(isHostTag(HOST_TAG), true);
	assert.equal(isHostTag(clientTag('a')), false);
	assert.equal(isClientTag(clientTag('device-1')), true);
	assert.equal(isClientTag(HOST_TAG), false);
}

// ---- 4. Heartbeat frame shapes ------------------------------------------------------------------

{
	const ping = JSON.parse(HEARTBEAT_PING_JSON);
	const pong = JSON.parse(HEARTBEAT_PONG_JSON);
	assert.ok(isEnvelope(ping) && isEnvelope(pong), 'both heartbeat frames are well-formed envelopes');
	assert.equal(ping.t, 'c');
	assert.equal(pong.t, 'c');
	assert.ok(isControlFrame(ping.p) && ping.p.c === 'ping', 'the ping frame carries a ping control frame');
	assert.ok(isControlFrame(pong.p) && pong.p.c === 'pong', 'the pong frame carries a pong control frame');
}

// ---- 5. webSocketMessage: a host's t:'m' frame relays to every client, never back to the host ---

{
	// Build the fake state ourselves (WorkspaceRoom doesn't expose its own), register sockets on
	// it directly — "given N registered fake sockets with tags" — then hand it to the class.
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);
	const host = new FakeWebSocket('host');
	const clientA = new FakeWebSocket('client-a');
	const clientB = new FakeWebSocket('client-b');
	state.acceptWebSocket(host, [HOST_TAG]);
	state.acceptWebSocket(clientA, [clientTag('device-a')]);
	state.acceptWebSocket(clientB, [clientTag('device-b')]);

	const appFrame = JSON.stringify({ v: 1, t: 'm', seq: 1, p: { type: 'token', sessionId: 's1', delta: 'hi' } });
	await room.webSocketMessage(host, appFrame);

	assert.deepEqual(clientA.sent, [appFrame], "the host's app message reaches client A verbatim");
	assert.deepEqual(clientB.sent, [appFrame], "the host's app message reaches client B verbatim");
	assert.deepEqual(host.sent, [], 'the host never receives its own broadcast back');

	// And the reverse direction: a client's app message goes to the host only, not to the other client.
	const clientFrame = JSON.stringify({ v: 1, t: 'm', seq: 1, p: { type: 'send', sessionId: 's1', text: 'go' } });
	await room.webSocketMessage(clientA, clientFrame);
	assert.deepEqual(host.sent, [clientFrame], "client A's message reaches the host");
	assert.deepEqual(clientB.sent, [appFrame], "client B does not receive client A's message (still just the earlier broadcast)");
}

// ---- 6. webSocketMessage: a hello{role:'host'} frame displaces the existing host with 4003 -------

{
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);
	const oldHost = new FakeWebSocket('old-host');
	const newHost = new FakeWebSocket('new-host');
	// Both sockets are pre-registered as already-connected — "given N registered fake sockets
	// with tags" — the second is tagged host too, simulating a fresh /ws/host upgrade that has
	// not yet announced itself; the hello frame is what triggers the takeover in this test.
	state.acceptWebSocket(oldHost, [HOST_TAG]);
	state.acceptWebSocket(newHost, [HOST_TAG]);

	const hello = JSON.stringify({ v: 1, t: 'c', seq: 1, p: { c: 'hello', role: 'host' } });
	await room.webSocketMessage(newHost, hello);

	assert.deepEqual(oldHost.closed, { code: HOST_TAKEOVER_CLOSE_CODE, reason: 'replaced by a new host connection' },
		'the existing host socket is closed with the takeover code');
	assert.equal(newHost.closed, undefined, 'the new host socket itself is left alone');
	assert.deepEqual(state.getWebSockets(HOST_TAG), [newHost], 'only the new host remains tagged host afterward');
}

// ---- 7. webSocketMessage: malformed/unknown frames are ignored, not thrown --------------------

{
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);
	const host = new FakeWebSocket('host');
	state.acceptWebSocket(host, [HOST_TAG]);
	await room.webSocketMessage(host, 'not json');
	await room.webSocketMessage(host, JSON.stringify({ v: 2, t: 'm', seq: 1 }));
	await room.webSocketMessage(host, JSON.stringify({ v: 1, t: 'c', seq: 1, p: { c: 'not-a-real-verb' } }));
	await room.webSocketMessage(host, new ArrayBuffer(4));
	assert.deepEqual(host.sent, [], 'none of the above produce any outbound traffic or a thrown error');
}

// ---- 8. `push` control frame -> recordPending -> /api/pending, gated by device-token auth -------

{
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);
	const host = new FakeWebSocket('host');
	state.acceptWebSocket(host, [HOST_TAG]);

	const roomId = 'room1';
	const deviceId = 'device-1';
	const issuedAt = Date.now();
	const token = await mintToken(deviceId, roomId, issuedAt, FAKE_ENV.RELAY_PEPPER);
	const tokenHash = await hashForStorage(`${roomId}|${token}`, FAKE_ENV.RELAY_PEPPER);
	// Registers the device directly against the fake's `device` table — the same shape
	// `handlePairClaim` would have inserted, without going through the whole pairing-code flow.
	state.storage.sql.exec(
		'INSERT INTO device (id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)',
		deviceId, 'Test device', tokenHash, 'null', issuedAt, issuedAt,
	);

	const pendingUrl = `https://relay.example/api/pending?room=${encodeURIComponent(roomId)}`;

	const before = await room.fetch(new Request(pendingUrl, { headers: { Authorization: `Bearer ${token}` } }));
	assert.equal(before.status, 200);
	assert.deepEqual(await before.json(), { pending: [] }, 'nothing pending before any push control frame arrives');

	const pushFrame = JSON.stringify({
		v: 1, t: 'c', seq: 1,
		p: { c: 'push', title: 'Approval needed', body: 'Run a command?', tag: 'prompt-1', sessionId: 's1' },
	});
	await room.webSocketMessage(host, pushFrame);

	const after = await room.fetch(new Request(pendingUrl, { headers: { Authorization: `Bearer ${token}` } }));
	assert.equal(after.status, 200);
	assert.deepEqual(await after.json(), {
		pending: [{ title: 'Approval needed', body: 'Run a command?', tag: 'prompt-1', sessionId: 's1' }],
	}, 'handlePending returns the just-raised push in the exact shape sw.js reads (data.pending[0].title/body/tag)');

	const missingToken = await room.fetch(new Request(pendingUrl));
	assert.equal(missingToken.status, 401, 'a request with no device token at all is rejected');

	const badToken = await room.fetch(new Request(pendingUrl, { headers: { Authorization: 'Bearer garbage.notarealtoken' } }));
	assert.equal(badToken.status, 403, 'a request with an invalid device token is rejected');
}

// ---- 9. GET /api/devices: host-only device list --------------------------------------------------

{
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);

	// Registered directly via raw SQL — the same shortcut test 8 takes — rather than going through
	// `handlePairClaim`'s HTTP path, which this file's own top-of-file doc excludes (it needs a
	// real/fake `WebSocketPair`, exercised only for `/ws/host`/`/ws/client`, not `/pair/claim`
	// itself; this insert mirrors exactly what that handler writes).
	state.storage.sql.exec(
		'INSERT INTO device (id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)',
		'device-older', 'Older phone', 'secret-hash-1', '{"kty":"EC"}', 1000, 2000,
	);
	state.storage.sql.exec(
		'INSERT INTO device (id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)',
		'device-newer', 'Newer phone', 'secret-hash-2', '{"kty":"EC"}', 5000, null,
	);
	state.storage.sql.exec('UPDATE device SET revokedAt = ? WHERE id = ?', 9000, 'device-older');

	const devicesUrl = 'https://relay.example/api/devices?room=room1';
	const hostToken = 'host-token-abc';

	const missing = await room.fetch(new Request(devicesUrl));
	assert.equal(missing.status, 401, '/api/devices with no bearer token at all is rejected');

	// The first bearer token presented TOFU-claims the room's host token (the same rule
	// `verifyOrClaimHostToken` applies to `/ws/host` — `handleDevices` reuses it verbatim).
	const ok = await room.fetch(new Request(devicesUrl, { headers: { Authorization: `Bearer ${hostToken}` } }));
	assert.equal(ok.status, 200);
	const body = await ok.json();
	assert.deepEqual(body, {
		devices: [
			{ id: 'device-newer', name: 'Newer phone', createdAt: 5000, lastSeenAt: null, revokedAt: null },
			{ id: 'device-older', name: 'Older phone', createdAt: 1000, lastSeenAt: 2000, revokedAt: 9000 },
		],
	}, 'devices are returned newest-first with no pubkeyJwk/tokenHash in the response shape');

	const wrong = await room.fetch(new Request(devicesUrl, { headers: { Authorization: 'Bearer some-other-token' } }));
	assert.equal(wrong.status, 403, '/api/devices with a token that mismatches the already-claimed host token is rejected');
}

// ---- 10. `deviceConnected` notice: firstConnect vs. reconnect, and the no-host-connected gap ------
//
// Drives `touchDeviceLastSeen`/`notifyHostDeviceConnected` directly rather than through
// `upgradeClient`/`fetch('/ws/client')`: those construct a real `WebSocketPair` and return a
// `Response` with `status: 101`, which plain Node's built-in `Response` rejects outright (it only
// accepts 200–599) — exactly the reason this file's top-of-file doc already excludes the WS-upgrade
// path from `fetch()` coverage. TypeScript's `private` is erased by Node's type-stripping, so these
// are plain callable methods at runtime; calling them directly here is the same kind of "reach past
// the front door to drive the DO's own state" test 8 and test 9 already do via raw SQL.
{
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);
	const host = new FakeWebSocket('host');
	state.acceptWebSocket(host, [HOST_TAG]);

	// Registered with lastSeenAt NULL — exactly what handlePairClaim now leaves it as (see its
	// updated doc), so the very first touch below is a genuine "first connect".
	state.storage.sql.exec(
		'INSERT INTO device (id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
		'device-x', 'Pixel 8', 'secret-hash', 'null', 1000,
	);

	const first = room.touchDeviceLastSeen('device-x');
	assert.deepEqual(first, { firstConnect: true, name: 'Pixel 8' }, "a device's very first touch reports firstConnect: true");
	room.notifyHostDeviceConnected('device-x', first.name, first.firstConnect);
	assert.equal(host.sent.length, 1, 'the connected host socket receives one deviceConnected frame');
	assert.deepEqual(JSON.parse(host.sent[0]), {
		v: 1, t: 'c', seq: 0, p: { c: 'deviceConnected', deviceId: 'device-x', name: 'Pixel 8', firstConnect: true },
	}, 'the frame carries deviceId/name/firstConnect: true');

	const second = room.touchDeviceLastSeen('device-x');
	assert.equal(second.firstConnect, false, 'a second connect from the same device is an ordinary reconnect, not firstConnect');
	room.notifyHostDeviceConnected('device-x', second.name, second.firstConnect);
	assert.equal(host.sent.length, 2, 'the reconnect still notifies the host, just with firstConnect: false');
	assert.deepEqual(JSON.parse(host.sent[1]).p, { c: 'deviceConnected', deviceId: 'device-x', name: 'Pixel 8', firstConnect: false });

	// No host socket connected: the notice is simply not delivered, and this must not throw — the
	// "not-a-bug gap" this task's spec calls out explicitly.
	const noHostState = new FakeDurableObjectState();
	const noHostRoom = new WorkspaceRoom(noHostState, FAKE_ENV);
	noHostState.storage.sql.exec(
		'INSERT INTO device (id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
		'device-y', 'Unpaired-from-host phone', 'secret-hash', 'null', 1000,
	);
	assert.doesNotThrow(() => {
		const { firstConnect, name } = noHostRoom.touchDeviceLastSeen('device-y');
		noHostRoom.notifyHostDeviceConnected('device-y', name, firstConnect);
	}, 'no connected host socket to notify is not an error');
}

// ---- 10. webSocketMessage: a `hello` frame is answered with `welcome` -------------------------
//
// Regression test for the bug where nothing ever sent `welcome`: `pwa/app.js`'s `connect()`
// waits for it before sending `ready` (see `case 'welcome':` there), so without this reply a
// paired device's WebSocket opens ("Connected") but the app never bootstraps — no sessions, no
// providers, a composer that silently no-ops on send.

{
	// A client's `hello` gets `welcome` back, and is not treated as a host takeover.
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);
	const client = new FakeWebSocket('client');
	state.acceptWebSocket(client, [clientTag('device-a')]);

	const hello = JSON.stringify({ v: 1, t: 'c', seq: 1, p: { c: 'hello', role: 'client' } });
	await room.webSocketMessage(client, hello);

	assert.deepEqual(client.sent.map(m => JSON.parse(m)), [{ v: 1, t: 'c', seq: 0, p: { c: 'welcome', lastSeq: 0 } }],
		"a client's hello is answered with exactly one welcome frame");
	assert.equal(client.closed, undefined, "answering a client's hello does not close its own socket");
}

{
	// A host's `hello` also gets `welcome` back, on top of the existing takeover behavior.
	const state = new FakeDurableObjectState();
	const room = new WorkspaceRoom(state, FAKE_ENV);
	const oldHost = new FakeWebSocket('old-host');
	const newHost = new FakeWebSocket('new-host');
	state.acceptWebSocket(oldHost, [HOST_TAG]);
	state.acceptWebSocket(newHost, [HOST_TAG]);

	const hello = JSON.stringify({ v: 1, t: 'c', seq: 1, p: { c: 'hello', role: 'host' } });
	await room.webSocketMessage(newHost, hello);

	assert.deepEqual(newHost.sent.map(m => JSON.parse(m)), [{ v: 1, t: 'c', seq: 0, p: { c: 'welcome', lastSeq: 0 } }],
		"a host's hello is also answered with welcome, alongside the takeover of the old host");
	assert.deepEqual(oldHost.closed, { code: HOST_TAKEOVER_CLOSE_CODE, reason: 'replaced by a new host connection' },
		'the takeover itself is unaffected by also sending welcome');
}

console.log('test-room-relay: all assertions passed');
