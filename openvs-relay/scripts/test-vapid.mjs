// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
// Tests src/push.ts: the VAPID JWT builder's shape/claims, and shouldPush's push-eligibility rules.
import assert from 'node:assert/strict';
import { buildVapidJwt, shouldPush } from '../src/push.ts';

/** Decodes a base64url JWT segment to a parsed JSON object. */
function decodeSegment(segment) {
	return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// A real P-256 key pair to sign with — generated once per test run via WebCrypto, exported as
// JWK the same shape `buildVapidJwt` expects for `VAPID_PRIVATE`.
const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
const publicKeyB64Url = Buffer.from(publicKeyRaw).toString('base64url');

const NOW_MS = 1_700_000_000_000;

// The JWT has exactly three dot-separated base64url segments, and the header/payload decode to
// the expected claims.
{
	const jwt = await buildVapidJwt(privateKeyJwk, publicKeyB64Url, 'https://push.example.com', 'mailto:ops@example.com', NOW_MS);
	const parts = jwt.split('.');
	assert.equal(parts.length, 3, 'a JWT has header.payload.signature');
	for (const part of parts) {
		assert.match(part, /^[A-Za-z0-9_-]+$/, 'every segment is base64url (no padding, no +/ characters)');
	}

	const header = decodeSegment(parts[0]);
	assert.deepEqual(header, { alg: 'ES256', typ: 'JWT' });

	const payload = decodeSegment(parts[1]);
	assert.equal(payload.aud, 'https://push.example.com');
	assert.equal(payload.sub, 'mailto:ops@example.com');
	assert.equal(payload.exp, Math.floor(NOW_MS / 1000) + 12 * 60 * 60, 'exp is now + 12h, per the plan');

	// The signature is a real, verifiable ECDSA signature over header.payload — not just three
	// well-formed-looking segments.
	const signatureBytes = Buffer.from(parts[2], 'base64url');
	const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.publicKey, signatureBytes, signingInput);
	assert.ok(ok, 'the JWT signature verifies against the public key it was signed with');
}

// shouldPush: always for approvalRequest/askRequest/error, done only past the 60s threshold,
// never for token/toolStart/info.
{
	assert.equal(shouldPush('approvalRequest', undefined, NOW_MS), true);
	assert.equal(shouldPush('askRequest', undefined, NOW_MS), true);
	assert.equal(shouldPush('error', undefined, NOW_MS), true);

	assert.equal(shouldPush('done', undefined, NOW_MS, 30_000), false, 'a 30s run does not push on done');
	assert.equal(shouldPush('done', undefined, NOW_MS, 60_000), false, 'exactly 60s does not push on done (strictly greater required)');
	assert.equal(shouldPush('done', undefined, NOW_MS, 60_001), true, 'a run just over 60s pushes on done');
	assert.equal(shouldPush('done', undefined, NOW_MS), false, 'done with no duration given does not push');

	assert.equal(shouldPush('token', undefined, NOW_MS), false);
	assert.equal(shouldPush('toolStart', undefined, NOW_MS), false);
	assert.equal(shouldPush('info', undefined, NOW_MS), false);
}

// Rate limiting: 1 per 10s per session.
{
	assert.equal(shouldPush('error', NOW_MS - 5_000, NOW_MS), false, '5s since the last push is inside the 10s window');
	assert.equal(shouldPush('error', NOW_MS - 10_000, NOW_MS), true, 'exactly 10s since the last push is allowed');
	assert.equal(shouldPush('error', NOW_MS - 15_000, NOW_MS), true, 'well past the window is allowed');
	assert.equal(shouldPush('error', undefined, NOW_MS), true, 'no prior push at all is always allowed');
}

console.log('test-vapid: all assertions passed');
