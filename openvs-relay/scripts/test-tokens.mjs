// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
// Tests src/tokens.ts: mint/verify round-trip, tamper rejection, timing-safe comparison.
import assert from 'node:assert/strict';
import { mintToken, verifyToken, hashForStorage, timingSafeEqualHex } from '../src/tokens.ts';

const PEPPER = 'unit-test-pepper';
const ROOM_ID = 'room-abc123';

/** Simulates the DO: mints a token the way room.ts's handlePairClaim does, storing only the hash-of-`roomId|token`. */
async function mintAndStore(deviceId, roomId = ROOM_ID, issuedAt = Date.now()) {
	const token = await mintToken(deviceId, roomId, issuedAt, PEPPER);
	const tokenHash = await hashForStorage(`${roomId}|${token}`, PEPPER);
	return { token, tokenHash };
}

// mintToken produces `<deviceId>.<base64url signature>`.
{
	const token = await mintToken('device-1', ROOM_ID, 1000, PEPPER);
	assert.match(token, /^device-1\.[A-Za-z0-9_-]+$/, 'token is "<deviceId>.<base64url signature>"');
}

// Round trip: a token minted for a device verifies successfully against a lookup returning the
// hash mintAndStore computed for it, and resolves to the right deviceId.
{
	const { token, tokenHash } = await mintAndStore('device-42');
	const lookup = async id => (id === 'device-42' ? tokenHash : undefined);
	const verified = await verifyToken(token, ROOM_ID, PEPPER, lookup);
	assert.ok(verified, 'a genuinely minted token verifies');
	assert.equal(verified.deviceId, 'device-42');
}

// A token for a device the lookup doesn't know about fails closed.
{
	const { token } = await mintAndStore('device-unknown');
	const verified = await verifyToken(token, ROOM_ID, PEPPER, async () => undefined);
	assert.equal(verified, undefined, 'an unknown device fails verification');
}

// Tampering with the token (flip a character in the signature half) must fail verification.
{
	const { token, tokenHash } = await mintAndStore('device-7');
	const dot = token.indexOf('.');
	const sig = token.slice(dot + 1);
	const tamperedChar = sig[0] === 'A' ? 'B' : 'A';
	const tampered = `${token.slice(0, dot + 1)}${tamperedChar}${sig.slice(1)}`;
	const lookup = async id => (id === 'device-7' ? tokenHash : undefined);
	const verified = await verifyToken(tampered, ROOM_ID, PEPPER, lookup);
	assert.equal(verified, undefined, 'a tampered token must not verify');
}

// A token minted for one room, presented against another room's id, must not verify — the
// storage hash binds `roomId|token` together (see tokens.ts's verifyToken doc).
{
	const { token, tokenHash } = await mintAndStore('device-9', 'room-A');
	const lookup = async id => (id === 'device-9' ? tokenHash : undefined);
	const verifiedWrongRoom = await verifyToken(token, 'room-B', PEPPER, lookup);
	assert.equal(verifiedWrongRoom, undefined, 'a token is bound to the room it was verified against');
	const verifiedRightRoom = await verifyToken(token, 'room-A', PEPPER, lookup);
	assert.ok(verifiedRightRoom, 'the same token still verifies against its own room');
}

// A malformed token (no dot, or nothing after the dot) is rejected without throwing.
{
	assert.equal(await verifyToken('nodothere', ROOM_ID, PEPPER, async () => 'x'), undefined);
	assert.equal(await verifyToken('device.', ROOM_ID, PEPPER, async () => 'x'), undefined);
	assert.equal(await verifyToken('.sigonly', ROOM_ID, PEPPER, async () => 'x'), undefined);
}

// timingSafeEqualHex: correct true/false for equal, unequal, and different-length inputs. The
// genuinely constant-time property is not asserted here (see this file's test list doc) — only
// that it computes the right answer.
{
	assert.equal(timingSafeEqualHex('abcd', 'abcd'), true, 'identical strings are equal');
	assert.equal(timingSafeEqualHex('abcd', 'abce'), false, 'a single differing character is unequal');
	assert.equal(timingSafeEqualHex('abcd', 'abcde'), false, 'different-length strings are unequal');
	assert.equal(timingSafeEqualHex('', ''), true, 'two empty strings are (trivially) equal');
}

console.log('test-tokens: all assertions passed');
