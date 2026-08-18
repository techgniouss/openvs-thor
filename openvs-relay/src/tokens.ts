// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Pure device-token logic: minting, parsing, and constant-time verification. Like `pairing.ts`,
// nothing here touches Durable Object storage — `room.ts` supplies the lookup function that
// {@link verifyToken} calls, so this file (and its tests) stay `node`-runnable.

/** Encodes `bytes` as lowercase hex. */
function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Encodes `bytes` as unpadded base64url, matching what the DO returns to a claiming device. */
function toBase64Url(bytes: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(bytes)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(pepper: string, message: string): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(pepper),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

/**
 * Mints a device token of the form `<deviceId>.<base64url(HMAC-SHA256(pepper, deviceId|roomId|issuedAt))>`.
 * Only the hash half is ever persisted (see {@link hashForStorage}) — the returned string is
 * handed to the claiming device once and never stored server-side in recoverable form.
 */
export async function mintToken(deviceId: string, roomId: string, issuedAtMs: number, pepper: string): Promise<string> {
	const signature = await hmacSha256(pepper, `${deviceId}|${roomId}|${issuedAtMs}`);
	return `${deviceId}.${toBase64Url(signature)}`;
}

/**
 * Hashes an arbitrary token/value for storage via HMAC-SHA256, hex-encoded — the same shape
 * `pairing.ts`'s `hashCode` produces, kept as a separate export here rather than shared: a
 * pairing code and a device token differ enough in *what* gets hashed (a short human-typed code
 * vs. the full minted token string) that forcing one helper on both would mean every caller
 * passing pepper + subject through an indirection that saves no real duplication.
 */
export async function hashForStorage(value: string, pepper: string): Promise<string> {
	const signature = await hmacSha256(pepper, value);
	return toHex(signature);
}

/** A token accepted by {@link verifyToken}, naming the device it authenticates. */
export interface VerifiedToken {
	readonly deviceId: string;
}

/**
 * Verifies a device token presented on `/ws/client` (or `/api/*`) against the stored hash for
 * that device. `lookupHash` is injected so this stays free of Durable Object storage — `room.ts`
 * passes a closure reading `device.tokenHash` for the parsed `deviceId`.
 *
 * The token itself is never recomputed to a hash and compared against another *derived* hash —
 * verification recomputes the HMAC directly and compares that against the stored hash, both
 * fixed-length hex strings, via {@link timingSafeEqualHex} rather than `===`, so a byte-by-byte
 * timing side channel cannot be used to guess the stored hash one character at a time.
 */
export async function verifyToken(
	token: string,
	roomId: string,
	pepper: string,
	lookupHash: (deviceId: string) => Promise<string | undefined>,
): Promise<VerifiedToken | undefined> {
	const dot = token.indexOf('.');
	if (dot <= 0 || dot === token.length - 1) {
		return undefined;
	}
	const deviceId = token.slice(0, dot);
	const stored = await lookupHash(deviceId);
	if (!stored) {
		return undefined;
	}
	// The token does not carry its own issuedAt in the clear beyond what mintToken folded into
	// the HMAC input, so verification cannot re-derive the mint signature from scratch. Instead
	// it recomputes the *storage hash* the same way the DO computed it when the token was
	// minted — hash-of-`roomId|token`, not just hash-of-token — and compares against what was
	// stored. `roomId` is a real input here, not documentation: `RELAY_PEPPER` is one secret
	// shared by every room this Worker serves, so without folding the room in, a token minted
	// for one room's DO would (if a deviceId ever collided) verify against another room's
	// storage too. Binding the storage hash to the room closes that even though the DO's own
	// per-room SQLite isolation already makes a same-deviceId collision practically impossible.
	const presentedHash = await hashForStorage(`${roomId}|${token}`, pepper);
	if (!timingSafeEqualHex(presentedHash, stored)) {
		return undefined;
	}
	return { deviceId };
}

/**
 * Constant-time comparison of two equal-length hex strings. Unequal lengths (which should never
 * happen for two SHA-256 hex digests) are rejected immediately — a fixed-length primitive cannot
 * meaningfully hide a length mismatch anyway, and pretending otherwise would be misleading.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
