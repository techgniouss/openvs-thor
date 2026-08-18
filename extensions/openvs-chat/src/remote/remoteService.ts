/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatViewProvider } from '../chatViewProvider';
import {
	deriveHostToken, derivePublicRoomId, getDeviceTokenDays, getIdleDisableHours, getOrCreateRoomSecret, getRelayUrl,
	getWorkspaceKey, isRemoteEnabled,
} from './config';
import { DeviceInfo, fetchDevices, shouldDisconnectForIdle, shouldRevokeForTokenAge } from './devices';
import { buildPairingUrl, PairingResult, requestPairing, revokeDevice } from './pairing';
import { isRemoteAllowed } from './policy';
import { Envelope, isControlFrame } from './protocol';
import { RemoteSink } from './remoteSink';
import { buildCatchUpMessages } from './snapshot';
import { RemoteSocket, RemoteSocketStatus, Unsubscribe } from './socket';

/** {@link import('../session/bus').MessageSink} id this service registers its one relay-backed sink under. */
const REMOTE_SINK_ID = 'remote';

/**
 * How often the Phase 7c hygiene sweep (`deviceTokenDays` revocation + `idleDisableHours`
 * auto-disconnect) runs. Both settings are day/hour-granularity, so an hourly cadence is far
 * more than enough resolution while staying well clear of "poll aggressively" — see
 * {@link RemoteService.runSweep}'s own doc for why the same interval covers both checks.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Phase 5 of "remote control": the lifecycle owner tying `config.ts`, `socket.ts`,
 * `remoteSink.ts`, `pairing.ts` and `snapshot.ts` together into one running (or not-running)
 * connection to a relay. Constructed in `extension.ts` beside `McpManager`, and — per the
 * plan's own framing of the choice — **owns the reference to {@link ChatViewProvider}, not the
 * other way around**: remote control is optional (off unless `openvsChat.remote.enabled` is
 * set and a relay URL is configured), the chat panel is not, and `ChatViewProvider` is already
 * this extension's largest file. `ChatViewProvider` exposes a small public seam
 * (`attachRemoteSink`/`detachRemoteSink`/`dispatchRemoteMessage`/`postToSink`/
 * `getSessionStore`) instead of growing a dependency on the transport layer itself.
 *
 * Watches `openvsChat.remote.enabled`/`relayUrl` and starts or stops the connection to match —
 * so flipping the setting (including via the `openvsChat.remoteEnable` command) takes effect
 * without a reload.
 */
export class RemoteService implements vscode.Disposable {
	private socket?: RemoteSocket;
	private sink?: RemoteSink;
	private messageSubscription?: Unsubscribe;
	private readonly configListener: vscode.Disposable;
	/** Guards the "remote control isn't available" message so a flapping connection doesn't spam it. */
	private reportedUnavailable = false;
	/** This room's relay URL, public id and host bearer token, set for the lifetime of {@link socket} — {@link pair} needs the first two to build the QR code's URL, and the device sweep below needs all three to call {@link fetchDevices}. */
	private relayUrl?: string;
	private publicRoomId?: string;
	private hostToken?: string;
	/** The Phase 7c hygiene sweep's timer — see {@link runSweep}. */
	private sweepTimer?: ReturnType<typeof setInterval>;
	/**
	 * The last time *local* host activity was observed — any message from the desktop webview
	 * sink reaching `ChatViewProvider`, via {@link onLocalActivity}. Deliberately not updated by
	 * remote traffic: an active remote session counting as "the host is present" would defeat
	 * the point of `idleDisableHours`, which per the plan is about the desktop user, not the
	 * connection's own traffic. Seeded at construction (extension activation), not left at 0/
	 * `undefined`, so a freshly started connection is never immediately flagged idle because no
	 * activity has been recorded yet.
	 */
	private lastHostActivityAt = Date.now();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly view: ChatViewProvider,
	) {
		this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openvsChat.remote.enabled') || e.affectsConfiguration('openvsChat.remote.relayUrl')) {
				void this.sync();
			}
		});
		// Registered once, for the service's whole lifetime — not per connection — so a resume
		// after an idle-disconnect (see `onLocalActivity`) can be triggered by the very activity
		// that ends the idle period, not just by a later settings change.
		this.view.setLocalActivityHandler(() => this.onLocalActivity());
		void this.sync();
	}

	/**
	 * Records local host activity and, per the plan's "a later resume shouldn't require the
	 * user to re-discover a setting they never touched", opportunistically resumes a connection
	 * that {@link disconnectForIdle} tore down — `enabled`/`relayUrl` are still configured (idle
	 * disconnect never touches them), so the only thing missing is the live socket.
	 */
	private onLocalActivity(): void {
		this.lastHostActivityAt = Date.now();
		if (!this.socket && isRemoteEnabled() && getRelayUrl()) {
			void this.start();
		}
	}

	/**
	 * Requests a fresh pairing code — the in-panel pairing card's `requestPairing` message
	 * resolves through this (`ChatViewProvider.pairingHandler`, set below). Throws if not
	 * currently connected.
	 */
	async pair(): Promise<PairingResult> {
		if (!this.socket || !this.relayUrl || !this.publicRoomId) {
			throw new Error('Remote control is not connected yet. Enable it (openvsChat.remoteEnable) and wait for a connection first.');
		}
		const { code, expiresAt } = await requestPairing(this.socket);
		return { code, expiresAt, url: buildPairingUrl(this.relayUrl, this.publicRoomId, code) };
	}

	/** Human-readable connection status — `openvsChat.remoteStatus`'s implementation. */
	status(): string {
		if (!isRemoteEnabled()) {
			return 'disabled';
		}
		if (!getRelayUrl()) {
			return 'enabled, but no relay URL is configured (set openvsChat.remote.relayUrl)';
		}
		return this.socket?.getStatus() ?? 'not connected';
	}

	dispose(): void {
		this.configListener.dispose();
		this.view.setLocalActivityHandler(undefined);
		this.stop();
	}

	/** Starts or stops the relay connection to match current settings. Idempotent — safe to call whenever settings might have changed. */
	private async sync(): Promise<void> {
		const shouldRun = isRemoteEnabled() && !!getRelayUrl();
		if (shouldRun && !this.socket) {
			await this.start();
		} else if (!shouldRun && this.socket) {
			this.stop();
		}
	}

	private async start(): Promise<void> {
		const relayUrl = getRelayUrl();
		const workspaceKey = getWorkspaceKey();
		if (!workspaceKey) {
			vscode.window.showWarningMessage('OpenVS remote control needs an open folder or workspace to pair a room to — open one first.');
			return;
		}
		const roomSecret = await getOrCreateRoomSecret(this.context, workspaceKey);
		const publicRoomId = derivePublicRoomId(roomSecret);
		const hostToken = deriveHostToken(roomSecret);

		const socket = new RemoteSocket({ relayUrl, publicRoomId, hostToken });
		const sink = new RemoteSink(REMOTE_SINK_ID, socket);
		this.socket = socket;
		this.sink = sink;
		this.relayUrl = relayUrl;
		this.publicRoomId = publicRoomId;
		this.hostToken = hostToken;
		this.reportedUnavailable = false;
		// A freshly (re)started connection should not be judged idle against activity recorded
		// hours or days ago (e.g. remote control was off overnight) — see the field's own doc.
		this.lastHostActivityAt = Date.now();

		socket.onStatusChange(status => this.handleStatus(status));
		this.messageSubscription = socket.onMessage(envelope => this.handleEnvelope(envelope));
		this.view.attachRemoteSink(sink);
		this.view.setPairingHandler(() => this.pair());
		this.view.setDevicesHandler({
			list: () => fetchDevices(relayUrl, publicRoomId, hostToken),
			revoke: deviceId => revokeDevice(socket, deviceId),
		});
		this.view.setRemoteStatus(true, false);
		socket.connect();

		// Catch up immediately rather than waiting a full SWEEP_INTERVAL_MS — a long-idle
		// extension (or one that was just enabled) shouldn't have a stale device sit unrevoked
		// for up to an hour before the first sweep notices it.
		void this.runSweep();
		this.sweepTimer = setInterval(() => void this.runSweep(), SWEEP_INTERVAL_MS);
	}

	/** Tears down the socket/sink and every seam registered on `this.view` for it, without touching remote-control status — {@link stop} and {@link disconnectForIdle} each report status differently afterwards. */
	private teardownConnection(): void {
		if (this.sweepTimer !== undefined) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
		this.messageSubscription?.dispose();
		this.messageSubscription = undefined;
		if (this.sink) {
			this.view.detachRemoteSink(this.sink.id);
			// RemoteSink.dispose() also disposes the RemoteSocket it wraps.
			this.sink.dispose();
		}
		this.sink = undefined;
		this.socket = undefined;
		this.relayUrl = undefined;
		this.publicRoomId = undefined;
		this.hostToken = undefined;
		this.view.setPairingHandler(undefined);
		this.view.setDevicesHandler(undefined);
	}

	private stop(): void {
		this.teardownConnection();
		this.view.setRemoteStatus(false, false);
	}

	/**
	 * Phase 7c's `idleDisableHours` enforcement: tears down the live connection without
	 * flipping `openvsChat.remote.enabled` — that setting is the user's own toggle, and per the
	 * plan a later resume should not require them to re-discover a setting they never touched
	 * (see `onLocalActivity`, which is what actually resumes it). Reports `enabled: true`
	 * (unlike {@link stop}, which reports `false`) with `idleDisabled: true` so the status
	 * indicator can say *why* it disconnected instead of looking like an ordinary drop.
	 *
	 * Safe against `sync()`'s reactive re-enable: `sync()` only runs from the constructor and
	 * the `remote.enabled`/`remote.relayUrl` config-change listener, neither of which this method
	 * touches, so nothing re-invokes it to undo this disconnect until the user actually changes
	 * one of those two settings (at which point re-establishing the connection is exactly what
	 * should happen anyway).
	 */
	private disconnectForIdle(): void {
		const hours = getIdleDisableHours();
		console.log(`OpenVS remote: auto-disconnecting — no local host activity for over ${hours}h.`);
		this.teardownConnection();
		this.view.setRemoteStatus(true, false, true);
	}

	/**
	 * Reacts to a connection status change. Written as `if`/`else` rather than a `switch` on
	 * purpose: `scripts/test-remote-policy.mjs` (and `test-webview.mjs`) statically scan every
	 * `.ts` file directly under `src/remote` for `case '<word>':` to extract the host↔webview
	 * message vocabulary — a `switch` here would put connection-status labels like `'connected'`
	 * into that scan by accident, since the regex can't tell a status switch from a message
	 * dispatcher by shape alone.
	 */
	private handleStatus(status: RemoteSocketStatus): void {
		// Every branch feeds the same status indicator (`media/pairing.js`, via
		// `ChatViewProvider.setRemoteStatus`): "connected" is the only status that reports
		// `connected: true`; everything else — including a *displaced* or *unavailable* socket,
		// which are technically still "enabled" — reports not-connected, since none of them can
		// currently carry chat traffic.
		this.view.setRemoteStatus(true, status === 'connected');
		if (status === 'connected') {
			this.sendCatchUp();
		} else if (status === 'unavailable') {
			if (!this.reportedUnavailable) {
				this.reportedUnavailable = true;
				vscode.window.showErrorMessage(
					'OpenVS remote control isn\'t available in this VS Code build: no WebSocket implementation was found in the extension host.');
			}
		} else if (status === 'displaced') {
			vscode.window.showWarningMessage(
				'OpenVS remote control was disconnected: another VS Code window took over this workspace\'s room.');
		}
		// 'connecting' / 'disconnected': nothing to do beyond what the status getter already reports.
	}

	/** Posts the newly-connected sink's catch-up frames (see `snapshot.ts`) so it starts with real state instead of nothing. */
	private sendCatchUp(): void {
		if (!this.sink) {
			return;
		}
		for (const message of buildCatchUpMessages(this.view.getSessionStore())) {
			this.view.postToSink(this.sink.id, message);
		}
	}

	/**
	 * Handles one incoming envelope from the relay. This is the security boundary the plan calls
	 * out explicitly: a `t: 'm'` payload is dispatched into the host only when
	 * {@link isRemoteAllowed} accepts its `type` — anything else is dropped and answered with an
	 * `error` to the originating sink alone, never reaching `dispatchMessage`. `t: 'c'` frames
	 * are the DO's own business, handled separately by {@link handleControlFrame} — most of them
	 * (`paired`, `pong`, …) are answered by `pairing.ts`'s/`socket.ts`'s own subscriptions to the
	 * same `onMessage` stream (it supports more than one subscriber, see `socket.ts`'s doc); this
	 * method only reacts to the one this phase adds, `deviceConnected`.
	 */
	private handleEnvelope(envelope: Envelope): void {
		if (envelope.t === 'c') {
			this.handleControlFrame(envelope);
			return;
		}
		if (envelope.t !== 'm' || !this.sink) {
			return;
		}
		const payload = envelope.p;
		if (typeof payload !== 'object' || payload === null || typeof (payload as Record<string, unknown>).type !== 'string') {
			return;
		}
		const message = payload as Record<string, unknown> & { type: string };
		if (!isRemoteAllowed(message.type)) {
			this.view.postToSink(this.sink.id, { type: 'error', message: `"${message.type}" is not permitted from a remote client.` });
			return;
		}
		this.view.dispatchRemoteMessage(message, this.sink.id);
	}

	/**
	 * Auth step 6's "new device notice" (Phase 7c): a `firstConnect` raises a desktop
	 * notification with a Revoke action, exactly as the plan describes — a device the host
	 * doesn't recognize connecting for the first time is the one moment worth interrupting for.
	 * An ordinary reconnect (`firstConnect: false`, e.g. a paired phone's PWA resuming from
	 * background) is deliberately silent, per the frame's own doc on spam avoidance.
	 */
	private handleControlFrame(envelope: Envelope): void {
		if (!isControlFrame(envelope.p) || envelope.p.c !== 'deviceConnected' || !envelope.p.firstConnect) {
			return;
		}
		const { deviceId, name } = envelope.p;
		void vscode.window.showInformationMessage(`${name} connected`, 'Revoke').then(choice => {
			if (choice === 'Revoke' && this.socket) {
				void revokeDevice(this.socket, deviceId);
			}
		});
	}

	/**
	 * Phase 7c's periodic hygiene sweep: `deviceTokenDays` age-based revocation and
	 * `idleDisableHours` idle-disconnect share one interval (see `SWEEP_INTERVAL_MS`'s doc)
	 * rather than each getting its own timer — both are day/hour-granularity settings that
	 * don't need separate cadences, and a run that finds nothing to do costs one HTTP request.
	 * Device-age revocation runs first: if it also disconnects for idleness, there is no
	 * connection left afterwards to check.
	 */
	private async runSweep(): Promise<void> {
		await this.sweepDeviceAge();
		this.sweepIdle();
	}

	/** Revokes every device whose token has aged past `openvsChat.remote.deviceTokenDays`. Errors fetching the list are logged and otherwise swallowed — a background hygiene pass failing once must not surface as a user-facing error on an unrelated action. */
	private async sweepDeviceAge(): Promise<void> {
		if (!this.socket || !this.relayUrl || !this.publicRoomId || !this.hostToken) {
			return;
		}
		const socket = this.socket;
		let devices: DeviceInfo[];
		try {
			devices = await fetchDevices(this.relayUrl, this.publicRoomId, this.hostToken);
		} catch (err) {
			console.warn('OpenVS remote: device sweep could not fetch the device list.', err);
			return;
		}
		const deviceTokenDays = getDeviceTokenDays();
		const now = Date.now();
		for (const device of devices) {
			if (device.revokedAt !== null) {
				continue;
			}
			if (shouldRevokeForTokenAge(device.createdAt, deviceTokenDays, now)) {
				console.log(`OpenVS remote: revoking device "${device.name}" (${device.id}) — its token is older than ${deviceTokenDays}d.`);
				void revokeDevice(socket, device.id);
			}
		}
	}

	/** Disconnects (see {@link disconnectForIdle}) once no local host activity has been seen for over `openvsChat.remote.idleDisableHours`. */
	private sweepIdle(): void {
		if (!this.socket) {
			return;
		}
		if (shouldDisconnectForIdle(this.lastHostActivityAt, getIdleDisableHours(), Date.now())) {
			this.disconnectForIdle();
		}
	}
}
