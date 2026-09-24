/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/oauthProxy.ts's token-mint cache. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-oauth-proxy.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/oauthProxy.js', import.meta.url));

const FAKE_INFO = { id: 'fake', label: 'Fake', suggestedModels: ['m'], apiKeyUrl: '', requiresApiKey: true, supportsTools: false, toolModelPatterns: [], visionModelPatterns: [] };

class FakeProxy extends m.OAuthProxyChatProvider {
	constructor() {
		super();
		this.mintCalls = 0;
	}
	get info() { return FAKE_INFO; }
	async mintToken(storedCredential, _signal) {
		this.mintCalls++;
		return { token: `wire-${storedCredential}-${this.mintCalls}`, expiresAt: Date.now() + 30 * 60_000 };
	}
	// Exposed for the test; production subclasses never call this directly (streamChat etc. do).
	testWireToken(cred, signal) { return this.wireToken(cred, signal); }
}

// First call mints. A second call with the same stored credential, while still fresh,
// reuses the cached token instead of minting again.
{
	const p = new FakeProxy();
	const t1 = await p.testWireToken('cred-a', new AbortController().signal);
	const t2 = await p.testWireToken('cred-a', new AbortController().signal);
	assert.equal(t1, t2);
	assert.equal(p.mintCalls, 1);
}

// A different stored credential (e.g. after key rotation to a second pooled account)
// gets its own cache entry and its own mint.
{
	const p = new FakeProxy();
	const t1 = await p.testWireToken('cred-a', new AbortController().signal);
	const t2 = await p.testWireToken('cred-b', new AbortController().signal);
	assert.notEqual(t1, t2);
	assert.equal(p.mintCalls, 2);
}

// A token near its expiry margin is re-minted rather than served stale.
{
	class NearExpiryProxy extends m.OAuthProxyChatProvider {
		constructor() { super(); this.mintCalls = 0; }
		get info() { return FAKE_INFO; }
		async mintToken(cred) {
			this.mintCalls++;
			// Well inside the 5-minute margin: the cache must treat this as "needs re-mint".
			return { token: `wire-${cred}-${this.mintCalls}`, expiresAt: Date.now() + 60_000 };
		}
		testWireToken(cred, signal) { return this.wireToken(cred, signal); }
	}
	const p = new NearExpiryProxy();
	await p.testWireToken('c', new AbortController().signal);
	await p.testWireToken('c', new AbortController().signal);
	assert.equal(p.mintCalls, 2, 'a token inside the margin is re-minted on the next call');
}

// A concurrent burst of calls for the same credential before the first mint resolves
// must share ONE in-flight mint, not fire one per call.
{
	class SlowProxy extends m.OAuthProxyChatProvider {
		constructor() { super(); this.mintCalls = 0; }
		get info() { return FAKE_INFO; }
		async mintToken(cred) {
			this.mintCalls++;
			await new Promise(r => setTimeout(r, 20));
			return { token: `wire-${cred}`, expiresAt: Date.now() + 30 * 60_000 };
		}
		testWireToken(cred, signal) { return this.wireToken(cred, signal); }
	}
	const p = new SlowProxy();
	const signal = new AbortController().signal;
	const [a, b, c] = await Promise.all([p.testWireToken('x', signal), p.testWireToken('x', signal), p.testWireToken('x', signal)]);
	assert.equal(a, b);
	assert.equal(b, c);
	assert.equal(p.mintCalls, 1, 'concurrent calls for the same credential share one mint');
}

// The shared mint is not tied to the first caller's signal: a Stop in the tab that happened
// to start it used to fail the same request in every other tab waiting on it.
{
	class SlowProxy extends m.OAuthProxyChatProvider {
		constructor() { super(); this.release = undefined; this.sawAbort = false; }
		get info() { return FAKE_INFO; }
		mintToken(cred, signal) {
			signal.addEventListener('abort', () => { this.sawAbort = true; });
			return new Promise(resolve => { this.release = () => resolve({ token: `wire-${cred}`, expiresAt: Date.now() + 30 * 60_000 }); });
		}
		testWireToken(cred, signal) { return this.wireToken(cred, signal); }
	}
	const p = new SlowProxy();
	const first = new AbortController();
	const a = p.testWireToken('cred', first.signal);
	const b = p.testWireToken('cred', new AbortController().signal);
	first.abort();
	await assert.rejects(a, err => err.name === 'AbortError', 'the tab that stopped stops');
	p.release();
	assert.equal(await b, 'wire-cred', 'the other tab still gets its token');
	assert.equal(p.sawAbort, false, 'and the mint itself was never cancelled');
}

// A 401 drops the cached token and re-mints once; any other failure is not retried.
{
	const p = new FakeProxy();
	const used = [];
	const result = await p.withWireSession('cred', new AbortController().signal, async session => {
		used.push(session.token);
		if (used.length === 1) { throw new Error('Fake: authentication failed (HTTP 401). token revoked'); }
		return 'ok';
	});
	assert.deepStrictEqual([result, used], ['ok', ['wire-cred-1', 'wire-cred-2']]);
	let calls = 0;
	await assert.rejects(p.withWireSession('cred', new AbortController().signal, async () => { calls++; throw new Error('Fake: rate limited (HTTP 429)'); }), /429/);
	assert.equal(calls, 1);
}

// A refreshed credential is saved over the old one, and later requests still carrying the old
// string mint from the new one — a rotated refresh token is single-use.
{
	class RotatingProxy extends m.OAuthProxyChatProvider {
		constructor() { super(); this.minted = []; }
		get info() { return FAKE_INFO; }
		async mintToken(cred) {
			this.minted.push(cred);
			return { token: `wire-for-${cred}`, expiresAt: Date.now() + 60_000, updatedCredential: `${cred}+` };
		}
		testWireToken(cred, signal) { return this.wireToken(cred, signal); }
	}
	const p = new RotatingProxy();
	const saved = [];
	p.setCredentialPersister(async (previous, next) => { saved.push([previous, next]); });
	await p.testWireToken('rt1', new AbortController().signal);
	// Inside the 5-minute margin, so the next call mints again — from the successor.
	await p.testWireToken('rt1', new AbortController().signal);
	assert.deepStrictEqual(p.minted, ['rt1', 'rt1+']);
	assert.deepStrictEqual(saved, [['rt1', 'rt1+'], ['rt1+', 'rt1++']]);
}

console.log('All oauth-proxy assertions passed.');
