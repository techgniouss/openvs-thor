/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Envelope, isControlFrame } from './protocol';
import { RemoteSocket } from './socket';

/**
 * Phase 5 of "remote control": host-side pairing orchestration over an already-connected
 * {@link RemoteSocket}, plus the in-panel pairing card (`media/pairing.js`, wired through
 * `ChatViewProvider`'s `requestPairing` message and `pairingHandler` seam). The relay does the
 * actual minting/hashing/claiming (`room.ts`) — this module sends the `pair` control frame,
 * waits for the matching reply, and turns it into the URL the pairing card's QR code encodes.
 */

/** How long {@link requestPairing} waits for the relay to answer a `pair` request before giving up. */
const PAIR_TIMEOUT_MS = 10_000;

/** The freshly minted pairing code and its expiry, as answered by a `paired` control frame. */
export interface PairingCode {
	readonly code: string;
	readonly expiresAt: number;
}

/** {@link PairingCode} plus the full URL the pairing card's QR code encodes — what `RemoteService.pair()` actually returns. */
export interface PairingResult extends PairingCode {
	readonly url: string;
}

/**
 * Sends `{c: 'pair'}` and resolves with the relay's `paired` reply. Rejects if the relay never
 * answers within {@link PAIR_TIMEOUT_MS} — a pairing UI has to be able to tell "still asking"
 * from "never got an answer" rather than hang forever.
 */
export function requestPairing(socket: RemoteSocket): Promise<PairingCode> {
	return new Promise<PairingCode>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const subscription = socket.onMessage((envelope: Envelope) => {
			if (envelope.t !== 'c' || !isControlFrame(envelope.p) || envelope.p.c !== 'paired') {
				return;
			}
			clearTimeout(timer);
			subscription.dispose();
			resolve({ code: envelope.p.code, expiresAt: envelope.p.expiresAt });
		});
		timer = setTimeout(() => {
			subscription.dispose();
			reject(new Error('The relay did not answer the pairing request in time.'));
		}, PAIR_TIMEOUT_MS);
		socket.requestPairingCode();
	});
}

/**
 * The URL a pairing QR code encodes: `<relayUrl>/p/<publicRoomId>#<code>`. The code lives in
 * the fragment, per the plan's "Auth" section — it never reaches a request line, a Worker log,
 * or a referrer header, since the fragment is never sent to the server at all.
 */
export function buildPairingUrl(relayUrl: string, publicRoomId: string, code: string): string {
	return `${relayUrl.replace(/\/+$/, '')}/p/${encodeURIComponent(publicRoomId)}#${encodeURIComponent(code)}`;
}

/** How long {@link revokeDevice} waits for the relay's `revoked` ack before giving up. */
const REVOKE_TIMEOUT_MS = 10_000;

/**
 * Sends `{c: 'revoke', deviceId}` and resolves once the relay confirms it via a matching
 * `revoked` reply — the relay closes that device's sockets with 4001 as part of the same work.
 * Used to be fire-and-forget, which gave a caller no way to tell "the relay has actually
 * processed this" from "the message is still in flight" — `remoteService.ts`'s device list
 * refresh right after a revoke click raced that gap and could show the just-revoked device as
 * still active. Resolves on timeout rather than rejecting: the revoke was still sent, and a
 * caller that only wants to know when it's safe to refresh the list should not treat "the ack
 * was slow" as "the revoke failed" — `sweepDeviceAge`'s unattended background call and the
 * in-panel button both just want to proceed once this settles, either way.
 */
export function revokeDevice(socket: RemoteSocket, deviceId: string): Promise<void> {
	return new Promise<void>(resolve => {
		let settled = false;
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			subscription.dispose();
			resolve();
		};
		const subscription = socket.onMessage((envelope: Envelope) => {
			if (envelope.t !== 'c' || !isControlFrame(envelope.p) || envelope.p.c !== 'revoked' || envelope.p.deviceId !== deviceId) {
				return;
			}
			finish();
		});
		const timer = setTimeout(finish, REVOKE_TIMEOUT_MS);
		socket.sendControl({ c: 'revoke', deviceId });
	});
}
