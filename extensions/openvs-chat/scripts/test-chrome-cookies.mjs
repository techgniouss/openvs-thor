/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/webCookie/chromeCookies.ts's pure crypto/parsing
// pieces. Every fixture here is synthetic — generated with a throwaway key in this file — and
// none of it ever touches a real Chrome profile or a real credential. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-chrome-cookies.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const m = await import(new URL('../out/providers/webCookie/chromeCookies.js', import.meta.url));

// ── stripDomainHashPrefix ───────────────────────────────────────────────────────────────────

// Short plaintext (<=32 bytes): never has a prefix to strip.
{
	const plain = Buffer.from('short');
	assert.deepStrictEqual(m.stripDomainHashPrefix(plain), plain);
}

// A printable (ASCII) 32-byte head means no prefix — the whole buffer is real content.
{
	const plain = Buffer.from('a'.repeat(40));
	assert.deepStrictEqual(m.stripDomainHashPrefix(plain), plain);
}

// A binary (non-ASCII) 32-byte head followed by a clean ASCII tail is the domain-hash
// prefix Chrome adds — stripped, leaving only the tail.
{
	const hash = crypto.randomBytes(32);
	hash[0] |= 0x80; // force at least one non-ASCII byte so the head is unambiguously binary
	const tail = Buffer.from('the-real-cookie-value');
	const plain = Buffer.concat([hash, tail]);
	assert.deepStrictEqual(m.stripDomainHashPrefix(plain), tail);
}

// Binary head AND binary tail: ambiguous, so nothing is stripped (matches the source
// project's "return plain" fallback for the case neither check resolves).
{
	const head = crypto.randomBytes(32);
	head[0] |= 0x80;
	const tail = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
	const plain = Buffer.concat([head, tail]);
	assert.deepStrictEqual(m.stripDomainHashPrefix(plain), plain);
}

// ── decryptCookieValue ──────────────────────────────────────────────────────────────────────

function encryptV10(plaintext, key) {
	const nonce = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([Buffer.from('v10'), nonce, ciphertext, tag]);
}

const KEY = crypto.randomBytes(32);

// Round-trips a plain cookie value with no domain-hash prefix.
{
	const plaintext = Buffer.from('sso=eyJhbGciOiJIUzI1NiJ9.abc.def');
	const encrypted = encryptV10(plaintext, KEY);
	assert.equal(m.decryptCookieValue(encrypted, KEY), plaintext.toString('utf8'));
}

// Round-trips a value WITH the 32-byte domain-hash prefix prepended before encryption —
// proves decrypt + strip compose correctly, not just each in isolation.
{
	const hash = crypto.randomBytes(32);
	hash[0] |= 0x80;
	const real = Buffer.from('__Secure-1PSID-value-1234567890');
	const encrypted = encryptV10(Buffer.concat([hash, real]), KEY);
	assert.equal(m.decryptCookieValue(encrypted, KEY), real.toString('utf8'));
}

// The wrong key fails closed to '' rather than throwing or returning garbage — GCM's auth
// tag check fails first, which is exactly the property that makes it safe to fail silently
// here instead of corrupting a cookie jar with garbled bytes.
{
	const plaintext = Buffer.from('value');
	const encrypted = encryptV10(plaintext, KEY);
	const wrongKey = crypto.randomBytes(32);
	assert.equal(m.decryptCookieValue(encrypted, wrongKey), '');
}

// A value with neither the v10 nor v11 prefix (e.g. already-plaintext, or a format this
// module doesn't know) is rejected rather than misinterpreted as ciphertext.
{
	assert.equal(m.decryptCookieValue(Buffer.from('not-encrypted-at-all'), KEY), '');
}

// Too-short input (can't possibly hold nonce+tag) fails closed.
{
	assert.equal(m.decryptCookieValue(Buffer.from('v10tooshort'), KEY), '');
}

console.log('All chrome-cookies assertions passed.');
