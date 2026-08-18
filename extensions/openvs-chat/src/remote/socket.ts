/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ControlFrame, Envelope, isControlFrame, isEnvelope } from './protocol';

/**
 * Phase 5 of "remote control": the outbound WebSocket client that dials `openvs-relay`.
 * `vscode`-free by choice (not by requirement — unlike `protocol.ts`/`coalescer.ts` this file
 * is allowed to import `vscode`) because everything it does (connect, heartbeat, backoff,
 * reconnect) is plain networking with no editor dependency, and keeping it pure is what lets
 * `scripts/test-remote-socket.mjs` exercise the backoff/envelope-building logic under plain
 * node without a `vscode` stub. The one user-visible side effect this class's job would
 * otherwise need — telling the user remote control isn't available in this VS Code build — is
 * left to `remoteService.ts` instead, which reacts to the `'unavailable'` status this class
 * reports rather than reaching for `vscode.window` itself.
 */

/** True when this runtime exposes a native `WebSocket` constructor. */
export function hasNativeWebSocket(): boolean {
	return typeof globalThis.WebSocket === 'function';
}

/**
 * The `headers` option Node's global `WebSocket` (backed by undici) accepts as a non-standard
 * extension to its second constructor argument — absent from the DOM/WebWorker lib types this
 * project's `tsconfig.json` otherwise resolves `WebSocket` to (`lib: ["ES2024", "WebWorker"]`),
 * which only allows a string/string[] of subprotocols there. Verified empirically against this
 * repo's Node 24 runtime: a real `ws` server run locally received the `Authorization` header
 * from a `new WebSocket(url, { headers: {...} })` call — see this task's report for the exact
 * probe. `room.ts`'s `upgradeHost` only reads `Authorization` (no query-param fallback, and the
 * relay is frozen for this task), so this is the only viable way to authenticate the upgrade
 * request with the standard `WebSocket` constructor shape.
 */
interface NodeWebSocketInit {
	headers?: Record<string, string>;
}

/**
 * Constructs a `WebSocket` carrying the bearer token as an `Authorization` header, via the
 * {@link NodeWebSocketInit} escape hatch. Only called after {@link hasNativeWebSocket} confirms
 * a `WebSocket` constructor exists at all.
 *
 * TODO(Phase 7 or later, if this is ever hit in practice): if a future runtime's global
 * `WebSocket` turns out not to support this non-standard `headers` option after all (a plain
 * browser-spec implementation, say), the plan's own fallback design is a hand-rolled RFC 6455
 * client in a `frames.ts` (~250 lines) — squarely the house pattern, given `oauth.ts` already
 * hand-rolls three `node:http` servers. Not built now: the empirical check above passed on this
 * repo's actual target runtime, and building the fallback speculatively would be wasted work.
 */
function openAuthenticated(url: string, bearerToken: string): WebSocket {
	const Ctor = WebSocket as unknown as new (url: string, init?: NodeWebSocketInit) => WebSocket;
	return new Ctor(url, { headers: { Authorization: `Bearer ${bearerToken}` } });
}

/** Close code the relay sends to a displaced host — see `room.ts`'s `HOST_TAKEOVER_CLOSE_CODE`. Duplicated as a literal for the same reason as `protocol.ts`: no cross-package import. */
const HOST_TAKEOVER_CLOSE_CODE = 4003;

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Full-jitter backoff for reconnect attempts: `random(0, min(cap, base * 2^attempt))`. Pure and
 * exported so `scripts/test-remote-socket.mjs` can assert on it without a real socket; `rng` is
 * injected (defaulting to `Math.random`) so a test can pin the "random" draw.
 */
export function nextBackoffMs(attempt: number, rng: () => number = Math.random): number {
	const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.max(0, attempt)));
	return Math.floor(rng() * cap);
}

/** Builds a `hello` control envelope. Pure, for the same testability reason as {@link nextBackoffMs}. */
export function buildHelloEnvelope(seq: number, roomToken: string): Envelope {
	return { v: 1, t: 'c', seq, p: { c: 'hello', role: 'host', roomToken } };
}

/** Builds a `ping` control envelope. */
export function buildPingEnvelope(seq: number): Envelope {
	return { v: 1, t: 'c', seq, p: { c: 'ping' } };
}

/** Builds a `pair` control envelope. */
export function buildPairEnvelope(seq: number): Envelope {
	return { v: 1, t: 'c', seq, p: { c: 'pair' } };
}

/** Builds a `revoke` control envelope. */
export function buildRevokeEnvelope(seq: number, deviceId: string): Envelope {
	return { v: 1, t: 'c', seq, p: { c: 'revoke', deviceId } };
}

/** Builds a `bye` control envelope. */
export function buildByeEnvelope(seq: number, reason?: string): Envelope {
	return { v: 1, t: 'c', seq, p: reason === undefined ? { c: 'bye' } : { c: 'bye', reason } };
}

/** Minimal disposable shape, declared locally so this file stays free of any `vscode` dependency — same reasoning as `session/types.ts`'s local `Thenable`. */
export interface Unsubscribe {
	dispose(): void;
}

/**
 * Connection lifecycle, as reported to {@link RemoteSocket.onStatusChange}:
 *  - `unavailable` — {@link hasNativeWebSocket} is false; `connect()` refused to try.
 *  - `connecting` / `connected` / `disconnected` — the ordinary lifecycle.
 *  - `displaced` — closed with {@link HOST_TAKEOVER_CLOSE_CODE}; this socket will not retry.
 */
export type RemoteSocketStatus = 'unavailable' | 'connecting' | 'connected' | 'disconnected' | 'displaced';

/** What {@link RemoteSocket} needs to dial the relay for one room. */
export interface RemoteSocketOptions {
	readonly relayUrl: string;
	readonly publicRoomId: string;
	readonly hostToken: string;
}

/**
 * The outbound WebSocket client to `openvs-relay`'s `/ws/host` endpoint. Owns connect,
 * heartbeat (ping every 25s; two missed pongs reconnects), full-jitter backoff reconnect (not
 * on a {@link HOST_TAKEOVER_CLOSE_CODE} close — see the plan's "the displaced host does not
 * retry"), and exposes callbacks for incoming envelopes and status changes, per this repo's
 * stated preference for direct calls over event-driven control flow — a socket's inherently
 * async incoming stream is the one place that preference yields to a callback. `onMessage`
 * specifically supports more than one subscriber (each registration returns a disposer): both
 * `remoteService.ts`'s persistent dispatch loop and `pairing.ts`'s one-shot wait for a `paired`
 * frame need to observe the same incoming stream without stepping on each other's registration.
 * This is still one event stream, not a generic named-event emitter — `onStatusChange`/`onRtt`
 * stay single-callback setters, since only `remoteService.ts` ever needs those.
 */
export class RemoteSocket {
	private ws?: WebSocket;
	private seq = 0;
	private reconnectAttempt = 0;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private heartbeatTimer?: ReturnType<typeof setInterval>;
	private pongTimeoutTimer?: ReturnType<typeof setTimeout>;
	private pingSentAt = 0;
	private awaitingPong = false;
	private missedPongs = 0;
	private disposed = false;
	private status: RemoteSocketStatus = 'disconnected';
	private readonly messageHandlers = new Set<(envelope: Envelope) => void>();
	private statusHandler?: (status: RemoteSocketStatus) => void;
	private rttHandler?: (rttMs: number) => void;

	constructor(private readonly options: RemoteSocketOptions) { }

	/** Registers a handler for every incoming envelope, control frames included. Returns a disposer that unregisters just this handler. */
	onMessage(handler: (envelope: Envelope) => void): Unsubscribe {
		this.messageHandlers.add(handler);
		return { dispose: () => { this.messageHandlers.delete(handler); } };
	}

	/** Registers the (single) handler for connection status changes. */
	onStatusChange(handler: (status: RemoteSocketStatus) => void): void {
		this.statusHandler = handler;
	}

	/** Registers the (single) handler for a measured heartbeat round-trip time, in milliseconds — feeds `TokenCoalescer.setRttMs` in `remoteSink.ts`. */
	onRtt(handler: (rttMs: number) => void): void {
		this.rttHandler = handler;
	}

	/** Connects (or reconnects) to the relay. A no-op once {@link dispose} has been called. */
	connect(): void {
		if (this.disposed) {
			return;
		}
		if (!hasNativeWebSocket()) {
			this.setStatus('unavailable');
			return;
		}
		this.setStatus('connecting');
		const url = `${this.options.relayUrl}/ws/host?room=${encodeURIComponent(this.options.publicRoomId)}`;
		const socket = openAuthenticated(url, this.options.hostToken);
		this.ws = socket;
		socket.addEventListener('open', () => {
			this.reconnectAttempt = 0;
			this.setStatus('connected');
			// Auth already happened at the upgrade header, but `HelloFrame.roomToken` exists for
			// protocol completeness and because `room.ts`'s `handleControlFrame` reads `frame.role`
			// for takeover bookkeeping.
			this.send(buildHelloEnvelope(this.nextSeq(), this.options.hostToken));
			this.startHeartbeat();
		});
		socket.addEventListener('message', event => this.handleRawMessage((event as MessageEvent).data));
		socket.addEventListener('close', event => this.handleClose((event as CloseEvent).code));
		// The 'close' handler carries the code and reason; nothing further to do on 'error'
		// beyond letting the close that follows drive reconnect bookkeeping.
		socket.addEventListener('error', () => { /* handled by the close event that follows */ });
	}

	/** Sends a full {@link Envelope} verbatim, minting nothing. A no-op while not connected. */
	send(envelope: Envelope): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}
		this.ws.send(JSON.stringify(envelope));
	}

	/** Wraps a {@link ControlFrame} in a fresh `t: 'c'` envelope and sends it. */
	sendControl(frame: ControlFrame): void {
		this.send({ v: 1, t: 'c', seq: this.nextSeq(), p: frame });
	}

	/** Requests a fresh pairing code; the reply arrives as a `paired` control frame via {@link onMessage}. */
	requestPairingCode(): void {
		this.sendControl({ c: 'pair' });
	}

	/** Tears down the socket: sends `bye`, stops every timer, and refuses any further `connect()`. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.stopHeartbeat();
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.send(buildByeEnvelope(this.nextSeq(), 'dispose'));
			this.ws.close(1000, 'bye');
		} else {
			this.ws?.close();
		}
		this.ws = undefined;
		this.setStatus('disconnected');
	}

	private nextSeq(): number {
		return ++this.seq;
	}

	private setStatus(status: RemoteSocketStatus): void {
		this.status = status;
		this.statusHandler?.(status);
	}

	/** The most recently reported status — used by `remoteService.ts`'s `remoteStatus` command. */
	getStatus(): RemoteSocketStatus {
		return this.status;
	}

	private handleRawMessage(data: unknown): void {
		if (typeof data !== 'string') {
			return; // this protocol is text-frame-only; a stray binary frame is ignored, not fatal.
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		if (!isEnvelope(parsed)) {
			return;
		}
		if (parsed.t === 'c' && isControlFrame(parsed.p) && parsed.p.c === 'pong') {
			this.handlePong();
		}
		for (const handler of this.messageHandlers) {
			handler(parsed);
		}
	}

	private handleClose(code: number): void {
		this.stopHeartbeat();
		this.ws = undefined;
		if (this.disposed) {
			return;
		}
		if (code === HOST_TAKEOVER_CLOSE_CODE) {
			// Per the plan: another host connection took over (the common case is a reloaded
			// window racing its own half-dead socket). Retrying would just re-trigger the same
			// takeover against the new connection, so this socket stops here.
			this.setStatus('displaced');
			return;
		}
		this.setStatus('disconnected');
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		const delay = nextBackoffMs(this.reconnectAttempt);
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.missedPongs = 0;
		this.heartbeatTimer = setInterval(() => this.sendPing(), HEARTBEAT_INTERVAL_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		if (this.pongTimeoutTimer !== undefined) {
			clearTimeout(this.pongTimeoutTimer);
			this.pongTimeoutTimer = undefined;
		}
		this.awaitingPong = false;
	}

	private sendPing(): void {
		this.pingSentAt = Date.now();
		this.awaitingPong = true;
		this.send(buildPingEnvelope(this.nextSeq()));
		if (this.pongTimeoutTimer !== undefined) {
			clearTimeout(this.pongTimeoutTimer);
		}
		this.pongTimeoutTimer = setTimeout(() => this.handleMissedPong(), HEARTBEAT_TIMEOUT_MS);
	}

	private handlePong(): void {
		if (!this.awaitingPong) {
			return;
		}
		this.awaitingPong = false;
		this.missedPongs = 0;
		this.rttHandler?.(Date.now() - this.pingSentAt);
	}

	private handleMissedPong(): void {
		if (!this.awaitingPong) {
			return;
		}
		this.missedPongs++;
		this.awaitingPong = false;
		if (this.missedPongs >= 2) {
			this.ws?.close(4000, 'heartbeat timeout');
		}
	}
}
