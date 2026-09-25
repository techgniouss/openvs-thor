/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { Duplex } from 'stream';
import { acceptUpgrade, rejectUpgrade, WsConnection } from './websocket';

/**
 * The relay, run inside the extension host instead of on Cloudflare's edge — "local hosting"
 * mode. It speaks exactly the protocol `openvs-relay/src/room.ts` does (same paths, envelope,
 * control frames, token format and close codes), so the phone app and `socket.ts` cannot tell
 * the two apart; `cloudflared` (see `tunnel.ts`) is what makes it reachable from a phone.
 *
 * Two things are deliberately stricter than the cloud relay, because here the machine running
 * the relay *is* the host:
 *  - Only rooms the extension registered ({@link LocalRelay.registerRoom}) exist. The cloud
 *    relay creates a room for any id on first use; a tunnel URL is public, and nothing here
 *    should let a stranger use this machine to relay their own traffic.
 *  - The host endpoints (`/ws/host`, `/api/devices`) refuse anything that came through the
 *    tunnel. cloudflared stamps every request it forwards with `Cf-Connecting-Ip`; the
 *    extension itself dials `127.0.0.1` directly and never carries it.
 *
 * Web Push is not offered: the phone app never subscribes (no `pushManager` call exists in
 * `openvs-relay/pwa`), so the cloud relay's push endpoints have no caller to serve.
 *
 * `vscode`-free (state goes through an injected {@link RelayStore}) so
 * `scripts/test-local-relay.mjs` runs it for real under plain Node.
 */

/** Mirrors `openvs-relay/src/room.ts`. */
const HOST_TAKEOVER_CLOSE_CODE = 4003;
/** Mirrors `openvs-relay/src/room.ts`. */
const DEVICE_REVOKED_CLOSE_CODE = 4001;
/** Mirrors `openvs-relay/src/pairing.ts`. */
const PAIRING_TTL_MS = 120_000;
/** Mirrors `openvs-relay/src/pairing.ts`. */
const MAX_PAIRING_ATTEMPTS = 5;
/**
 * Wrong pairing codes a room tolerates before every live code for it is withdrawn. Counted
 * per room, because a wrong guess matches no code entry: the per-code attempt count never saw
 * it, so nothing at all limited guessing through the public tunnel. Ten is far past any
 * typing mistake; the host simply shows a new code.
 */
const MAX_FAILED_CLAIMS = 10;
/** Mirrors `openvs-relay/src/pairing.ts` — Crockford base32 minus the ambiguous I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Mirrors `openvs-relay/src/room.ts`'s `HEARTBEAT_PONG_JSON`. */
const PONG_JSON = JSON.stringify({ v: 1, t: 'c', seq: 0, p: { c: 'pong' } });
/** The largest request body read (a pairing claim is a few dozen bytes). */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Sent with the phone app, which is served on a public tunnel URL and can approve the agent's
 * writes and commands: no framing by another site (a clickjacked Approve), no content-type
 * sniffing, and no referrer carrying the room id off-site.
 */
const STATIC_SECURITY_HEADERS: Record<string, string> = {
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy': "frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
};

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.webmanifest': 'application/manifest+json',
	'.json': 'application/json',
};

/** A paired device, as persisted. Only the token's hash is ever stored. */
export interface DeviceRecord {
	readonly id: string;
	readonly name: string;
	readonly tokenHash: string;
	readonly createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

/** Everything the relay persists — per room, its paired devices. */
export interface RelayState {
	rooms: Record<string, { devices: DeviceRecord[] }>;
}

/** Where {@link LocalRelay} keeps its state between restarts. */
export interface RelayStore {
	load(): RelayState;
	save(state: RelayState): void;
}

/** A {@link RelayStore} backed by one JSON file, written atomically (temp file + rename). */
export function fileStore(file: string): RelayStore {
	return {
		load() {
			try {
				const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RelayState;
				return parsed && typeof parsed.rooms === 'object' && parsed.rooms ? parsed : { rooms: {} };
			} catch {
				return { rooms: {} };
			}
		},
		save(state) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const temp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(temp, JSON.stringify(state, null, '\t'));
			fs.renameSync(temp, file);
		},
	};
}

/** An in-memory {@link RelayStore}, for tests. */
export function memoryStore(): RelayStore {
	let state: RelayState = { rooms: {} };
	return {
		load: () => JSON.parse(JSON.stringify(state)) as RelayState,
		save: next => { state = JSON.parse(JSON.stringify(next)) as RelayState; },
	};
}

export interface LocalRelayOptions {
	/** The phone app's static files — `openvs-relay/pwa`, shipped inside this extension as `relay-pwa/`. */
	readonly pwaDir: string;
	/** HMAC key for pairing codes and device tokens. Must stay the same across restarts, or every paired device is refused. */
	readonly pepper: string;
	readonly store: RelayStore;
	/** `0` (the default) picks a free port. */
	readonly port?: number;
	readonly now?: () => number;
}

interface Peer {
	readonly conn: WsConnection;
	readonly room: string;
	readonly role: 'host' | 'client';
	readonly deviceId?: string;
}

interface PairingCode {
	readonly expiresAt: number;
	attempts: number;
}

function hmacHex(pepper: string, value: string): string {
	return createHmac('sha256', pepper).update(value).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
	return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function bearer(req: http.IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/** Whether a request arrived through the Cloudflare tunnel rather than from this machine directly. */
function viaTunnel(req: http.IncomingMessage): boolean {
	return req.headers['cf-connecting-ip'] !== undefined || req.headers['cf-ray'] !== undefined;
}

function reply(res: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
	res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
	res.end(body);
}

/** The relay server. See the file doc. */
export class LocalRelay {
	private server?: http.Server;
	private readonly peers = new Set<Peer>();
	private readonly state: RelayState;
	/** Registered rooms: public room id → HMAC of its host token. */
	private readonly rooms = new Map<string, string>();
	/** Live pairing codes: `<room>|<codeHash>` → expiry/attempts. In memory on purpose — a code outlives nothing longer than two minutes. */
	private readonly codes = new Map<string, PairingCode>();
	/** Wrong codes presented per room since its codes were last minted; see {@link MAX_FAILED_CLAIMS}. */
	private readonly failedClaims = new Map<string, number>();
	private readonly now: () => number;
	private listeningPort = 0;

	constructor(private readonly options: LocalRelayOptions) {
		this.now = options.now ?? Date.now;
		this.state = options.store.load();
	}

	/** The port actually listened on (after {@link start}). */
	get port(): number {
		return this.listeningPort;
	}

	/** Allows a room to exist, owned by whoever presents `hostToken` — the extension's own derived token. */
	registerRoom(roomId: string, hostToken: string): void {
		this.rooms.set(roomId, hmacHex(this.options.pepper, `host|${hostToken}`));
		this.state.rooms[roomId] ??= { devices: [] };
	}

	/** Starts listening on loopback only — the tunnel connects locally, and nothing else should. */
	start(): Promise<number> {
		const server = http.createServer((req, res) => void this.handleRequest(req, res).catch(() => {
			if (!res.headersSent) {
				reply(res, 500, 'internal error');
			}
		}));
		server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(this.options.port ?? 0, '127.0.0.1', () => {
				server.off('error', reject);
				const address = server.address();
				this.listeningPort = typeof address === 'object' && address ? address.port : 0;
				resolve(this.listeningPort);
			});
		});
	}

	/** Closes every connection and stops listening. */
	stop(): Promise<void> {
		for (const peer of [...this.peers]) {
			peer.conn.close(1001, 'relay stopping');
		}
		this.peers.clear();
		const server = this.server;
		this.server = undefined;
		return new Promise(resolve => {
			if (!server) {
				resolve();
				return;
			}
			server.close(() => resolve());
			server.closeAllConnections?.();
		});
	}

	// ---- HTTP ----------------------------------------------------------------------------

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === '/pair/claim' && req.method === 'POST') {
			return this.handleClaim(req, res, url.searchParams.get('room') ?? '');
		}
		if (url.pathname === '/api/devices' && req.method === 'GET') {
			return this.handleDevices(req, res, url.searchParams.get('room') ?? '');
		}
		if (url.pathname === '/api/pending') {
			// Only a push wake-up reads this, and nothing here raises pushes — see the file doc.
			reply(res, 200, JSON.stringify({ pending: [] }), 'application/json');
			return;
		}
		if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
			reply(res, 404, 'not found');
			return;
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			reply(res, 405, 'method not allowed');
			return;
		}
		this.serveStatic(url.pathname, res);
	}

	/** Serves the phone app; any path that isn't a file gets `index.html` (it routes itself from the URL, like the cloud relay's single-page-application assets). */
	private serveStatic(pathname: string, res: http.ServerResponse): void {
		const root = path.resolve(this.options.pwaDir);
		let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
		if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
			file = path.join(root, 'index.html');
		}
		let body: Buffer;
		try {
			body = fs.readFileSync(file);
		} catch {
			reply(res, 404, 'not found');
			return;
		}
		// `no-cache`, not `no-store`: the phone's service worker revalidates every load, so a new
		// release of the app is picked up on the next open, never a stale cached script.
		res.writeHead(200, {
			'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
			'Cache-Control': 'no-cache',
			...STATIC_SECURITY_HEADERS,
		});
		res.end(body);
	}

	private readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let size = 0;
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					reject(new Error('body too large'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	/** `/pair/claim`: exchanges a live pairing code for a device token — `room.ts`'s `handlePairClaim`. */
	private async handleClaim(req: http.IncomingMessage, res: http.ServerResponse, roomId: string): Promise<void> {
		if (!this.rooms.has(roomId)) {
			reply(res, 404, 'unknown room');
			return;
		}
		let body: { code?: unknown; name?: unknown };
		try {
			body = JSON.parse(await this.readBody(req)) ?? {};
		} catch {
			reply(res, 400, 'malformed json');
			return;
		}
		if (typeof body.code !== 'string' || !body.code) {
			reply(res, 400, 'missing code');
			return;
		}
		const key = `${roomId}|${hmacHex(this.options.pepper, body.code.trim().toUpperCase())}`;
		const code = this.codes.get(key);
		if (!code) {
			const failures = (this.failedClaims.get(roomId) ?? 0) + 1;
			this.failedClaims.set(roomId, failures);
			if (failures >= MAX_FAILED_CLAIMS) {
				this.withdrawCodes(roomId);
				reply(res, 429, 'too many wrong codes — ask for a new pairing code');
				return;
			}
			reply(res, 403, 'invalid or already-used code');
			return;
		}
		if (this.now() >= code.expiresAt) {
			this.codes.delete(key);
			reply(res, 403, 'code expired');
			return;
		}
		code.attempts++;
		if (code.attempts > MAX_PAIRING_ATTEMPTS) {
			this.codes.delete(key);
			reply(res, 429, 'too many attempts');
			return;
		}
		this.codes.delete(key);
		const deviceId = randomUUID();
		const issuedAt = this.now();
		const token = `${deviceId}.${createHmac('sha256', this.options.pepper).update(`${deviceId}|${roomId}|${issuedAt}`).digest('base64url')}`;
		this.state.rooms[roomId].devices.push({
			id: deviceId,
			name: typeof body.name === 'string' && body.name ? body.name.slice(0, 80) : 'Unnamed device',
			tokenHash: hmacHex(this.options.pepper, `${roomId}|${token}`),
			createdAt: issuedAt,
			lastSeenAt: null,
			revokedAt: null,
		});
		this.save();
		reply(res, 200, JSON.stringify({ deviceId, token }), 'application/json');
	}

	/** `/api/devices`: the host's device list — `room.ts`'s `handleDevices`. */
	private handleDevices(req: http.IncomingMessage, res: http.ServerResponse, roomId: string): void {
		if (viaTunnel(req)) {
			reply(res, 403, 'host endpoints are local only');
			return;
		}
		if (!this.isHost(roomId, bearer(req))) {
			reply(res, 403, 'host token mismatch');
			return;
		}
		const devices = [...this.state.rooms[roomId].devices]
			.sort((a, b) => b.createdAt - a.createdAt)
			.map(({ id, name, createdAt, lastSeenAt, revokedAt }) => ({ id, name, createdAt, lastSeenAt, revokedAt }));
		reply(res, 200, JSON.stringify({ devices }), 'application/json');
	}

	private isHost(roomId: string, presented: string | undefined): boolean {
		const expected = this.rooms.get(roomId);
		return !!expected && !!presented && safeEqualHex(hmacHex(this.options.pepper, `host|${presented}`), expected);
	}

	/** The device a token authenticates in `roomId`, if it is valid and not revoked. */
	private verifyDevice(roomId: string, token: string): DeviceRecord | undefined {
		const dot = token.indexOf('.');
		if (dot <= 0 || !this.state.rooms[roomId]) {
			return undefined;
		}
		const device = this.state.rooms[roomId].devices.find(d => d.id === token.slice(0, dot));
		if (!device || device.revokedAt !== null) {
			return undefined;
		}
		return safeEqualHex(hmacHex(this.options.pepper, `${roomId}|${token}`), device.tokenHash) ? device : undefined;
	}

	private save(): void {
		try {
			this.options.store.save(this.state);
		} catch (err) {
			console.warn('OpenVS local relay: could not save relay state.', err);
		}
	}

	// ---- WebSockets ----------------------------------------------------------------------

	private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const roomId = url.searchParams.get('room') ?? '';
		if (url.pathname === '/ws/host') {
			if (viaTunnel(req)) {
				rejectUpgrade(socket, 403, 'host endpoints are local only');
				return;
			}
			if (!this.isHost(roomId, bearer(req))) {
				rejectUpgrade(socket, 403, 'host token mismatch');
				return;
			}
			// One host per room — a reloaded window replaces its own half-dead socket.
			for (const peer of this.peersOf(roomId, 'host')) {
				peer.conn.close(HOST_TAKEOVER_CLOSE_CODE, 'replaced by a new host connection');
			}
			this.attach(req, socket, head, { room: roomId, role: 'host' });
			this.broadcastHostStatus(roomId, true);
			return;
		}
		if (url.pathname === '/ws/client') {
			const device = this.verifyDevice(roomId, url.searchParams.get('token') ?? bearer(req) ?? '');
			if (!device) {
				rejectUpgrade(socket, 403, 'invalid or revoked device token');
				return;
			}
			const firstConnect = device.lastSeenAt === null;
			device.lastSeenAt = this.now();
			this.save();
			this.attach(req, socket, head, { room: roomId, role: 'client', deviceId: device.id });
			this.sendControl(this.peersOf(roomId, 'host'), { c: 'deviceConnected', deviceId: device.id, name: device.name, firstConnect });
			return;
		}
		rejectUpgrade(socket, 404, 'not found');
	}

	private attach(req: http.IncomingMessage, socket: Duplex, head: Buffer, identity: Omit<Peer, 'conn'>): void {
		let peer: Peer | undefined;
		const conn = acceptUpgrade(req, socket, head, {
			onMessage: text => { if (peer) { this.handleMessage(peer, text); } },
			onClose: () => { if (peer) { this.detach(peer); } },
		});
		if (conn) {
			peer = { ...identity, conn };
			this.peers.add(peer);
		}
	}

	private detach(peer: Peer): void {
		if (!this.peers.delete(peer)) {
			return;
		}
		if (peer.role === 'host' && this.peersOf(peer.room, 'host').length === 0) {
			this.broadcastHostStatus(peer.room, false);
		}
	}

	private peersOf(roomId: string, role: Peer['role']): Peer[] {
		return [...this.peers].filter(p => p.room === roomId && p.role === role && p.conn.isOpen);
	}

	private sendControl(targets: Peer[], frame: Record<string, unknown>): void {
		const json = JSON.stringify({ v: 1, t: 'c', seq: 0, p: frame });
		for (const peer of targets) {
			peer.conn.send(json);
		}
	}

	private broadcastHostStatus(roomId: string, online: boolean): void {
		this.sendControl(this.peersOf(roomId, 'client'), { c: 'hostStatus', online });
	}

	/** Routes one frame — `room.ts`'s `webSocketMessage`. App messages are relayed verbatim, never parsed beyond the envelope. */
	private handleMessage(peer: Peer, raw: string): void {
		let env: { v?: unknown; t?: unknown; seq?: unknown; p?: { c?: unknown; deviceId?: unknown; reason?: unknown } };
		try {
			env = JSON.parse(raw);
		} catch {
			return;
		}
		if (!env || env.v !== 1 || typeof env.seq !== 'number') {
			return;
		}
		if (env.t === 'm') {
			const targets = peer.role === 'host' ? this.peersOf(peer.room, 'client') : this.peersOf(peer.room, 'host');
			for (const target of targets) {
				target.conn.send(raw);
			}
			return;
		}
		if (env.t !== 'c' || !env.p || typeof env.p.c !== 'string') {
			return;
		}
		switch (env.p.c) {
			case 'ping':
				peer.conn.send(PONG_JSON);
				return;
			case 'hello':
				this.sendControl([peer], peer.role === 'host'
					? { c: 'welcome', lastSeq: 0 }
					: { c: 'welcome', lastSeq: 0, hostOnline: this.peersOf(peer.room, 'host').length > 0 });
				return;
			case 'pair':
				if (peer.role === 'host') {
					this.mintCode(peer);
				}
				return;
			case 'revoke':
				if (peer.role === 'host' && typeof env.p.deviceId === 'string') {
					this.revoke(peer.room, env.p.deviceId);
					this.sendControl([peer], { c: 'revoked', deviceId: env.p.deviceId });
				}
				return;
			case 'bye':
				peer.conn.close(1000, typeof env.p.reason === 'string' ? env.p.reason : 'bye');
				return;
			default:
				// `push` (no push here — see the file doc) and peer-bound frames: inert.
				return;
		}
	}

	private mintCode(host: Peer): void {
		const bytes = randomBytes(8);
		let code = '';
		for (const byte of bytes) {
			code += ALPHABET[byte % ALPHABET.length];
		}
		const expiresAt = this.now() + PAIRING_TTL_MS;
		this.failedClaims.delete(host.room);
		this.codes.set(`${host.room}|${hmacHex(this.options.pepper, code)}`, { expiresAt, attempts: 0 });
		this.sendControl([host], { c: 'paired', code, expiresAt });
	}

	/** Invalidates every live pairing code for `roomId`. */
	private withdrawCodes(roomId: string): void {
		for (const key of [...this.codes.keys()]) {
			if (key.startsWith(`${roomId}|`)) {
				this.codes.delete(key);
			}
		}
	}

	private revoke(roomId: string, deviceId: string): void {
		const device = this.state.rooms[roomId]?.devices.find(d => d.id === deviceId);
		if (device && device.revokedAt === null) {
			device.revokedAt = this.now();
			this.save();
		}
		for (const peer of [...this.peers]) {
			if (peer.room === roomId && peer.deviceId === deviceId) {
				peer.conn.close(DEVICE_REVOKED_CLOSE_CODE, 'device revoked');
			}
		}
	}
}
