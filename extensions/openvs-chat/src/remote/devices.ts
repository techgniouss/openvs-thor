/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 7c of "remote control": device enumeration and the two host-side sweep decisions that
 * only `openvs-relay` doesn't already make — the relay itself has no notion of
 * `openvsChat.remote.deviceTokenDays`/`idleDisableHours`, so this module reads `GET
 * /api/devices` and decides, from settings the host alone knows, which devices have outlived
 * their token and whether the whole connection has gone idle. `vscode`-free, like `socket.ts`:
 * {@link fetchDevices} needs only the global `fetch` this extension already uses for provider
 * traffic (no `dependencies` in `package.json`), and the two decision functions below are pure
 * so `scripts/test-remote-devices.mjs` can exercise their boundaries without a stub.
 */

/**
 * One paired device, as `openvs-relay/src/room.ts`'s `GET /api/devices` reports it —
 * `pubkeyJwk`/`tokenHash` never leave the relay's Durable Object, see that handler's own doc.
 */
export interface DeviceInfo {
	readonly id: string;
	readonly name: string;
	readonly createdAt: number;
	readonly lastSeenAt: number | null;
	readonly revokedAt: number | null;
}

/** Type guard for one element of `GET /api/devices`'s `devices` array — the relay is a separately deployed service, so its response shape is validated, not trusted. */
function isDeviceInfo(x: unknown): x is DeviceInfo {
	if (typeof x !== 'object' || x === null) {
		return false;
	}
	const o = x as Record<string, unknown>;
	return typeof o.id === 'string'
		&& typeof o.name === 'string'
		&& typeof o.createdAt === 'number'
		&& (o.lastSeenAt === null || typeof o.lastSeenAt === 'number')
		&& (o.revokedAt === null || typeof o.revokedAt === 'number');
}

/**
 * Fetches the current device list for one room from `openvs-relay`'s `GET /api/devices` —
 * plain HTTP, not the WebSocket; the room/token convention (`?room=<publicRoomId>` query
 * param, `Authorization: Bearer <hostToken>` header) matches exactly what `socket.ts`'s
 * `RemoteSocket.connect` already uses to dial `/ws/host`, so a paired device's own connection
 * and this host-only enumeration authenticate the same way. Throws on a non-2xx response or a
 * malformed body — callers (`RemoteService`) decide how to report that.
 */
export async function fetchDevices(relayUrl: string, publicRoomId: string, hostToken: string): Promise<DeviceInfo[]> {
	const url = `${relayUrl.replace(/\/+$/, '')}/api/devices?room=${encodeURIComponent(publicRoomId)}`;
	const response = await fetch(url, { headers: { Authorization: `Bearer ${hostToken}` } });
	if (!response.ok) {
		throw new Error(`Failed to fetch the device list (HTTP ${response.status}).`);
	}
	const body = await response.json() as { devices?: unknown };
	return Array.isArray(body.devices) ? body.devices.filter(isDeviceInfo) : [];
}

/**
 * Whether a device's token has aged past `deviceTokenDays` and should be revoked by
 * `RemoteService`'s periodic sweep. The boundary is exclusive — a device exactly
 * `deviceTokenDays` old is not yet revoked, only one that has gone strictly past it, matching
 * the plan's own `Date.now() - device.createdAt > deviceTokenDays * 86_400_000` phrasing.
 */
export function shouldRevokeForTokenAge(createdAt: number, deviceTokenDays: number, now: number): boolean {
	return now - createdAt > deviceTokenDays * 86_400_000;
}

/**
 * Whether the live connection should be auto-disconnected because no *local* host activity
 * (the desktop webview reaching `ChatViewProvider`, never remote traffic — see
 * `RemoteService`'s own doc on why that specific signal is the right one) has been seen for
 * over `idleDisableHours`. Same exclusive-boundary convention as {@link shouldRevokeForTokenAge}.
 */
export function shouldDisconnectForIdle(lastActivityAt: number, idleDisableHours: number, now: number): boolean {
	return now - lastActivityAt > idleDisableHours * 3_600_000;
}
