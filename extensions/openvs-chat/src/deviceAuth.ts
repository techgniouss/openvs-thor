/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * RFC 8628 (OAuth 2.0 Device Authorization Grant) client, shared by the Copilot and Grok
 * sign-in flows in `providers/copilot.ts` / `providers/grok.ts`. Unlike this extension's
 * existing redirect-URI OAuth (`oauth.ts`), a device flow has no callback URL: the user is
 * shown a short code and a URL, approves it in any browser (not necessarily the one VS Code
 * would open), and this polls a token endpoint until that approval lands.
 *
 * ⚠️ Both call sites use this to authenticate as another vendor's own CLI/IDE client rather
 * than through a documented third-party integration surface — see the doc comments on
 * `CopilotProvider` and `GrokProvider` for what that means and why it was done anyway. This
 * module itself is protocol-neutral (a generic RFC 8628 client) and carries no such caveat
 * on its own.
 */

/** What a device-code request returns: the code to show the user and where to poll. */
export interface DeviceCodeResponse {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUri: string;
	readonly expiresInSeconds: number;
	readonly intervalSeconds: number;
}

/** Endpoints and identity for one device flow. */
export interface DeviceFlowConfig {
	readonly deviceCodeUrl: string;
	readonly tokenUrl: string;
	readonly clientId: string;
	readonly scope: string;
	/** Extra body fields the token poll needs beyond `client_id`/`grant_type`/`device_code`. */
	readonly extraTokenParams?: Record<string, string>;
}

/** What a completed device flow yields. */
export interface DeviceTokenResult {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt: number;
}

/** Starts a device flow: asks the provider for a code + verification URL to show the user. */
export async function requestDeviceCode(config: DeviceFlowConfig, signal: AbortSignal): Promise<DeviceCodeResponse> {
	const response = await fetch(config.deviceCodeUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
		body: new URLSearchParams({ client_id: config.clientId, scope: config.scope }).toString(),
		signal,
	});
	if (!response.ok) {
		throw new Error(`device code request failed: HTTP ${response.status}`);
	}
	const json = await response.json() as Record<string, unknown>;
	const deviceCode = json.device_code;
	const userCode = json.user_code;
	const verificationUri = json.verification_uri ?? json.verification_url;
	if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
		throw new Error('device code response missing device_code/user_code/verification_uri');
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		expiresInSeconds: Number(json.expires_in) || 900,
		intervalSeconds: Number(json.interval) || 5,
	};
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/**
 * Polls `config.tokenUrl` every `device.intervalSeconds` (backing off further on
 * `slow_down`, per RFC 8628 §3.5) until the user approves the code, denies it, or it
 * expires. Never retried past `access_denied`/`expired_token`/`expired_grant` — those are
 * terminal, unlike `authorization_pending`/`slow_down`. Rejects with a `DOMException` named
 * `'AbortError'` if `signal` fires first (a user-cancelled sign-in), same shape `isAbortError`
 * (`providers/types.ts`) already recognizes.
 */
export async function pollDeviceToken(
	config: DeviceFlowConfig,
	device: DeviceCodeResponse,
	signal: AbortSignal,
	onTick?: () => void,
): Promise<DeviceTokenResult> {
	let intervalMs = Math.max(1, device.intervalSeconds) * 1000;
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	for (; ;) {
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		if (Date.now() > deadline) {
			throw new Error('device code expired before it was approved');
		}
		onTick?.();
		let response: Response;
		try {
			response = await fetch(config.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
				body: new URLSearchParams({
					client_id: config.clientId,
					device_code: device.deviceCode,
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					...(config.extraTokenParams ?? {}),
				}).toString(),
				signal,
			});
		} catch {
			if (signal.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			// A dropped connection mid-poll says nothing about the grant — the user may already
			// have approved it in the browser. Keep polling until the code itself expires.
			await sleep(intervalMs, signal);
			continue;
		}
		const json = await response.json().catch(() => ({})) as Record<string, unknown>;
		if (response.ok && typeof json.access_token === 'string') {
			return {
				accessToken: json.access_token,
				refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
				expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
			};
		}
		const error = typeof json.error === 'string' ? json.error : '';
		if (error === 'access_denied') {
			throw new Error('sign-in was denied in the browser');
		}
		if (error === 'expired_token' || error === 'expired_grant') {
			throw new Error('device code expired before it was approved');
		}
		if (error === 'slow_down') {
			intervalMs += 5000;
		} else if (error && error !== 'authorization_pending') {
			// Any other stated error (invalid_client, unsupported_grant_type, …) is terminal per
			// RFC 8628 §3.5. Polling on used to leave the user watching "waiting for approval"
			// for the code's whole lifetime — fifteen minutes — over something no approval fixes.
			const detail = typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
			throw new Error(`sign-in failed (${error}${detail})`);
		}
		// authorization_pending, slow_down, or no stated error at all (a 5xx or a non-JSON
		// gateway page — transient): keep polling.
		await sleep(intervalMs, signal);
	}
}
