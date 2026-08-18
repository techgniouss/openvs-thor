// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// `WorkspaceRoom`: one Durable Object per paired workspace. Deliberately does *not* extend the
// RPC-style `DurableObject` base class from `cloudflare:workers` — nothing here is called via
// Worker-to-DO RPC, only `fetch` and the hibernatable-WebSocket handlers, which are plain
// duck-typed methods Cloudflare's runtime looks for by name on whatever class `wrangler.jsonc`
// names. Avoiding that import is also what keeps this file free of a *value*-level dependency on
// an ambient-only module, so `scripts/test-room-relay.mjs` can import it directly under plain
// Node (see that file's own top-of-file doc) — every Workers-only runtime piece this file touches
// (`WebSocketPair`, `WebSocketRequestResponsePair`, the DO SQLite surface) is either behind a
// runtime feature-detect or reached only through methods a test can substitute a fake for.

import type { Env } from './index.ts';
import { applyMigrations } from './schema.ts';
import {
	generateCode, hashCode, isExpired, recordAttempt, exceededAttempts, INITIAL_ATTEMPTS,
	PAIRING_TTL_MS, type AttemptState,
} from './pairing.ts';
import { mintToken, verifyToken, hashForStorage, timingSafeEqualHex } from './tokens.ts';
import { buildVapidJwt, sendPayloadLessPush, type PushSubscriptionInfo } from './push.ts';
import { isEnvelope, isControlFrame, type Envelope, type ControlFrame, type PushFrame } from './protocol.ts';

/** WebSocket tag identifying the single host connection for this room. */
export const HOST_TAG = 'host';

/** Builds the tag a paired client device's socket is registered under. */
export function clientTag(deviceId: string): string {
	return `client:${deviceId}`;
}

/** Whether `tag` is the host tag. */
export function isHostTag(tag: string): boolean {
	return tag === HOST_TAG;
}

/** Whether `tag` is a client tag (`client:<deviceId>`). */
export function isClientTag(tag: string): boolean {
	return tag.startsWith('client:');
}

/**
 * Close code sent to the *displaced* host when a second `/ws/host` connection takes over. Per
 * the plan, the displaced host is not expected to retry on this code — the common case is a
 * reloaded VS Code window racing its own half-dead socket, and retrying would just re-trigger
 * the same takeover against the new connection.
 */
export const HOST_TAKEOVER_CLOSE_CODE = 4003;

/** Close code used when a device is revoked while connected. */
export const DEVICE_REVOKED_CLOSE_CODE = 4001;

/**
 * Pure fan-out decision for a `t: 'm'` app-message frame arriving from `fromTag`, given every
 * currently-connected tag. The host is the single source of truth broadcasting to every
 * connected client; a client's frame goes up to the host only. Never routes a frame back to its
 * own sender. Exported (and kept free of any DO/WebSocket dependency) specifically so
 * `test-room-relay.mjs` can assert the routing decision without standing up real sockets.
 */
export function routeAppMessage(fromTag: string, allTags: readonly string[]): readonly string[] {
	if (isHostTag(fromTag)) {
		return allTags.filter(tag => isClientTag(tag) && tag !== fromTag);
	}
	return allTags.filter(tag => isHostTag(tag) && tag !== fromTag);
}

/**
 * Given every currently-connected `{tag, socket}` entry, returns the sockets that must be closed
 * with {@link HOST_TAKEOVER_CLOSE_CODE} before/when a new host connection takes over — every
 * existing host-tagged socket. A one-line filter, but pulled out as its own exported, generic,
 * DO-free function (the same reasoning as {@link routeAppMessage}) so the takeover *decision* is
 * directly testable against a plain list of tags, without standing up a real Durable Object
 * state or WebSocket — see `test-room-relay.mjs`.
 */
export function socketsToDisplaceForNewHost<Socket>(entries: readonly { tag: string; socket: Socket }[]): readonly Socket[] {
	return entries.filter(e => isHostTag(e.tag)).map(e => e.socket);
}

/**
 * The `t: 'c'` ping/pong frames wired into `state.setWebSocketAutoResponse` in the constructor
 * below. Built from `protocol.ts`'s own `Envelope`/`ControlFrame` shapes rather than hand-typed
 * JSON, so a change to either shape cannot silently desync the heartbeat from the rest of the
 * protocol. `seq: 0` is deliberate: the auto-responder never touches per-direction sequencing,
 * so pretending otherwise here would be misleading.
 */
export const HEARTBEAT_PING_FRAME: Envelope = { v: 1, t: 'c', seq: 0, p: { c: 'ping' } };
export const HEARTBEAT_PONG_FRAME: Envelope = { v: 1, t: 'c', seq: 0, p: { c: 'pong' } };
export const HEARTBEAT_PING_JSON: string = JSON.stringify(HEARTBEAT_PING_FRAME);
export const HEARTBEAT_PONG_JSON: string = JSON.stringify(HEARTBEAT_PONG_FRAME);

/** How often the alarm sweeps expired pairing codes and dead push subscriptions. */
const ALARM_INTERVAL_MS = 5 * 60_000;

/** A push subscription is dropped after this many consecutive send failures. */
const DEAD_PUSH_FAILURE_THRESHOLD = 5;

/** How many rows `recordPending` keeps in the `pending` table — see that method's doc. */
const PENDING_ROW_LIMIT = 5;

/** Reads a `Bearer <token>` value out of a request's `Authorization` header, or `undefined`. */
function bearerToken(request: Request): string | undefined {
	const header = request.headers.get('Authorization');
	if (!header || !header.startsWith('Bearer ')) {
		return undefined;
	}
	return header.slice('Bearer '.length);
}

/** Per-connection identity, stashed via `serializeAttachment` so it survives hibernation/eviction — see this file's `webSocketMessage` for why the tag is read back from `getTags` rather than this attachment; the attachment carries the extra fields `getTags` cannot. */
interface SocketIdentity {
	readonly tag: string;
	readonly deviceId?: string;
	readonly connectedAt: number;
}

/**
 * One Durable Object per paired workspace ("room"). Holds every device, pairing code, and push
 * subscription for that workspace in its own SQLite storage (`schema.ts`), and relays `t: 'm'`
 * app-message frames between the single host connection and any number of paired client
 * connections without ever parsing their contents (see `webSocketMessage`).
 */
export class WorkspaceRoom {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	/**
	 * Per-code claim-attempt counters. Deliberately in-memory, not a SQLite column: attempts
	 * only need to survive the handful of seconds a human is retyping an 8-character code, and
	 * losing this counter to an eviction (which also drops any in-flight claim race) just resets
	 * a rate limit — a code past its {@link PAIRING_TTL_MS} TTL is unusable either way.
	 */
	private readonly pairingAttempts = new Map<string, AttemptState>();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		state.blockConcurrencyWhile(async () => {
			applyMigrations(state.storage.sql);
			const existingAlarm = await state.storage.getAlarm();
			if (existingAlarm === null) {
				await state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
			}
		});
		// Heartbeat: answered by the runtime's own auto-responder rather than `webSocketMessage`,
		// which — unlike a real message handler — does not wake a hibernated DO. `ping` arrives
		// every 25s from every connected socket regardless of activity, so routing it through
		// application logic would defeat hibernation for the one frame type most likely to be
		// the only traffic during a quiet stretch. Guarded by a feature-detect (rather than a bare
		// call) because `WebSocketRequestResponsePair` is a Workers-runtime-only global: real
		// deployments and `wrangler dev`/Miniflare provide it, but `test-room-relay.mjs` imports
		// this module under plain Node against a fake `DurableObjectState` and does not need (or
		// want) to stand up that global just to construct a `WorkspaceRoom` for its routing tests.
		if (typeof WebSocketRequestResponsePair !== 'undefined') {
			state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING_JSON, HEARTBEAT_PONG_JSON));
		}
	}

	// ---- HTTP entry point (index.ts forwards every room-scoped request here verbatim) ----

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case '/ws/host':
				return this.upgradeHost(request);
			case '/ws/client':
				return this.upgradeClient(request);
			case '/pair/claim':
				return request.method === 'POST' ? this.handlePairClaim(request) : new Response('method not allowed', { status: 405 });
			case '/api/push/subscribe':
				return request.method === 'POST' ? this.handlePushSubscribe(request) : new Response('method not allowed', { status: 405 });
			case '/api/pending':
				return request.method === 'GET' ? this.handlePending(request) : new Response('method not allowed', { status: 405 });
			case '/api/devices':
				return request.method === 'GET' ? this.handleDevices(request) : new Response('method not allowed', { status: 405 });
			default:
				return new Response('not found', { status: 404 });
		}
	}

	private async upgradeHost(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('expected websocket', { status: 426 });
		}
		const presented = bearerToken(request);
		if (!presented) {
			return new Response('missing host bearer token', { status: 401 });
		}
		if (!(await this.verifyOrClaimHostToken(presented))) {
			return new Response('host token mismatch', { status: 403 });
		}
		const pair = new WebSocketPair();
		const server = pair[1];
		// Exactly one host socket: close out any existing host-tagged connection *before*
		// accepting the new one. The common case is a reloaded VS Code window racing its own
		// half-dead socket, not two different machines fighting over the room. Uses the same
		// pure decision `displaceOtherHosts` does for the hello-frame path — see its doc.
		for (const existing of socketsToDisplaceForNewHost(this.state.getWebSockets(HOST_TAG).map(socket => ({ tag: HOST_TAG, socket })))) {
			existing.close(HOST_TAKEOVER_CLOSE_CODE, 'replaced by a new host connection');
		}
		this.state.acceptWebSocket(server, [HOST_TAG]);
		const identity: SocketIdentity = { tag: HOST_TAG, connectedAt: Date.now() };
		server.serializeAttachment(identity);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	/**
	 * TOFU (trust-on-first-use) host claim, per the plan's Auth step 2: the first bearer token
	 * ever presented to `/ws/host` is trusted and its hash stored; every later connection must
	 * present a token whose hash matches, via constant-time comparison.
	 */
	private async verifyOrClaimHostToken(presented: string): Promise<boolean> {
		const presentedHash = await hashForStorage(presented, this.env.RELAY_PEPPER);
		const row = this.state.storage.sql
			.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'hostTokenHash')
			.toArray()[0];
		if (!row) {
			this.state.storage.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?)', 'hostTokenHash', presentedHash);
			return true;
		}
		return timingSafeEqualHex(presentedHash, row.v);
	}

	private async upgradeClient(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('expected websocket', { status: 426 });
		}
		const url = new URL(request.url);
		const token = url.searchParams.get('token') ?? bearerToken(request);
		if (!token) {
			return new Response('missing device token', { status: 401 });
		}
		const roomId = url.searchParams.get('room') ?? '';
		const verified = await verifyToken(token, roomId, this.env.RELAY_PEPPER, id => this.lookupDeviceTokenHash(id));
		if (!verified) {
			return new Response('invalid device token', { status: 403 });
		}
		const device = this.getDeviceRevocation(verified.deviceId);
		if (!device || device.revokedAt !== null) {
			return new Response('device revoked', { status: 403 });
		}
		// The signed-nonce challenge from the plan's Auth step 5 (binding the connection to the
		// device's non-extractable ECDSA key, not just its bearer token) is deferred to Phase 7
		// per the plan's own staging ("ECDSA challenge if deferred") — bearer-token verification
		// alone is the Phase 4/5 baseline.
		const pair = new WebSocketPair();
		const server = pair[1];
		const tag = clientTag(verified.deviceId);
		this.state.acceptWebSocket(server, [tag]);
		const identity: SocketIdentity = { tag, deviceId: verified.deviceId, connectedAt: Date.now() };
		server.serializeAttachment(identity);
		const { firstConnect, name } = this.touchDeviceLastSeen(verified.deviceId);
		this.notifyHostDeviceConnected(verified.deviceId, name, firstConnect);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	/** `/pair/claim`: exchanges a still-valid, unused pairing code for a device token. Auth step 4. */
	private async handlePairClaim(request: Request): Promise<Response> {
		if (this.env.RELAY_SIGNUP_KEY && request.headers.get('X-Signup-Key') !== this.env.RELAY_SIGNUP_KEY) {
			return new Response('signup key required', { status: 403 });
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response('malformed json', { status: 400 });
		}
		const { code, pubkeyJwk, name } = (body ?? {}) as { code?: unknown; pubkeyJwk?: unknown; name?: unknown };
		if (typeof code !== 'string' || code.length === 0) {
			return new Response('missing code', { status: 400 });
		}
		const codeHash = await hashCode(code, this.env.RELAY_PEPPER);
		const row = this.state.storage.sql
			.exec<{ codeHash: string; expiresAt: number; usedAt: number | null }>(
				'SELECT codeHash, expiresAt, usedAt FROM pairing WHERE codeHash = ?', codeHash,
			)
			.toArray()[0];
		if (!row || row.usedAt !== null) {
			return new Response('invalid or already-used code', { status: 403 });
		}
		if (isExpired(row.expiresAt, Date.now())) {
			return new Response('code expired', { status: 403 });
		}
		const attempts = recordAttempt(this.pairingAttempts.get(codeHash) ?? INITIAL_ATTEMPTS);
		this.pairingAttempts.set(codeHash, attempts);
		if (exceededAttempts(attempts)) {
			return new Response('too many attempts', { status: 429 });
		}
		// Single-use: burn the code on the first structurally valid claim, even though the
		// caller below still has to succeed at minting — a code is a shared secret typed by a
		// human watching a QR/code screen, and letting it be retried after a *successful* claim
		// would defeat "single use" for no benefit (a failed mint has nothing to retry against;
		// the pairing flow starts over with a fresh `pair` control frame).
		this.state.storage.sql.exec('UPDATE pairing SET usedAt = ? WHERE codeHash = ?', Date.now(), codeHash);
		this.pairingAttempts.delete(codeHash);

		const deviceId = crypto.randomUUID();
		const roomId = new URL(request.url).searchParams.get('room') ?? '';
		const issuedAt = Date.now();
		const token = await mintToken(deviceId, roomId, issuedAt, this.env.RELAY_PEPPER);
		const tokenHash = await hashForStorage(`${roomId}|${token}`, this.env.RELAY_PEPPER);
		// lastSeenAt is left NULL here, not `issuedAt` — `touchDeviceLastSeen` is the only place
		// that ever sets it, and it reads "was this NULL beforehand" to decide `firstConnect` for
		// the `deviceConnected` notice (Auth step 6). Seeding it at claim time would make every
		// device's actual first `/ws/client` connect look like an ordinary reconnect.
		this.state.storage.sql.exec(
			'INSERT INTO device (id, name, tokenHash, pubkeyJwk, createdAt, lastSeenAt, revokedAt) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
			deviceId,
			typeof name === 'string' && name.length > 0 ? name : 'Unnamed device',
			tokenHash,
			JSON.stringify(pubkeyJwk ?? null),
			issuedAt,
		);
		return new Response(JSON.stringify({ deviceId, token }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}

	/** `/api/push/subscribe`: registers a device's Web Push subscription. Requires a valid device token. */
	private async handlePushSubscribe(request: Request): Promise<Response> {
		const token = bearerToken(request);
		if (!token) {
			return new Response('missing device token', { status: 401 });
		}
		const roomId = new URL(request.url).searchParams.get('room') ?? '';
		const verified = await verifyToken(token, roomId, this.env.RELAY_PEPPER, id => this.lookupDeviceTokenHash(id));
		if (!verified) {
			return new Response('invalid device token', { status: 403 });
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response('malformed json', { status: 400 });
		}
		const sub = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
		if (typeof sub.endpoint !== 'string' || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
			return new Response('malformed subscription', { status: 400 });
		}
		this.state.storage.sql.exec(
			'INSERT INTO push (deviceId, endpoint, p256dh, auth, createdAt, failureCount) VALUES (?, ?, ?, ?, ?, 0)',
			verified.deviceId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now(),
		);
		return new Response(null, { status: 204 });
	}

	/**
	 * `/api/pending`: what the service worker fetches after waking on a payload-less push.
	 * Phase 6b: answers with the most recent row(s) `raisePush`/`recordPending` stored, in the
	 * exact shape `pwa/sw.js`'s `push` handler reads (`data.pending[0].title/body/tag`). Devices
	 * do not get per-device pending state in this design — the relay never learns which client
	 * dismissed what, so every authenticated device asking this endpoint sees the same latest
	 * event. That is an accepted simplification for this phase, not a bug: a real per-device
	 * "seen" cursor is more machinery than a payload-less, at-most-one-notification design needs
	 * right now, and can be added later without changing this endpoint's shape.
	 */
	private async handlePending(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const token = bearerToken(request) ?? url.searchParams.get('token');
		if (!token) {
			return new Response('missing device token', { status: 401 });
		}
		const roomId = url.searchParams.get('room') ?? '';
		const verified = await verifyToken(token, roomId, this.env.RELAY_PEPPER, id => this.lookupDeviceTokenHash(id));
		if (!verified) {
			return new Response('invalid device token', { status: 403 });
		}
		const rows = this.state.storage.sql
			.exec<{ title: string; body: string; tag: string; sessionId: string }>(
				'SELECT title, body, tag, sessionId FROM pending ORDER BY id DESC LIMIT 1',
			)
			.toArray();
		return new Response(JSON.stringify({ pending: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}

	private async lookupDeviceTokenHash(deviceId: string): Promise<string | undefined> {
		const row = this.state.storage.sql
			.exec<{ tokenHash: string }>('SELECT tokenHash FROM device WHERE id = ?', deviceId)
			.toArray()[0];
		return row?.tokenHash;
	}

	private getDeviceRevocation(deviceId: string): { revokedAt: number | null } | undefined {
		return this.state.storage.sql
			.exec<{ revokedAt: number | null }>('SELECT revokedAt FROM device WHERE id = ?', deviceId)
			.toArray()[0];
	}

	/**
	 * Updates a device's `lastSeenAt` to now and reports whether this was its first-ever connect.
	 * Read-then-write rather than a single statement: `handlePairClaim` leaves `lastSeenAt` NULL
	 * when a device is created, and this method is the only place that ever sets it, so "was it
	 * NULL immediately before this call" is exactly "is this the device's first successful
	 * `/ws/client` connect" — the distinction the `deviceConnected` notice's `firstConnect` needs
	 * (Auth step 6). Also returns the device's stored `name` (see `handlePairClaim`'s insert),
	 * which that same notice carries and which callers would otherwise have to look up separately.
	 */
	private touchDeviceLastSeen(deviceId: string): { firstConnect: boolean; name: string } {
		const row = this.state.storage.sql
			.exec<{ name: string; lastSeenAt: number | null }>('SELECT name, lastSeenAt FROM device WHERE id = ?', deviceId)
			.toArray()[0];
		this.state.storage.sql.exec('UPDATE device SET lastSeenAt = ? WHERE id = ?', Date.now(), deviceId);
		return { firstConnect: row !== undefined && row.lastSeenAt === null, name: row?.name ?? 'Unnamed device' };
	}

	/**
	 * Sends a `deviceConnected` notice directly to the currently-connected host socket(s), if any —
	 * Auth step 6's "new device notice", raised from `upgradeClient` right after a device's connect
	 * is authenticated and its `lastSeenAt` touched. There is deliberately no offline queue for
	 * this: if no host socket is connected right now (the desktop extension isn't running, or
	 * hasn't reconnected yet), the notice is simply not delivered and nothing is stored to redeliver
	 * it later. That is an accepted gap, not a bug — per the plan, the relay keeps no offline queue
	 * for anything, and `GET /api/devices` is always available as the source of truth the host can
	 * consult on its next connect regardless of whether it caught this notice live.
	 */
	private notifyHostDeviceConnected(deviceId: string, name: string, firstConnect: boolean): void {
		const hostSockets = this.state.getWebSockets(HOST_TAG);
		if (hostSockets.length === 0) {
			return;
		}
		const frame: Envelope = { v: 1, t: 'c', seq: 0, p: { c: 'deviceConnected', deviceId, name, firstConnect } };
		const json = JSON.stringify(frame);
		for (const ws of hostSockets) {
			ws.send(json);
		}
	}

	/**
	 * `GET /api/devices`: host-only device list — without this there was no way to discover a
	 * `deviceId` to hand `revoke` (Auth steps 7/8's revocation and Phase 7c's future
	 * `deviceTokenDays`/`idleDisableHours` enforcement both need it). Auth reuses
	 * {@link verifyOrClaimHostToken} rather than {@link verifyToken}'s device-token path — a paired
	 * device must never be able to enumerate other devices in its own room, only the desktop host
	 * may. `pubkeyJwk`/`tokenHash` are deliberately excluded from the response; they never leave the
	 * DO (see `schema.ts`'s doc on the `device` table).
	 */
	private async handleDevices(request: Request): Promise<Response> {
		const presented = bearerToken(request);
		if (!presented) {
			return new Response('missing host bearer token', { status: 401 });
		}
		if (!(await this.verifyOrClaimHostToken(presented))) {
			return new Response('host token mismatch', { status: 403 });
		}
		const rows = this.state.storage.sql
			.exec<{ id: string; name: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null }>(
				'SELECT id, name, createdAt, lastSeenAt, revokedAt FROM device ORDER BY createdAt DESC',
			)
			.toArray();
		return new Response(JSON.stringify({ devices: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}

	// ---- Hibernatable WebSocket handlers ----

	/**
	 * Routes an incoming frame. `t: 'm'` app-message frames are never parsed — only relayed, per
	 * the plan's "the DO never parses app payloads" rule — because the relay must not become a
	 * second place that has to be kept honest about the extension↔webview message vocabulary.
	 * `t: 'c'` control frames are the DO's own business and are dispatched by verb below.
	 */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== 'string') {
			return; // this protocol is text-frame-only; a stray binary frame is ignored, not fatal.
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		if (!isEnvelope(parsed)) {
			return;
		}
		const tags = this.state.getTags(ws);
		const myTag = tags[0] ?? '';
		if (parsed.t === 'm') {
			this.relayAppMessage(myTag, message);
			return;
		}
		if (parsed.t === 'c' && isControlFrame(parsed.p)) {
			await this.handleControlFrame(ws, myTag, parsed.p);
		}
		// `t: 'a'` bare acks: Phase 5's `coalescer.ts`/`snapshot.ts` own replay-ring bookkeeping
		// on the extension side; the relay itself stays per-message stateless (no offline queue,
		// per the plan), so there is nothing for the DO to do with a bare ack.
	}

	private relayAppMessage(fromTag: string, raw: string): void {
		const sockets = this.state.getWebSockets();
		const targets = new Set(routeAppMessage(fromTag, sockets.map(ws => this.state.getTags(ws)[0] ?? '')));
		for (const ws of sockets) {
			const tag = this.state.getTags(ws)[0] ?? '';
			if (targets.has(tag)) {
				ws.send(raw);
			}
		}
	}

	private async handleControlFrame(ws: WebSocket, tag: string, frame: ControlFrame): Promise<void> {
		switch (frame.c) {
			case 'hello': {
				if (frame.role === 'host') {
					this.displaceOtherHosts(ws);
				}
				// Answers the hello per `WelcomeFrame`'s own doc ("Answers a hello, confirming the
				// connection is live"). Both the host (`socket.ts`'s `connect()`) and the PWA
				// (`pwa/app.js`'s `connect()`) gate their bootstrap on receiving this — the host
				// sends its own `hello` unconditionally but doesn't wait on the reply, while the PWA
				// sends nothing at all until `welcome` arrives (`case 'welcome':` is what fires its
				// first `ready`/`listSkills`/`listMcp`). Replay-from-`lastSeq` (the plan's `resume`/
				// `snapshotNeeded` pair) isn't built yet, so `lastSeq: 0` always means "start fresh";
				// nothing currently reads it as anything else.
				const welcome: Envelope = { v: 1, t: 'c', seq: 0, p: { c: 'welcome', lastSeq: 0 } };
				ws.send(JSON.stringify(welcome));
				return;
			}
			case 'pair':
				if (isHostTag(tag)) {
					await this.mintPairingCode(ws);
				}
				return;
			case 'revoke':
				if (isHostTag(tag)) {
					await this.revokeDevice(frame.deviceId);
					// See `RevokedFrame`'s own doc: without this ack, the host had no way to tell
					// a `revoke` that had actually landed apart from one still in flight, and a
					// device-list refresh sent right after could race it.
					const revoked: Envelope = { v: 1, t: 'c', seq: 0, p: { c: 'revoked', deviceId: frame.deviceId } };
					ws.send(JSON.stringify(revoked));
				}
				return;
			case 'push':
				if (isHostTag(tag)) {
					await this.raisePush(frame);
				}
				return;
			case 'bye':
				ws.close(1000, frame.reason ?? 'bye');
				return;
			case 'resume':
			case 'snapshotNeeded':
			case 'ping':
			case 'pong':
			case 'welcome':
			case 'paired':
			case 'revoked':
			case 'deviceConnected':
				// `resume`/`snapshotNeeded` (replay-from-`lastSeq`) are genuinely not built yet —
				// see the `hello` case's own doc — and belong to Phase 5's extension-side
				// `socket.ts` for reconnect bookkeeping the DO does not need to referee; auth is
				// already settled at WS-upgrade time (`upgradeHost`/`upgradeClient`). `ping`/`pong`
				// never reach here at all (the constructor's auto-response answers them without
				// waking a hibernated DO); accepted-but-inert here only so a stray one from a
				// client that raced the auto-responder doesn't close the connection. `welcome`,
				// `paired`, `revoked` and `deviceConnected` are all DO→peer frames, never received
				// back.
				return;
			default: {
				const unreachable: never = frame;
				void unreachable;
			}
		}
	}

	/**
	 * Closes every *other* host-tagged socket with {@link HOST_TAKEOVER_CLOSE_CODE}. Called both
	 * at connect time (`upgradeHost`, the common path — a fresh `/ws/host` upgrade) and whenever a
	 * `hello{role:'host'}` frame arrives on an already-accepted socket, so a protocol that settles
	 * role via an explicit hello handshake rather than the URL path stays single-host too. The
	 * decision itself is the exported pure {@link socketsToDisplaceForNewHost} — this method is
	 * just "look up who's connected, call it, close what it says".
	 */
	private displaceOtherHosts(newHost: WebSocket): void {
		const entries = this.state.getWebSockets().map(socket => ({ tag: this.state.getTags(socket)[0] ?? '', socket }));
		for (const existing of socketsToDisplaceForNewHost(entries)) {
			if (existing !== newHost) {
				existing.close(HOST_TAKEOVER_CLOSE_CODE, 'replaced by a new host connection');
			}
		}
	}

	private async mintPairingCode(ws: WebSocket): Promise<void> {
		const randomBytes = new Uint8Array(8);
		crypto.getRandomValues(randomBytes);
		const code = generateCode(randomBytes);
		const codeHash = await hashCode(code, this.env.RELAY_PEPPER);
		const expiresAt = Date.now() + PAIRING_TTL_MS;
		this.state.storage.sql.exec('INSERT OR REPLACE INTO pairing (codeHash, expiresAt, usedAt) VALUES (?, ?, NULL)', codeHash, expiresAt);
		this.pairingAttempts.set(codeHash, INITIAL_ATTEMPTS);
		const paired: Envelope = { v: 1, t: 'c', seq: 0, p: { c: 'paired', code, expiresAt } };
		ws.send(JSON.stringify(paired));
	}

	private async revokeDevice(deviceId: string): Promise<void> {
		this.state.storage.sql.exec('UPDATE device SET revokedAt = ? WHERE id = ?', Date.now(), deviceId);
		this.state.storage.sql.exec('DELETE FROM push WHERE deviceId = ?', deviceId);
		for (const ws of this.state.getWebSockets(clientTag(deviceId))) {
			ws.close(DEVICE_REVOKED_CLOSE_CODE, 'revoked');
		}
	}

	/**
	 * Raises a payload-less Web Push for every subscription currently registered in this room.
	 * The *decision* of whether an event warrants a push (`push.ts`'s `shouldPush`) is made
	 * host-side, before the `push` control frame is ever sent — per the plan, "push must be an
	 * explicit control frame" precisely so the relay does not need its own copy of that policy.
	 *
	 * Records `frame` into the `pending` table unconditionally, even when VAPID isn't configured
	 * (the early return just below) — `/api/pending` should answer honestly from whatever the
	 * host actually asked to raise, independent of whether this particular deployment can also
	 * reach a push service.
	 */
	private async raisePush(frame: PushFrame): Promise<void> {
		this.recordPending(frame);
		if (!this.env.VAPID_PRIVATE || !this.env.VAPID_PUBLIC || !this.env.VAPID_SUBJECT) {
			return;
		}
		let privateKeyJwk: JsonWebKey;
		try {
			privateKeyJwk = JSON.parse(this.env.VAPID_PRIVATE) as JsonWebKey;
		} catch {
			return;
		}
		const subs = this.state.storage.sql
			.exec<{ deviceId: string; endpoint: string; p256dh: string; auth: string }>(
				'SELECT deviceId, endpoint, p256dh, auth FROM push',
			)
			.toArray();
		for (const sub of subs) {
			const subscription: PushSubscriptionInfo = { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth };
			try {
				const audience = new URL(sub.endpoint).origin;
				const jwt = await buildVapidJwt(privateKeyJwk, this.env.VAPID_PUBLIC, audience, this.env.VAPID_SUBJECT, Date.now());
				const res = await sendPayloadLessPush(subscription, jwt, this.env.VAPID_PUBLIC);
				if (!res.ok) {
					this.markPushFailure(sub.deviceId, sub.endpoint);
				}
			} catch {
				this.markPushFailure(sub.deviceId, sub.endpoint);
			}
		}
	}

	/**
	 * Stores `frame`'s content as the room's latest pending event, then prunes back down to
	 * {@link PENDING_ROW_LIMIT} rows — one row is really all `/api/pending` ever reads (see its
	 * doc), but a couple of extras cost nothing and give a little slack if two pushes land in
	 * quick succession. Pruned here, inline, rather than added to the alarm's own sweep: the
	 * alarm runs every 5 minutes, which is far looser than this table needs to stay bounded
	 * under.
	 */
	private recordPending(frame: PushFrame): void {
		this.state.storage.sql.exec(
			'INSERT INTO pending (title, body, tag, sessionId, createdAt) VALUES (?, ?, ?, ?, ?)',
			frame.title, frame.body, frame.tag, frame.sessionId, Date.now(),
		);
		this.state.storage.sql.exec(
			'DELETE FROM pending WHERE id NOT IN (SELECT id FROM pending ORDER BY id DESC LIMIT ?)',
			PENDING_ROW_LIMIT,
		);
	}

	private markPushFailure(deviceId: string, endpoint: string): void {
		this.state.storage.sql.exec(
			'UPDATE push SET failureCount = failureCount + 1 WHERE deviceId = ? AND endpoint = ?', deviceId, endpoint,
		);
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
		// Tag bookkeeping is owned by the runtime's hibernatable-WebSocket support — once a
		// socket closes it simply stops appearing in `state.getWebSockets()`, so there is nothing
		// keyed by this specific socket to clean up by hand. Kept as an explicit handler (rather
		// than omitted) so a later phase has an obvious place to hang a closing side effect (e.g.
		// notifying the host that a device disconnected) without hunting for where it belongs.
		void ws; void code; void reason; void wasClean;
	}

	webSocketError(ws: WebSocket, error: unknown): void {
		void ws; void error;
	}

	/** Sweeps expired/used pairing codes and push subscriptions that have failed repeatedly. Reschedules itself. */
	async alarm(): Promise<void> {
		const now = Date.now();
		this.state.storage.sql.exec('DELETE FROM pairing WHERE expiresAt < ? OR usedAt IS NOT NULL', now);
		this.pairingAttempts.clear();
		this.state.storage.sql.exec('DELETE FROM push WHERE failureCount >= ?', DEAD_PUSH_FAILURE_THRESHOLD);
		await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
	}
}
