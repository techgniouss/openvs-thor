/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeviceFlowConfig } from '../deviceAuth';
import { OAuthProxyChatProvider, WireSession } from './oauthProxy';
import { AgentRequest, AgentStep, ChatRequest, ModelEntry, ProviderInfo, StreamChatResult } from './types';

/** The credential this provider stores (as a JSON string via `registry.setApiKey`). Kept as
 * one JSON blob rather than three secret slots so key rotation (Phase 1) — which round-robins
 * whole stored strings — treats one Grok account as one rotation-pool entry, the same as
 * every other provider's plain API key. */
interface GrokCredential {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt: number;
}

function parseCredential(stored: string): GrokCredential {
	try {
		const parsed = JSON.parse(stored) as Partial<GrokCredential>;
		if (typeof parsed.accessToken === 'string') {
			return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt ?? 0 };
		}
	} catch {
		// fall through
	}
	throw new Error('xAI Grok: stored credential is not a valid Grok sign-in — sign in again.');
}

/**
 * Provider for xAI Grok via the Grok CLI's own OAuth identity, calling
 * `cli-chat-proxy.grok.com` directly rather than the public `api.x.ai` surface — NOT a
 * documented public Grok API integration.
 *
 * ⚠️ This impersonates the Grok CLI's client identity (client id, required
 * `x-grok-client-*` headers) rather than calling a licensed integration surface. xAI can
 * rate-limit, suspend, or ban the account behind this credential at their sole discretion.
 * **Unverified end-to-end** — transcribed from a public reference implementation
 * (`router-for-me/CLIProxyAPI`), never run against a live xAI account. Only added because the
 * user asked for it explicitly, aware of this — see
 * `docs/superpowers/plans/2026-09-03-provider-oauth-and-cookie-integrations.md`.
 *
 * Serves exactly ONE model (`grok-4.6`) — `cli-chat-proxy.grok.com`'s catalog is not the
 * full public xAI model line, so `listModels` is not overridden; the inherited
 * `OpenAICompatibleProvider.listModels` would hit a `/models` endpoint this gateway may not
 * expose the same way, and `suggestedModels` below is already the complete, correct list.
 */
export class GrokProvider extends OAuthProxyChatProvider {
	readonly info: ProviderInfo = {
		id: 'grok',
		label: 'xAI Grok (CLI identity, unofficial)',
		suggestedModels: ['grok-4.6'],
		apiKeyUrl: 'https://x.ai',
		requiresApiKey: true,
		// Unverified — cli-chat-proxy's tool-calling support is not confirmed against a live
		// account, and a wrong "yes" here would offer Agent mode against an endpoint that
		// silently ignores `tools` rather than erroring, which is worse than not offering it.
		supportsTools: false,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};

	static readonly CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
	static readonly ISSUER = 'https://auth.x.ai';
	/**
	 * Scopes are NOT optional. Omitting any of these fails in three separate ways that all
	 * look like account problems (measured against a companion project's own device-flow
	 * collection): `cli-chat-proxy.grok.com` 403s "User does not have Grok Code CLI
	 * permission", `api.x.ai` 403s "OAuth2 token missing required scope: api:access", and no
	 * `refresh_token` is ever issued at all without `offline_access`.
	 */
	static readonly SCOPE = 'openid profile email offline_access grok-cli:access api:access';
	private static readonly API_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
	private static readonly CLIENT_VERSION = '0.2.120';

	/**
	 * Every header below is load-bearing. Without them the endpoint answers HTTP 426 ("Your
	 * Grok CLI version (none) is outdated..."). `x-grok-client-version` (not
	 * `-cli-version`), `X-XAI-Token-Auth`, and `x-grok-client-identifier` are transcribed
	 * from `router-for-me/CLIProxyAPI`'s `internal/runtime/executor/xai_executor.go`.
	 */
	private wireAuthHeaders(token: string): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/json',
			'Connection': 'Keep-Alive',
			'X-XAI-Token-Auth': 'xai-grok-cli',
			'x-grok-client-version': GrokProvider.CLIENT_VERSION,
			'x-grok-client-identifier': 'grok-shell',
			'x-authenticateresponse': 'authenticate-response',
			'User-Agent': `xai-grok-workspace/${GrokProvider.CLIENT_VERSION}`,
		};
	}

	protected override authHeaders(wireToken: string): Record<string, string> {
		return this.wireAuthHeaders(wireToken);
	}

	private cachedTokenEndpoint = '';
	private async discoverTokenEndpoint(signal: AbortSignal): Promise<string> {
		if (this.cachedTokenEndpoint) {
			return this.cachedTokenEndpoint;
		}
		this.cachedTokenEndpoint = (await GrokProvider.discoverOidcDocument(signal)).token_endpoint;
		return this.cachedTokenEndpoint;
	}

	/** Fetches xAI's OIDC discovery document. xAI publishes these endpoints rather than
	 * fixing them, so this discovers instead of hardcoding and going stale. */
	private static async discoverOidcDocument(signal: AbortSignal): Promise<{ device_authorization_endpoint: string; token_endpoint: string }> {
		const response = await fetch(`${GrokProvider.ISSUER}/.well-known/openid-configuration`, { signal });
		if (!response.ok) {
			throw new Error(`xAI Grok: OIDC discovery HTTP ${response.status}`);
		}
		const doc = await response.json() as { device_authorization_endpoint?: string; token_endpoint?: string };
		if (!doc.device_authorization_endpoint || !doc.token_endpoint) {
			throw new Error('xAI Grok: OIDC discovery did not return the expected endpoints.');
		}
		return { device_authorization_endpoint: doc.device_authorization_endpoint, token_endpoint: doc.token_endpoint };
	}

	/** Builds the {@link DeviceFlowConfig} for signing in — called once, up front, by the
	 * "Sign in" flow (`deviceSignIn.ts`'s `signInWithDeviceFlow`), not per request. */
	static async discoverDeviceFlowConfig(signal: AbortSignal): Promise<DeviceFlowConfig> {
		const endpoints = await GrokProvider.discoverOidcDocument(signal);
		return {
			deviceCodeUrl: endpoints.device_authorization_endpoint,
			tokenUrl: endpoints.token_endpoint,
			clientId: GrokProvider.CLIENT_ID,
			scope: GrokProvider.SCOPE,
		};
	}

	protected async mintToken(storedCredential: string, signal: AbortSignal): Promise<WireSession> {
		const cred = parseCredential(storedCredential);
		if (cred.accessToken && cred.expiresAt - Date.now() > 5 * 60_000) {
			return { token: cred.accessToken, expiresAt: cred.expiresAt };
		}
		if (!cred.refreshToken) {
			throw new Error('xAI Grok: credential has no refresh token — sign in again.');
		}
		const tokenEndpoint = await this.discoverTokenEndpoint(signal);
		const response = await fetch(tokenEndpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: GrokProvider.CLIENT_ID, grant_type: 'refresh_token', refresh_token: cred.refreshToken }).toString(),
			signal,
		});
		if (!response.ok) {
			throw new Error(`xAI Grok: token refresh HTTP ${response.status}`);
		}
		const body = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
		if (!body.access_token) {
			throw new Error('xAI Grok: token refresh returned no access_token.');
		}
		const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
		// Saved back (see `setCredentialPersister`), with the new refresh token when the issuer
		// rotated it: the old one is then spent, and refreshing from it forced a new sign-in.
		const updated: GrokCredential = { accessToken: body.access_token, refreshToken: body.refresh_token || cred.refreshToken, expiresAt };
		return { token: body.access_token, expiresAt, updatedCredential: JSON.stringify(updated) };
	}

	override async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		return this.withWireSession(request.apiKey, request.signal,
			session => super.streamChat({ ...request, apiKey: session.token, baseUrl: GrokProvider.API_BASE_URL }));
	}

	override async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		return this.withWireSession(request.apiKey, request.signal,
			session => super.runAgentStep({ ...request, apiKey: session.token, baseUrl: GrokProvider.API_BASE_URL }));
	}

	// No documented /models endpoint for this gateway, and the inherited
	// OpenAICompatibleProvider.listModels would send the STORED credential (unminted) as a
	// bearer token rather than exchanging it first — always failing. The catalog is one
	// model anyway, so this returns it directly instead of attempting a live fetch.
	override async listModels(): Promise<ModelEntry[]> {
		return this.info.suggestedModels.map(id => ({ id }));
	}
}
