// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Pure pairing-code logic: generation, hashing, expiry, and attempt limiting. Nothing here
// touches Durable Object storage or `fetch` — `room.ts` wires this to real SQLite rows so the
// logic itself can run (and be tested) under plain `node`, no Workers runtime required.

/** Crockford base32 minus I, L, O, U — the four letters that read ambiguously in a handwritten code. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Pairing codes are single-use and expire fast; see `isExpired`. */
export const PAIRING_TTL_MS = 120_000;

/** Per-code claim attempts before the code is treated as burned, even if still within its TTL. */
export const MAX_PAIRING_ATTEMPTS = 5;

/**
 * Derives an 8-character pairing code from injected randomness. Pure function of `randomBytes`
 * so tests are deterministic — callers supply `crypto.getRandomValues(new Uint8Array(8))` (or a
 * fixed vector, in tests). Each byte is reduced mod {@link ALPHABET}'s length independently; the
 * alphabet is 32 characters (a power of two under 256), so the mod-32 reduction of a
 * uniform-random byte is itself uniform — no rejection sampling needed.
 */
export function generateCode(randomBytes: Uint8Array): string {
	if (randomBytes.length < 8) {
		throw new Error(`generateCode needs at least 8 random bytes, got ${randomBytes.length}`);
	}
	let code = '';
	for (let i = 0; i < 8; i++) {
		code += ALPHABET[randomBytes[i] % ALPHABET.length];
	}
	return code;
}

/** Encodes `bytes` as lowercase hex. */
function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hashes a pairing code with the relay's pepper via HMAC-SHA256, hex-encoded. Only this hash is
 * ever stored (`pairing.codeHash`) — the plaintext code exists solely in memory on the panel
 * that generated it and the PWA that was shown it, per the plan's "hash-only storage" rule.
 */
export async function hashCode(code: string, pepper: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(pepper),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(code));
	return toHex(signature);
}

/** Whether a pairing code minted at `expiresAtMs` has expired as of `nowMs`. Expiry is inclusive: `nowMs === expiresAtMs` counts as expired. */
export function isExpired(expiresAtMs: number, nowMs: number): boolean {
	return nowMs >= expiresAtMs;
}

/** Attempt counter for a single pairing code, threaded through {@link recordAttempt}/{@link exceededAttempts}. */
export interface AttemptState {
	readonly attempts: number;
}

/** Starting state for a freshly minted pairing code. */
export const INITIAL_ATTEMPTS: AttemptState = { attempts: 0 };

/** Returns a new {@link AttemptState} with one more attempt recorded. Pure — does not mutate `state`. */
export function recordAttempt(state: AttemptState): AttemptState {
	return { attempts: state.attempts + 1 };
}

/** Whether `state` has used up its {@link MAX_PAIRING_ATTEMPTS} claim attempts. */
export function exceededAttempts(state: AttemptState): boolean {
	return state.attempts >= MAX_PAIRING_ATTEMPTS;
}
