/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/deviceAuth.ts's polling state machine. Stubs `fetch` globally
// so no real network call happens. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-device-auth.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/deviceAuth.js', import.meta.url));

const originalFetch = globalThis.fetch;

const CONFIG = {
	deviceCodeUrl: 'https://example.test/device/code',
	tokenUrl: 'https://example.test/token',
	clientId: 'client-123',
	scope: 'offline_access',
};

const DEVICE = {
	deviceCode: 'dc-1',
	userCode: 'ABCD-1234',
	verificationUri: 'https://example.test/activate',
	expiresInSeconds: 900,
	intervalSeconds: 0, // 0 so the test doesn't actually wait between polls
};

function fakeFetch(responses) {
	let i = 0;
	return async () => {
		const r = responses[Math.min(i, responses.length - 1)];
		i++;
		return { ok: r.status === 200, status: r.status, json: async () => r.body };
	};
}

// requestDeviceCode parses the device_code/user_code/verification_uri shape.
{
	globalThis.fetch = async (url, init) => {
		assert.equal(url, CONFIG.deviceCodeUrl);
		assert.equal(init.method, 'POST');
		const body = new URLSearchParams(init.body);
		assert.equal(body.get('client_id'), 'client-123');
		assert.equal(body.get('scope'), 'offline_access');
		return {
			ok: true, status: 200,
			json: async () => ({ device_code: 'dc-9', user_code: 'WXYZ-0000', verification_uri: 'https://x.test/act', expires_in: 600, interval: 3 }),
		};
	};
	const device = await m.requestDeviceCode(CONFIG, new AbortController().signal);
	assert.deepStrictEqual(device, {
		deviceCode: 'dc-9', userCode: 'WXYZ-0000', verificationUri: 'https://x.test/act',
		expiresInSeconds: 600, intervalSeconds: 3,
	});
}

// requestDeviceCode also accepts the alternate `verification_url` spelling some servers use.
{
	globalThis.fetch = async () => ({
		ok: true, status: 200,
		json: async () => ({ device_code: 'dc-1', user_code: 'U', verification_url: 'https://alt.test' }),
	});
	const device = await m.requestDeviceCode(CONFIG, new AbortController().signal);
	assert.equal(device.verificationUri, 'https://alt.test');
	// Defaults applied when the server omits expires_in/interval.
	assert.equal(device.expiresInSeconds, 900);
	assert.equal(device.intervalSeconds, 5);
}

// requestDeviceCode raises on a non-2xx status and on a malformed body.
{
	globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
	await assert.rejects(() => m.requestDeviceCode(CONFIG, new AbortController().signal), /HTTP 400/);
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user_code: 'only-this' }) });
	await assert.rejects(() => m.requestDeviceCode(CONFIG, new AbortController().signal), /missing/i);
}

// authorization_pending keeps polling; the next response succeeds.
{
	globalThis.fetch = fakeFetch([
		{ status: 400, body: { error: 'authorization_pending' } },
		{ status: 400, body: { error: 'authorization_pending' } },
		{ status: 200, body: { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600 } },
	]);
	const controller = new AbortController();
	const before = Date.now();
	const result = await m.pollDeviceToken(CONFIG, DEVICE, controller.signal);
	assert.equal(result.accessToken, 'tok-1');
	assert.equal(result.refreshToken, 'ref-1');
	assert.ok(result.expiresAt > before);
}

// A response with no refresh_token leaves it undefined rather than null/empty-string.
{
	globalThis.fetch = fakeFetch([{ status: 200, body: { access_token: 'tok-solo', expires_in: 60 } }]);
	const result = await m.pollDeviceToken(CONFIG, DEVICE, new AbortController().signal);
	assert.equal(result.refreshToken, undefined);
}

// access_denied fails immediately without exhausting further polls.
{
	let calls = 0;
	globalThis.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: 'access_denied' }) }; };
	const controller = new AbortController();
	await assert.rejects(() => m.pollDeviceToken(CONFIG, DEVICE, controller.signal), /denied/i);
	assert.equal(calls, 1, 'denial must not be retried');
}

// expired_token / expired_grant both fail cleanly.
{
	for (const error of ['expired_token', 'expired_grant']) {
		globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error }) });
		await assert.rejects(() => m.pollDeviceToken(CONFIG, DEVICE, new AbortController().signal), /expired/i, error);
	}
}

// The RFC 8628 deadline (expiresInSeconds) also ends the poll even without an explicit
// expired_token error — a server that just stops answering meaningfully must not poll forever.
{
	globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) });
	const expiredDevice = { ...DEVICE, expiresInSeconds: -1 }; // already past deadline
	await assert.rejects(() => m.pollDeviceToken(CONFIG, expiredDevice, new AbortController().signal), /expired/i);
}

// slow_down is treated like authorization_pending (keep polling) rather than a failure.
{
	globalThis.fetch = fakeFetch([
		{ status: 400, body: { error: 'slow_down' } },
		{ status: 200, body: { access_token: 'tok-2', expires_in: 3600 } },
	]);
	const controller = new AbortController();
	const result = await m.pollDeviceToken(CONFIG, DEVICE, controller.signal);
	assert.equal(result.accessToken, 'tok-2');
}

// Aborting the signal stops polling and rejects with an AbortError, not a generic failure.
{
	globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) });
	const controller = new AbortController();
	const pending = m.pollDeviceToken(CONFIG, DEVICE, controller.signal);
	controller.abort();
	await assert.rejects(() => pending, err => err.name === 'AbortError');
}

// onTick fires once per poll attempt.
{
	let ticks = 0;
	globalThis.fetch = fakeFetch([
		{ status: 400, body: { error: 'authorization_pending' } },
		{ status: 200, body: { access_token: 'tok-3', expires_in: 3600 } },
	]);
	const controller = new AbortController();
	await m.pollDeviceToken(CONFIG, DEVICE, controller.signal, () => { ticks++; });
	assert.equal(ticks, 2);
}

globalThis.fetch = originalFetch;
console.log('All device-auth assertions passed.');
