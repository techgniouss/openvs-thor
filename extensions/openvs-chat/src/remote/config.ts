/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createHmac, randomBytes } from 'crypto';
import * as vscode from 'vscode';

/**
 * Phase 5 of "remote control": accessors for `openvsChat.remote.*` settings and the
 * `SecretStorage`-backed per-workspace room secret. Per the plan's "Auth" section,
 * `SecretStorage` is global to the extension, not per-workspace — a room secret shared across
 * every open project would make every workspace the same room — so the secret is keyed by a
 * hash of the workspace's own identity (see {@link getWorkspaceKey}), and every key this module
 * mints is indexed in `workspaceState` so a future "revoke all rooms" command can enumerate
 * them without scanning `SecretStorage` (which has no listing API).
 */

/** `workspaceState` key holding the array of every `workspaceKey` a room secret was ever minted for. */
const KNOWN_ROOMS_KEY = 'openvsChat.remote.knownRooms';

/** `SecretStorage` key prefix for a workspace's room secret; the full key appends its `workspaceKey`. */
const ROOM_SECRET_PREFIX = 'openvsChat.remote.roomSecret.';

/** Default for `openvsChat.remote.deviceTokenDays` — the sliding device-token expiry `RemoteService`'s hygiene sweep enforces (`shouldRevokeForTokenAge` in `devices.ts`). */
const DEFAULT_DEVICE_TOKEN_DAYS = 30;

/** Default for `openvsChat.remote.idleDisableHours` — the no-host-activity auto-disable window `RemoteService`'s hygiene sweep enforces (`shouldDisconnectForIdle` in `devices.ts`). */
const DEFAULT_IDLE_DISABLE_HOURS = 12;

/** Whether remote control is turned on (`openvsChat.remote.enabled`). Off by default. */
export function isRemoteEnabled(): boolean {
	return vscode.workspace.getConfiguration('openvsChat').get<boolean>('remote.enabled') === true;
}

/** The relay URL to dial out to (`openvsChat.remote.relayUrl`). Empty when unset — there is no default relay. */
export function getRelayUrl(): string {
	return vscode.workspace.getConfiguration('openvsChat').get<string>('remote.relayUrl')?.trim() ?? '';
}

/** `openvsChat.remote.deviceTokenDays`, enforced by `RemoteService`'s hourly hygiene sweep. */
export function getDeviceTokenDays(): number {
	const days = vscode.workspace.getConfiguration('openvsChat').get<number>('remote.deviceTokenDays');
	return typeof days === 'number' && days > 0 ? days : DEFAULT_DEVICE_TOKEN_DAYS;
}

/** `openvsChat.remote.idleDisableHours`, enforced by `RemoteService`'s hourly hygiene sweep. */
export function getIdleDisableHours(): number {
	const hours = vscode.workspace.getConfiguration('openvsChat').get<number>('remote.idleDisableHours');
	return typeof hours === 'number' && hours > 0 ? hours : DEFAULT_IDLE_DISABLE_HOURS;
}

/**
 * A stable identity for the currently open workspace, or `undefined` for a folderless window.
 * Prefers the multi-root `.code-workspace` file's own URI (stable across which folder happens
 * to be first) and falls back to the single open folder's URI. Never derived from anything a
 * remote client could influence.
 */
export function getWorkspaceKey(): string | undefined {
	const identity = vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
	if (!identity) {
		return undefined;
	}
	return createHash('sha256').update(identity).digest('hex');
}

/**
 * Returns this workspace's room secret, minting and persisting a fresh one on first use.
 * Callers must resolve {@link getWorkspaceKey} themselves and handle an `undefined` result
 * (a folderless window gets no room) before calling this — it never falls back to a global
 * room secret.
 */
export async function getOrCreateRoomSecret(context: vscode.ExtensionContext, workspaceKey: string): Promise<string> {
	const secretKey = ROOM_SECRET_PREFIX + workspaceKey;
	const existing = await context.secrets.get(secretKey);
	if (existing) {
		return existing;
	}
	const secret = randomBytes(32).toString('base64url');
	await context.secrets.store(secretKey, secret);
	const known = context.workspaceState.get<string[]>(KNOWN_ROOMS_KEY, []);
	if (!known.includes(workspaceKey)) {
		await context.workspaceState.update(KNOWN_ROOMS_KEY, [...known, workspaceKey]);
	}
	return secret;
}

/**
 * Crockford's base32 alphabet (no `I`, `L`, `O`, `U` — the characters most often misread or
 * mistyped), used by {@link derivePublicRoomId}. Hand-rolled rather than pulled from a
 * dependency: this extension's `package.json` deliberately has no `dependencies` block.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encodes `bytes` as unpadded Crockford base32. */
function base32Encode(bytes: Buffer): string {
	let bitBuffer = 0;
	let bitCount = 0;
	let out = '';
	for (const byte of bytes) {
		bitBuffer = (bitBuffer << 8) | byte;
		bitCount += 8;
		while (bitCount >= 5) {
			out += CROCKFORD_ALPHABET[(bitBuffer >>> (bitCount - 5)) & 0x1f];
			bitCount -= 5;
		}
	}
	if (bitCount > 0) {
		out += CROCKFORD_ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
	}
	return out;
}

/**
 * The public room id the relay addresses its Durable Object by: `base32(HMAC-SHA256(secret,
 * 'room'))`, per the plan's "Auth" section. Deterministic from the room secret alone, so the
 * host never has to persist it separately.
 */
export function derivePublicRoomId(roomSecret: string): string {
	const digest = createHmac('sha256', roomSecret).update('room').digest();
	return base32Encode(digest);
}

/**
 * The bearer token this host presents to `/ws/host`: `HMAC-SHA256(secret, 'host')`,
 * base64url-encoded. This does not need to match the relay's own hashing algorithm — the
 * relay's TOFU (trust-on-first-use) claim only requires the same token be presented
 * identically on every reconnect, which deriving it from the stored secret guarantees.
 */
export function deriveHostToken(roomSecret: string): string {
	return createHmac('sha256', roomSecret).update('host').digest('base64url');
}
