/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OAuthProxyChatProvider } from './oauthProxy';
import { AgentRequest, AgentStep, ChatRequest, ModelEntry, ProviderInfo, StreamChatResult, apiFetch, describeHttpError } from './types';

/**
 * Provider for GitHub Copilot Chat's backend, called directly the way the VS Code Copilot
 * Chat extension itself does — NOT a documented public Copilot API (there isn't one for chat
 * completions). The stored credential is a GitHub OAuth device-flow token; each request
 * exchanges it for a short-lived Copilot token via `GET copilot_internal/v2/token` (cached
 * ~25 minutes by {@link OAuthProxyChatProvider}) and sends that instead.
 *
 * ⚠️ This impersonates the VS Code Copilot Chat client's identity rather than calling a
 * licensed integration surface. GitHub can rate-limit, suspend, or ban the Copilot account
 * behind this credential at their sole discretion, and every constant below (client id,
 * endpoint, header set) is an unversioned implementation detail that can change without
 * notice. Only added because the user asked for it explicitly, aware of this — see
 * `docs/superpowers/plans/2026-09-03-provider-oauth-and-cookie-integrations.md`. This is not
 * the sanctioned path; there is none for third-party Copilot Chat access. Same category of
 * decision as `AntigravityProvider`'s doc comment describes for Google Antigravity.
 *
 * Copilot **Free** allows roughly 50 chat requests/month; **Pro** removes the cap on the base
 * model. On a lapsed/free account, expect 401/403 rather than a working stream.
 */
export class CopilotProvider extends OAuthProxyChatProvider {
	readonly info: ProviderInfo = {
		id: 'copilot',
		label: 'GitHub Copilot (unofficial)',
		suggestedModels: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
		apiKeyUrl: 'https://github.com/settings/copilot',
		requiresApiKey: true,
		supportsTools: true,
		toolModelPatterns: [],
		visionModelPatterns: ['gpt-4o', 'gpt-4\\.1'],
	};

	private static readonly COPILOT_VERSION = '0.26.7';
	private static readonly VSCODE_VERSION = '1.98.0';
	private static readonly API_VERSION = '2025-04-01';
	private static readonly USER_AGENT = `GitHubCopilotChat/${CopilotProvider.COPILOT_VERSION}`;
	private static readonly EDITOR_PLUGIN_VERSION = `copilot-chat/${CopilotProvider.COPILOT_VERSION}`;
	private static readonly DEFAULT_API_HOST = 'https://api.githubcopilot.com';

	/** RFC 8628 device flow constants for the GitHub OAuth device grant Copilot Chat itself
	 * uses. Cross-checked against ericc-ch/copilot-api (src/lib/api-config.ts). */
	static readonly DEVICE_CODE_URL = 'https://github.com/login/device/code';
	static readonly TOKEN_URL = 'https://github.com/login/oauth/access_token';
	static readonly CLIENT_ID = 'Iv1.b507a08c87ecfe98';
	static readonly SCOPE = 'read:user';

	/** Host the last successful token mint said to use — an individual account is issued
	 * `api.individual.githubcopilot.com`, not the bare `api.githubcopilot.com` some
	 * community proxies hardcode. Falls back to the bare host before the first mint.
	 * Per-instance (not module-global): every credential in a pool is the same product, but
	 * keeping it on the instance avoids one provider's mint silently deciding another
	 * hypothetical instance's host. */
	private lastApiHost = CopilotProvider.DEFAULT_API_HOST;

	protected async mintToken(githubToken: string, signal: AbortSignal): Promise<{ token: string; expiresAt: number }> {
		const response = await apiFetch('https://api.github.com/copilot_internal/v2/token', {
			method: 'GET',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json',
				// NOTE: "token", not "Bearer" — this endpoint rejects the Bearer form outright.
				'authorization': `token ${githubToken}`,
				'editor-version': `vscode/${CopilotProvider.VSCODE_VERSION}`,
				'editor-plugin-version': CopilotProvider.EDITOR_PLUGIN_VERSION,
				'user-agent': CopilotProvider.USER_AGENT,
				'x-github-api-version': CopilotProvider.API_VERSION,
				'x-vscode-user-agent-library-version': 'electron-fetch',
			},
		}, signal, { timeoutMs: 15_000, retries: 0 });
		if (!response.ok) {
			throw new Error(await describeHttpError('GitHub Copilot', response));
		}
		const body = await response.json() as { token?: string; expires_at?: number; chat_enabled?: boolean; endpoints?: { api?: string } };
		if (body.chat_enabled === false) {
			throw new Error('GitHub Copilot: this account has chat_enabled=false — Copilot Chat is not available on it.');
		}
		if (!body.token) {
			throw new Error('GitHub Copilot: token exchange returned no token.');
		}
		if (body.endpoints?.api) {
			this.lastApiHost = body.endpoints.api.replace(/\/+$/, '');
		}
		return { token: body.token, expiresAt: (body.expires_at ?? 0) * 1000 };
	}

	/** Every one of these is load-bearing — dropping `copilot-integration-id` or
	 * `editor-version` returns HTTP 403 even with a perfectly valid token. */
	protected override authHeaders(wireToken: string): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${wireToken}`,
			'copilot-integration-id': 'vscode-chat',
			'editor-version': `vscode/${CopilotProvider.VSCODE_VERSION}`,
			'editor-plugin-version': CopilotProvider.EDITOR_PLUGIN_VERSION,
			'user-agent': CopilotProvider.USER_AGENT,
			'openai-intent': 'conversation-panel',
			'x-github-api-version': CopilotProvider.API_VERSION,
			'x-request-id': crypto.randomUUID(),
			'x-vscode-user-agent-library-version': 'electron-fetch',
		};
	}

	// The three entry points below resolve the wire token from the STORED GitHub token first
	// (request.apiKey), then delegate to OpenAICompatibleProvider's already-correct
	// streaming/parsing logic with that token substituted in. See OAuthProxyChatProvider's
	// class doc for why this can't instead be done inside the synchronous `authHeaders`.

	override async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		const token = await this.wireToken(request.apiKey, request.signal);
		return super.streamChat({ ...request, apiKey: token, baseUrl: this.lastApiHost });
	}

	override async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		const token = await this.wireToken(request.apiKey, request.signal);
		return super.runAgentStep({ ...request, apiKey: token, baseUrl: this.lastApiHost });
	}

	override async listModels(apiKey: string, _baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		if (!apiKey) {
			return this.info.suggestedModels.map(id => ({ id }));
		}
		const token = await this.wireToken(apiKey, signal);
		return super.listModels(token, this.lastApiHost, signal);
	}
}
