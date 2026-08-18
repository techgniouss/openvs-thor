// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Web Push: a VAPID ES256 JWT builder and a payload-less push sender. "Payload-less" means the
// push carries no encrypted body at all — the service worker wakes on the push event, then
// fetches the real content from `/api/pending` (see `pwa/sw.js`). That skips the ~120 lines of
// ECDH/HKDF/aes128gcm needed to encrypt a Web Push payload, and it means no approval/question
// text ever transits a third-party push service.

/** Encodes `bytes` as unpadded base64url. */
function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encodes a UTF-8 string as unpadded base64url. */
function textToBase64Url(text: string): string {
	return bytesToBase64Url(new TextEncoder().encode(text));
}

/**
 * A raw ECDSA P-256 signature from WebCrypto is the fixed-width `r || s` concatenation
 * (64 bytes total) — exactly the JWS `ES256` signature encoding, so no DER-to-raw conversion is
 * needed the way it would be for Node's `crypto` module.
 */
async function signEs256(privateKeyJwk: JsonWebKey, signingInput: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'jwk',
		privateKeyJwk,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(signingInput),
	);
	return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * Builds and signs a VAPID JWT: `alg: ES256`, `aud` = the push endpoint's origin, a short `exp`,
 * and `sub` identifying the sender (an operator email or URL). `nowMs` is a parameter, not
 * `Date.now()`, so the JWT's `exp` is deterministic under test.
 */
export async function buildVapidJwt(
	privateKeyJwk: JsonWebKey,
	publicKeyB64Url: string,
	audience: string,
	subject: string,
	nowMs: number,
): Promise<string> {
	void publicKeyB64Url; // carried separately as the `Crypto-Key`/`k` header value, not inside the JWT itself
	const header = { alg: 'ES256', typ: 'JWT' };
	const nowSec = Math.floor(nowMs / 1000);
	const payload = {
		aud: audience,
		exp: nowSec + 12 * 60 * 60, // 12h, per the plan
		sub: subject,
	};
	const signingInput = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(payload))}`;
	const signature = await signEs256(privateKeyJwk, signingInput);
	return `${signingInput}.${signature}`;
}

/** The minimal shape of a Web Push subscription the relay needs to send a payload-less push. */
export interface PushSubscriptionInfo {
	readonly endpoint: string;
	readonly p256dh: string;
	readonly auth: string;
}

/**
 * Sends a payload-less push: an empty-body POST to the subscription's endpoint carrying only the
 * VAPID `Authorization`/`Crypto-Key` headers and a short TTL. The push service wakes the client's
 * service worker with no data attached; `sw.js` treats that as a cue to fetch real content rather
 * than trusting anything in the push itself.
 */
export function sendPayloadLessPush(
	subscription: PushSubscriptionInfo,
	vapidJwt: string,
	vapidPublicKeyB64Url: string,
): Promise<Response> {
	return fetch(subscription.endpoint, {
		method: 'POST',
		headers: {
			Authorization: `vapid t=${vapidJwt}, k=${vapidPublicKeyB64Url}`,
			'Crypto-Key': `p256ecdsa=${vapidPublicKeyB64Url}`,
			TTL: '30',
			'Content-Length': '0',
		},
	});
}

/**
 * Event types the relay may be asked to raise a push for. Not the full `t: 'm'` message
 * vocabulary — only the subset `remoteSink.ts` (Phase 5/6) will ever wrap in a `push` control
 * frame, per the plan's "push must be an explicit control frame" rule.
 */
export type PushEventType = 'approvalRequest' | 'askRequest' | 'error' | 'done' | 'token' | 'toolStart' | 'info';

/** Minimum spacing between two pushes for the same session, per the plan's "1 per 10 s" rule. */
const PUSH_RATE_LIMIT_MS = 10_000;

/** A `done` event only pushes if the run it closes ran at least this long. */
const DONE_PUSH_THRESHOLD_MS = 60_000;

/**
 * Whether a given event should raise a push notification, per the plan's "Web Push" rules:
 * `approvalRequest`/`askRequest`/`error` always push (subject to the rate limit below); `done`
 * pushes only when the run it closes took longer than {@link DONE_PUSH_THRESHOLD_MS}; everything
 * else (`token`, `toolStart`, `info`, and any event type not in this function's cases) never
 * pushes. Rate limiting is 1 per {@link PUSH_RATE_LIMIT_MS} per session: `lastPushAtMs` is the
 * session's own last-push timestamp (or `undefined` if it has never pushed), and `nowMs` is a
 * parameter rather than `Date.now()` so this stays deterministic under test.
 */
export function shouldPush(eventType: string, lastPushAtMs: number | undefined, nowMs: number, runDurationMs?: number): boolean {
	let eligible: boolean;
	switch (eventType as PushEventType) {
		case 'approvalRequest':
		case 'askRequest':
		case 'error':
			eligible = true;
			break;
		case 'done':
			eligible = (runDurationMs ?? 0) > DONE_PUSH_THRESHOLD_MS;
			break;
		case 'token':
		case 'toolStart':
		case 'info':
		default:
			eligible = false;
			break;
	}
	if (!eligible) {
		return false;
	}
	if (lastPushAtMs === undefined) {
		return true;
	}
	return nowMs - lastPushAtMs >= PUSH_RATE_LIMIT_MS;
}
