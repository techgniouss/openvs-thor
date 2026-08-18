// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
// Tests src/pairing.ts's pure logic: alphabet, code generation, hashing, expiry, attempt limiting.
import assert from 'node:assert/strict';
import {
	ALPHABET, PAIRING_TTL_MS, MAX_PAIRING_ATTEMPTS,
	generateCode, hashCode, isExpired, INITIAL_ATTEMPTS, recordAttempt, exceededAttempts,
} from '../src/pairing.ts';

// The alphabet excludes I, L, O, U (ambiguous when handwritten/read aloud) and is exactly 32
// characters — a power of two, which is what makes the mod-32 reduction in generateCode uniform.
{
	assert.equal(ALPHABET.length, 32, 'alphabet must be 32 characters for a uniform mod reduction');
	for (const excluded of ['I', 'L', 'O', 'U']) {
		assert.ok(!ALPHABET.includes(excluded), `alphabet must not include ${excluded}`);
	}
	assert.equal(new Set(ALPHABET).size, ALPHABET.length, 'alphabet must have no duplicate characters');
}

// generateCode is a pure function of its input bytes: same bytes in, same code out, and the
// code is always 8 characters drawn only from ALPHABET.
{
	const bytes = new Uint8Array([0, 31, 32, 63, 64, 255, 100, 200]);
	const code = generateCode(bytes);
	assert.equal(code.length, 8, 'a pairing code is 8 characters');
	for (const ch of code) {
		assert.ok(ALPHABET.includes(ch), `every character of the code must be in ALPHABET, got ${ch}`);
	}
	assert.equal(generateCode(bytes), code, 'generateCode is deterministic given the same bytes');

	const different = generateCode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
	assert.notEqual(different, code, 'different input bytes produce a different code (sanity, not a security property)');

	assert.throws(() => generateCode(new Uint8Array(4)), /at least 8 random bytes/, 'rejects too few bytes rather than silently truncating the code');
}

// hashCode is deterministic for the same (code, pepper) pair, and is a hex-encoded SHA-256-sized
// digest — 64 hex characters.
{
	const hashA = await hashCode('ABCD1234', 'pepper-one');
	const hashB = await hashCode('ABCD1234', 'pepper-one');
	assert.equal(hashA, hashB, 'hashCode is deterministic for the same code and pepper');
	assert.equal(hashA.length, 64, 'HMAC-SHA256 hex-encodes to 64 characters');
	assert.match(hashA, /^[0-9a-f]{64}$/, 'the hash is lowercase hex');

	const hashDifferentPepper = await hashCode('ABCD1234', 'pepper-two');
	assert.notEqual(hashA, hashDifferentPepper, 'a different pepper produces a different hash — the pepper actually participates');

	const hashDifferentCode = await hashCode('WXYZ9876', 'pepper-one');
	assert.notEqual(hashA, hashDifferentCode, 'a different code produces a different hash');
}

// isExpired: boundary is inclusive (nowMs === expiresAtMs counts as expired), and behaves
// correctly strictly before/after.
{
	assert.equal(isExpired(1000, 999), false, 'not yet expired: now is before expiresAt');
	assert.equal(isExpired(1000, 1000), true, 'boundary: now === expiresAt counts as expired');
	assert.equal(isExpired(1000, 1001), true, 'expired: now is after expiresAt');
}

// The pairing TTL is the plan's stated 120s.
{
	assert.equal(PAIRING_TTL_MS, 120_000, 'pairing codes are single-use with a 120s TTL per the plan');
}

// Attempt limiting: pure state transitions, no mutation of the input.
{
	assert.deepEqual(INITIAL_ATTEMPTS, { attempts: 0 });
	let state = INITIAL_ATTEMPTS;
	assert.equal(exceededAttempts(state), false, 'a fresh code has not exceeded its attempts');

	for (let i = 0; i < MAX_PAIRING_ATTEMPTS - 1; i++) {
		state = recordAttempt(state);
		assert.equal(exceededAttempts(state), false, `attempt ${i + 1}/${MAX_PAIRING_ATTEMPTS} has not yet exceeded the limit`);
	}
	state = recordAttempt(state);
	assert.equal(state.attempts, MAX_PAIRING_ATTEMPTS);
	assert.equal(exceededAttempts(state), true, `the ${MAX_PAIRING_ATTEMPTS}th attempt exceeds the limit`);

	// recordAttempt does not mutate its input — INITIAL_ATTEMPTS must still read as fresh.
	assert.deepEqual(INITIAL_ATTEMPTS, { attempts: 0 }, 'recordAttempt must not mutate the state it was given');
}

console.log('test-pairing: all assertions passed');
