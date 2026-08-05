/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { signInAnthropic, signInAntigravity, signInOpenAI, signInOpenRouter, supportsNativeSignIn } from './oauth';
import { ProviderRegistry } from './providers/registry';

const CALLBACK_PATH = '/auth-callback';
const TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
	readonly providerId: string;
	resolve(token: string | undefined): void;
}

/**
 * Implements a generic web sign-in flow: open a configured auth URL in the browser,
 * let the user authenticate, and receive a token back via the editor's URI handler
 * (`<scheme>://openvs.openvs-chat/auth-callback`). The token is stored as the
 * provider's API key. This works with any backend you point `openvsChat.<id>.authUrl`
 * at (your own proxy/OAuth service), so users can "log in" instead of pasting a key.
 */
export class WebAuthManager implements vscode.UriHandler {
	private readonly pending = new Map<string, Pending>();

	constructor(private readonly registry: ProviderRegistry) { }

	handleUri(uri: vscode.Uri): void {
		if (uri.path !== CALLBACK_PATH) {
			return;
		}
		const params = new URLSearchParams(uri.query);
		const fragment = new URLSearchParams(uri.fragment);
		const state = params.get('state') ?? fragment.get('state') ?? '';
		const token = params.get('token') ?? params.get('access_token') ?? params.get('key')
			?? fragment.get('token') ?? fragment.get('access_token') ?? fragment.get('key') ?? undefined;
		const entry = this.pending.get(state);
		if (entry) {
			this.pending.delete(state);
			entry.resolve(token ?? undefined);
		}
	}

	/**
	 * Starts the sign-in flow for a provider. Returns true if a token was received
	 * and stored. Throws if no auth URL is configured for the provider.
	 */
	async signIn(providerId: string): Promise<boolean> {
		const authUrl = this.registry.getAuthUrl(providerId);
		if (!authUrl) {
			// No custom auth backend configured: fall back to the provider's own
			// account login when we have a built-in flow for it.
			if (supportsNativeSignIn(providerId)) {
				return this.nativeSignIn(providerId);
			}
			throw new Error('No web sign-in URL is configured for this provider. Set "openvsChat.' + providerId + '.authUrl" or add an API key instead.');
		}

		const state = `${providerId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const callbackUri = await vscode.env.asExternalUri(
			vscode.Uri.parse(`${vscode.env.uriScheme}://openvs.openvs-chat${CALLBACK_PATH}?state=${encodeURIComponent(state)}`),
		);

		const target = new URL(authUrl);
		target.searchParams.set('redirect_uri', callbackUri.toString(true));
		target.searchParams.set('state', state);
		target.searchParams.set('provider', providerId);

		const tokenPromise = new Promise<string | undefined>((resolve, reject) => {
			this.pending.set(state, { providerId, resolve });
			setTimeout(() => {
				if (this.pending.has(state)) {
					this.pending.delete(state);
					reject(new Error('Sign-in timed out. Please try again.'));
				}
			}, TIMEOUT_MS);
		});

		const opened = await vscode.env.openExternal(vscode.Uri.parse(target.toString()));
		if (!opened) {
			this.pending.delete(state);
			throw new Error('Could not open the sign-in page in a browser.');
		}

		const token = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Signing in to ${providerId}…`, cancellable: true },
			(_progress, cancel) => {
				cancel.onCancellationRequested(() => {
					const entry = this.pending.get(state);
					if (entry) {
						this.pending.delete(state);
						entry.resolve(undefined);
					}
				});
				return tokenPromise;
			},
		);

		if (!token) {
			return false;
		}
		await this.registry.setApiKey(providerId, token);
		return true;
	}

	/**
	 * Signs in with the provider's own consumer account (Claude / ChatGPT) via the
	 * built-in OAuth flows in `oauth.ts`, so a paid subscription can be used without
	 * an API key. Returns true when a credential was stored.
	 */
	private async nativeSignIn(providerId: string): Promise<boolean> {
		if (providerId === 'anthropic') {
			const ok = await signInAnthropic(this.registry.oauth);
			if (ok) {
				await this.registry.adoptOAuth(providerId);
			}
			return ok;
		}
		if (providerId === 'antigravity') {
			const ok = await signInAntigravity(this.registry.oauth);
			if (ok) {
				await this.registry.adoptOAuth(providerId);
			}
			return ok;
		}
		if (providerId === 'openrouter') {
			// The PKCE flow mints a real, user-controlled API key: store it like a pasted key.
			const key = await signInOpenRouter();
			if (!key) {
				return false;
			}
			await this.registry.setApiKey(providerId, key);
			return true;
		}
		const result = await signInOpenAI(this.registry.oauth);
		if (!result) {
			return false;
		}
		if (result.mode === 'apiKey' && result.apiKey) {
			// The account has API access: a real key was minted, which works with
			// every OpenAI endpoint. Store it like a pasted key.
			await this.registry.setApiKey(providerId, result.apiKey);
		} else {
			await this.registry.adoptOAuth(providerId);
		}
		return true;
	}
}
