/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The local relay (src/remote/local/relayServer.ts + websocket.ts) run for real: a live HTTP
// server on loopback, driven by Node's own WebSocket client — someone else's framing code is the
// honest check on ours. Covers the whole path a phone takes: the app is served, a code is minted
// and claimed, messages route both ways, heartbeats are answered, VS Code leaving and returning
// is announced, revocation locks a device out, and the local-only hardening holds. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-local-relay.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { LocalRelay, memoryStore, fileStore } = await import(new URL('../out/remote/local/relayServer.js', import.meta.url));

const pwaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openvs-pwa-'));
fs.writeFileSync(path.join(pwaDir, 'index.html'), '<!doctype html><title>OpenVS Remote</title>');
fs.writeFileSync(path.join(pwaDir, 'app.js'), 'console.log(1);');

const ROOM = 'ROOM1';
const HOST_TOKEN = 'host-token';
const store = memoryStore();
const relay = new LocalRelay({ pwaDir, pepper: 'test-pepper', store });
relay.registerRoom(ROOM, HOST_TOKEN);
const port = await relay.start();
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;

/** Opens a socket whose messages can be awaited by predicate. */
function open(url, init) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, init);
		const inbox = [];
		const waiters = [];
		ws.closed = new Promise(res => ws.addEventListener('close', e => res(e.code)));
		ws.addEventListener('message', e => {
			const env = JSON.parse(e.data);
			const i = waiters.findIndex(w => w.pred(env));
			if (i >= 0) { waiters.splice(i, 1)[0].resolve(env); } else { inbox.push(env); }
		});
		ws.next = (pred, ms = 3000) => {
			const i = inbox.findIndex(pred);
			if (i >= 0) { return Promise.resolve(inbox.splice(i, 1)[0]); }
			return new Promise((res, rej) => {
				const timer = setTimeout(() => rej(new Error('timed out waiting for a frame')), ms);
				waiters.push({ pred, resolve: v => { clearTimeout(timer); res(v); } });
			});
		};
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`could not open ${url}`)), { once: true });
	});
}
const control = (ws, p, seq = 1) => ws.send(JSON.stringify({ v: 1, t: 'c', seq, p }));
const isC = verb => env => env.t === 'c' && env.p?.c === verb;
const claim = code => fetch(`${base}/pair/claim?room=${ROOM}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Test phone' }) });

// The phone app is served, with /p/<room> routed to its index like the cloud relay's SPA assets.
assert.equal((await fetch(`${base}/app.js`)).status, 200);
assert.match(await (await fetch(`${base}/p/${ROOM}`)).text(), /OpenVS Remote/);
assert.match(await (await fetch(`${base}/../../etc/passwd`)).text(), /OpenVS Remote/, 'a path outside the app falls back to the index, never the filesystem');

// Host: a wrong token is refused; the right one gets welcome.
await assert.rejects(open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: 'Bearer nope' } }));
const host = await open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
control(host, { c: 'hello', role: 'host' });
assert.deepEqual((await host.next(isC('welcome'))).p, { c: 'welcome', lastSeq: 0 });

// Heartbeat: answered whatever seq it carries (the bug that dropped every link once a minute).
control(host, { c: 'ping' }, 7);
await host.next(isC('pong'));

// Pairing: an unknown room and a wrong code are refused; a minted code works exactly once.
assert.equal((await fetch(`${base}/pair/claim?room=NOPE`, { method: 'POST', body: '{"code":"X"}' })).status, 404);
assert.equal((await claim('WRONGCODE')).status, 403);
control(host, { c: 'pair' });
const paired = await host.next(isC('paired'));
assert.match(paired.p.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
const claimed = await claim(paired.p.code.toLowerCase());
assert.equal(claimed.status, 200, 'codes are accepted case-insensitively, as typed on a phone');
const { deviceId, token } = await claimed.json();
assert.equal((await claim(paired.p.code)).status, 403, 'a code is single-use');

// Phone connects: told the host is here; the host hears about its first connect.
const phone = await open(`${wsBase}/ws/client?room=${ROOM}&token=${encodeURIComponent(token)}`);
assert.deepEqual((await host.next(isC('deviceConnected'))).p, { c: 'deviceConnected', deviceId, name: 'Test phone', firstConnect: true });
control(phone, { c: 'hello', role: 'client' });
assert.equal((await phone.next(isC('welcome'))).p.hostOnline, true);

// App messages route host → phone and phone → host, verbatim — including a large one.
const big = 'x'.repeat(200_000);
host.send(JSON.stringify({ v: 1, t: 'm', seq: 2, p: { type: 'token', delta: big } }));
assert.equal((await phone.next(env => env.t === 'm')).p.delta.length, big.length);
phone.send(JSON.stringify({ v: 1, t: 'm', seq: 3, p: { type: 'ready' } }));
assert.equal((await host.next(env => env.t === 'm')).p.type, 'ready');

// Host endpoints refuse anything that came through the tunnel.
const devices = await fetch(`${base}/api/devices?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
assert.deepEqual((await devices.json()).devices.map(d => d.id), [deviceId]);
const tunneled = await fetch(`${base}/api/devices?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}`, 'Cf-Connecting-Ip': '203.0.113.9' } });
assert.equal(tunneled.status, 403, 'the device list is not reachable from the internet, even with the host token');
await assert.rejects(open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}`, 'Cf-Connecting-Ip': '203.0.113.9' } }));

// VS Code leaving and returning is announced to the phone.
host.close();
assert.equal((await phone.next(isC('hostStatus'))).p.online, false);
const host2 = await open(`${wsBase}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
assert.equal((await phone.next(isC('hostStatus'))).p.online, true);

// Revocation closes the device's live socket with 4001 and refuses it from then on.
control(host2, { c: 'revoke', deviceId });
assert.equal((await host2.next(isC('revoked'))).p.deviceId, deviceId);
assert.equal(await phone.closed, 4001);
await assert.rejects(open(`${wsBase}/ws/client?room=${ROOM}&token=${encodeURIComponent(token)}`));

host2.close();
await relay.stop();

// State survives a restart through the file store: a device paired before still authenticates.
{
	const file = path.join(pwaDir, 'state.json');
	const first = new LocalRelay({ pwaDir, pepper: 'p', store: fileStore(file) });
	first.registerRoom(ROOM, HOST_TOKEN);
	const p1 = await first.start();
	const h = await open(`ws://127.0.0.1:${p1}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
	control(h, { c: 'pair' });
	const code = (await h.next(isC('paired'))).p.code;
	const res = await fetch(`http://127.0.0.1:${p1}/pair/claim?room=${ROOM}`, { method: 'POST', body: JSON.stringify({ code }) });
	const saved = (await res.json()).token;
	h.close();
	await first.stop();

	const second = new LocalRelay({ pwaDir, pepper: 'p', store: fileStore(file) });
	second.registerRoom(ROOM, HOST_TOKEN);
	const p2 = await second.start();
	const again = await open(`ws://127.0.0.1:${p2}/ws/client?room=${ROOM}&token=${encodeURIComponent(saved)}`);
	again.close();
	await second.stop();
}

// Guessing pairing codes through the public tunnel is limited per room: a wrong guess matches
// no code, so the per-code attempt count never saw it and nothing limited guessing at all.
// Past the limit every live code is withdrawn; a freshly minted one works again.
{
	const r = new LocalRelay({ pwaDir, pepper: 'p', store: memoryStore() });
	r.registerRoom(ROOM, HOST_TOKEN);
	const port = await r.start();
	const h = await open(`ws://127.0.0.1:${port}/ws/host?room=${ROOM}`, { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
	const claimAt = code => fetch(`http://127.0.0.1:${port}/pair/claim?room=${ROOM}`, { method: 'POST', body: JSON.stringify({ code }) });
	control(h, { c: 'pair' });
	const first = (await h.next(isC('paired'))).p.code;
	const statuses = [];
	for (let i = 0; i < 10; i++) {
		statuses.push((await claimAt(`WRONG${i}`)).status);
	}
	assert.deepStrictEqual(statuses, [403, 403, 403, 403, 403, 403, 403, 403, 403, 429]);
	assert.equal((await claimAt(first)).status, 429, 'the live code was withdrawn, and the room stays locked until a new code');
	control(h, { c: 'pair' }, 2);
	const second = (await h.next(isC('paired'))).p.code;
	assert.equal((await claimAt(second)).status, 200, 'a new code resets the count');

	// The phone app cannot be framed by another site (a clickjacked Approve) or sniffed.
	const page = await fetch(`http://127.0.0.1:${port}/p/${ROOM}`);
	assert.deepStrictEqual(
		['x-frame-options', 'content-security-policy', 'x-content-type-options', 'referrer-policy'].map(k => page.headers.get(k)),
		['DENY', "frame-ancestors 'none'", 'nosniff', 'no-referrer'],
	);
	h.close();
	await r.stop();
}

fs.rmSync(pwaDir, { recursive: true, force: true });
console.log('test-local-relay: all assertions passed');
