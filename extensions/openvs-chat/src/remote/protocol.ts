/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5 of "remote control": the wire envelope and control-frame vocabulary this extension
 * speaks to `openvs-relay`. This is a deliberate hand-copy of `openvs-relay/src/protocol.ts` —
 * the extension cannot `import` across the package boundary (no bundler links
 * `extensions/openvs-chat` to `openvs-relay`, and they ship independently), so this file
 * duplicates that shape by hand, the same way `openvs-relay/pwa/app.js` already duplicates it
 * for the PWA side (see that file's own top-of-file comment). Keep the two in sync by hand;
 * there is no automated check on the extension side of this particular duplication (the PWA
 * side has `openvs-relay/scripts/test-pwa-contract.mjs`).
 */

/**
 * The envelope every frame is wrapped in:
 *  - `t: 'm'` — `p` is verbatim an existing extension↔webview message (`{ type: string, ... }`).
 *    The relay never parses these; they are relayed opaquely between host and client(s).
 *  - `t: 'c'` — control-plane frame; `p` is a {@link ControlFrame}. The relay *does* parse these.
 *  - `t: 'a'` — a bare cumulative ack; `p` is absent, `ack` carries the acknowledged `seq`.
 */
export interface Envelope {
	readonly v: 1;
	readonly t: 'm' | 'c' | 'a';
	readonly seq: number;
	readonly ack?: number;
	readonly p?: unknown;
}

/** Sent by either side to establish identity on a fresh socket. */
export interface HelloFrame {
	readonly c: 'hello';
	readonly role: 'host' | 'client';
	/** Presented by the host claiming room ownership (`Bearer HMAC(roomSecret,'host')` semantics, but carried in-band here). */
	readonly roomToken?: string;
	/** Presented by a paired client device. */
	readonly deviceToken?: string;
}

/** Answers a `hello`, confirming the connection is live and telling the peer where to resume from. */
export interface WelcomeFrame {
	readonly c: 'welcome';
	readonly lastSeq: number;
}

/** Requests replay from `lastSeq` after a reconnect. */
export interface ResumeFrame {
	readonly c: 'resume';
	readonly lastSeq: number;
}

/** Sent instead of a replay when `lastSeq` has fallen out of the relay's own (small) buffer; the peer must fall back to a full snapshot. */
export interface SnapshotNeededFrame {
	readonly c: 'snapshotNeeded';
}

/** Heartbeat request. Answered automatically by the DO's `setWebSocketAutoResponse` without waking a hibernated instance — see `openvs-relay/src/room.ts`. */
export interface PingFrame {
	readonly c: 'ping';
}

/** Heartbeat reply. */
export interface PongFrame {
	readonly c: 'pong';
}

/** Sent by the host to mint a new pairing code for this room. */
export interface PairFrame {
	readonly c: 'pair';
}

/** Answers `pair` with the freshly minted code and its expiry. */
export interface PairedFrame {
	readonly c: 'paired';
	readonly code: string;
	readonly expiresAt: number;
}

/** Sent by the host to revoke a previously paired device. */
export interface RevokeFrame {
	readonly c: 'revoke';
	readonly deviceId: string;
}

/**
 * Answers `revoke` once the device has actually been marked revoked and its live sockets (if
 * any) closed — `revoke` used to be pure fire-and-forget, which left the host with no way to
 * tell "the relay has processed this" from "the message is still in flight", so a device-list
 * refresh sent right after could race the revoke it was meant to reflect and show the device as
 * still active. Mirrors `openvs-relay/src/protocol.ts`'s frame of the same name exactly, per
 * this file's own top-of-file doc on keeping the two hand-copies in sync.
 */
export interface RevokedFrame {
	readonly c: 'revoked';
	readonly deviceId: string;
}

/**
 * Sent by the host to ask the relay to raise a Web Push notification for a connected-but-
 * currently-backgrounded client device. Never sniffed from `t: 'm'` traffic — the host decides
 * whether an event warrants a push and says so explicitly. Typed here for protocol completeness
 * — this task does not send it; the push-trigger decision is Phase 6 work.
 */
export interface PushFrame {
	readonly c: 'push';
	readonly title: string;
	readonly body: string;
	readonly tag: string;
	readonly sessionId: string;
}

/** Sent by either side just before closing cleanly, so the other side doesn't have to wait out a timeout to notice. */
export interface ByeFrame {
	readonly c: 'bye';
	readonly reason?: string;
}

/**
 * Sent by the DO to the host when a paired device connects over `/ws/client` — Auth step 6's
 * "new device notice" (Phase 7c). `firstConnect` distinguishes a device's very first successful
 * connect (worth a desktop notification with a Revoke action) from an ordinary reconnect of an
 * already-seen device (e.g. a paired phone's PWA resuming from background), which should not
 * spam the host every time. Never sent in response to anything the host asked for — mirrors
 * `openvs-relay/src/protocol.ts`'s frame of the same name exactly, per this file's own top-of-
 * file doc on keeping the two hand-copies in sync.
 */
export interface DeviceConnectedFrame {
	readonly c: 'deviceConnected';
	readonly deviceId: string;
	readonly name: string;
	readonly firstConnect: boolean;
}

/** The full control-frame vocabulary a `t: 'c'` envelope's `p` may hold. */
export type ControlFrame =
	| HelloFrame
	| WelcomeFrame
	| ResumeFrame
	| SnapshotNeededFrame
	| PingFrame
	| PongFrame
	| PairFrame
	| PairedFrame
	| RevokeFrame
	| RevokedFrame
	| PushFrame
	| ByeFrame
	| DeviceConnectedFrame;

/** The full set of valid `ControlFrame['c']` values, used by {@link isControlFrame}. */
const CONTROL_VERBS: ReadonlySet<string> = new Set([
	'hello', 'welcome', 'resume', 'snapshotNeeded', 'ping', 'pong', 'pair', 'paired', 'revoke', 'revoked', 'push', 'bye',
	'deviceConnected',
]);

/** Type guard for {@link Envelope}. Checks shape only — `p`'s inner shape is validated separately by `isControlFrame` when `t === 'c'`. */
export function isEnvelope(x: unknown): x is Envelope {
	if (typeof x !== 'object' || x === null) {
		return false;
	}
	const o = x as Record<string, unknown>;
	return o.v === 1
		&& (o.t === 'm' || o.t === 'c' || o.t === 'a')
		&& typeof o.seq === 'number'
		&& (o.ack === undefined || typeof o.ack === 'number');
}

/** Type guard for {@link ControlFrame}. Checks only that `c` names a known verb — per-verb field validation is each handler's own job. */
export function isControlFrame(x: unknown): x is ControlFrame {
	if (typeof x !== 'object' || x === null) {
		return false;
	}
	const c = (x as Record<string, unknown>).c;
	return typeof c === 'string' && CONTROL_VERBS.has(c);
}
