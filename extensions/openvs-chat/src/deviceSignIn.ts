/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DeviceFlowConfig, DeviceTokenResult, pollDeviceToken, requestDeviceCode } from './deviceAuth';

/**
 * Runs an RFC 8628 device-flow sign-in with native VS Code UI: a cancellable progress
 * notification shows the user code (also copied to the clipboard) and opens the
 * verification URL in the browser, then polls until approved. Used by the Copilot and Grok
 * "Sign in" buttons (`chatViewProvider.ts`'s `handleSignIn`) — no webview changes were
 * needed since every provider card already posts the same generic `signIn` message.
 *
 * `config` may be a thunk (Grok's endpoints are OIDC-discovered, not fixed) — resolved
 * *inside* the progress notification so a slow/hanging discovery call still shows a
 * cancel button, rather than leaving the user staring at nothing between clicking
 * "Sign in" and the notification appearing.
 *
 * Returns undefined on user cancellation; propagates any other failure (network error,
 * denial, expiry) as a thrown `Error` for the caller to show via
 * `vscode.window.showErrorMessage`.
 */
export async function signInWithDeviceFlow(
	providerLabel: string,
	config: DeviceFlowConfig | ((signal: AbortSignal) => Promise<DeviceFlowConfig>),
): Promise<DeviceTokenResult | undefined> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Sign in to ${providerLabel}`, cancellable: true },
		async (progress, cancellation) => {
			const controller = new AbortController();
			cancellation.onCancellationRequested(() => controller.abort());
			try {
				const resolvedConfig = typeof config === 'function' ? await config(controller.signal) : config;
				const device = await requestDeviceCode(resolvedConfig, controller.signal);
				await vscode.env.clipboard.writeText(device.userCode);
				await vscode.env.openExternal(vscode.Uri.parse(device.verificationUri));
				progress.report({ message: `Code ${device.userCode} (copied to clipboard) — approve it at ${device.verificationUri}` });
				return await pollDeviceToken(resolvedConfig, device, controller.signal, () => {
					progress.report({ message: `Waiting for you to approve code ${device.userCode}…` });
				});
			} catch (err) {
				// A user-cancelled sign-in is not a failure to report — every other rejection
				// (denial, expiry, network error) propagates for the caller to surface.
				if (controller.signal.aborted) {
					return undefined;
				}
				throw err;
			}
		},
	);
}

/** Where Kiro's own IDE/CLI writes its token after a normal sign-in there. */
function kiroAuthTokenPath(): string {
	return path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
}

/**
 * Reads Kiro's own credential file and returns the JSON blob `KiroProvider.mintToken`
 * expects (`{ accessToken, refreshToken?, expiresAt, region? }`), stringified — this
 * provider never implements a sign-in flow of its own, only an import (Kiro's IDE/CLI must
 * be signed in separately first). Throws with a message naming the expected path when the
 * file is missing or malformed, so the error shown to the user says exactly what to do.
 */
export async function importKiroCredential(): Promise<string> {
	const filePath = kiroAuthTokenPath();
	let raw: string;
	try {
		raw = await fs.promises.readFile(filePath, 'utf8');
	} catch {
		throw new Error(`No Kiro credential found at ${filePath}. Sign in with Kiro's own IDE or CLI first, then try again.`);
	}
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new Error(`${filePath} is not valid JSON.`);
	}
	const accessToken = json.accessToken ?? json.access_token;
	if (typeof accessToken !== 'string' || !accessToken) {
		throw new Error(`${filePath} has no accessToken.`);
	}
	const refreshToken = json.refreshToken ?? json.refresh_token;
	const rawExpiry = json.expiresAt ?? json.expires_at;
	const expiresAt = typeof rawExpiry === 'number' ? rawExpiry
		: typeof rawExpiry === 'string' ? (Date.parse(rawExpiry) || 0)
			: 0;
	const region = json.region;
	return JSON.stringify({
		accessToken,
		refreshToken: typeof refreshToken === 'string' ? refreshToken : undefined,
		expiresAt,
		region: typeof region === 'string' ? region : undefined,
	});
}
