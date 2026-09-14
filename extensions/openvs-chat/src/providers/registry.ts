/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OAuthTokenStore } from '../oauth';
import { AnthropicProvider } from './anthropic';
import { AntigravityProvider } from './antigravity';
import { ClaudeCodeCliProvider } from './claudeCodeCli';
import { CLOUDFLARE_ACCOUNT_PLACEHOLDER, CloudflareProvider } from './cloudflare';
import { CooldownTracker } from './cooldown';
import { CopilotProvider } from './copilot';
import { CustomProvider } from './custom';
import { GeminiProvider } from './gemini';
import { GrokProvider } from './grok';
import { GroqProvider } from './groq';
import { KeyRotator } from './keyRotation';
import { KimiProvider } from './kimi';
import { KiroProvider } from './kiro';
import { MistralProvider } from './mistral';
import { NvidiaProvider } from './nvidia';
import { OpenAIProvider } from './openai';
import { OpenCodeZenProvider } from './opencodeZen';
import { OpenRouterProvider } from './openrouter';
import { QwenProvider } from './qwen';
import { ChatProvider, ModelEntry } from './types';
import { GeminiWebProvider } from './webCookie/geminiWebProvider';
import { XkiroProvider } from './xkiro';
import { ZaiProvider } from './zai';

const SECRET_PREFIX = 'openvsChat.apiKey.';
/** Backup keys for a provider, stored as a JSON string array. Rotated in on a 401/403/429
 * against the primary key — see {@link ProviderRegistry.rotateApiKey}. */
const EXTRA_KEY_PREFIX = 'openvsChat.apiKeysExtra.';

/**
 * Environment variables that can supply a provider's key, as a convenient escape hatch for
 * power users and CI. Each name is the one that provider's own SDK already reads, so an
 * environment set up for the vendor's CLI works here unchanged. Providers absent from this
 * map are configured through the panel only.
 */
const ENV_VARS: Record<string, string | undefined> = {
	openai: 'OPENAI_API_KEY',
	anthropic: 'ANTHROPIC_API_KEY',
	nvidia: 'NVIDIA_API_KEY',
	gemini: 'GEMINI_API_KEY',
	openrouter: 'OPENROUTER_API_KEY',
	kimi: 'MOONSHOT_API_KEY',
	qwen: 'DASHSCOPE_API_KEY',
	groq: 'GROQ_API_KEY',
	mistral: 'MISTRAL_API_KEY',
	cloudflare: 'CLOUDFLARE_API_TOKEN',
};

/**
 * Providers with no `<id>.baseUrl` setting in package.json, so the panel's base-URL field
 * has nothing to read or write. Antigravity is the OAuth-spoofing backend that never fully
 * worked and now bans real accounts (see AntigravityProvider) — it ignores the `baseUrl`
 * it's handed and talks to a hardcoded endpoint. Copilot, Grok and Kiro are the same
 * category of OAuth-proxy backend, each pinned to one endpoint (or, for Copilot, an
 * account-reported one) that a user-supplied base URL could not meaningfully redirect.
 * `claude-code-cli` has no HTTP endpoint at all to redirect — it spawns a local binary — so
 * it gets its own `claude-code-cli.cliPath` setting instead (see ClaudeCodeCliProvider).
 */
const NO_BASE_URL_SETTING = new Set(['antigravity', 'copilot', 'grok', 'kiro', 'web_gemini', 'claude-code-cli']);

/** Per-provider runtime configuration resolved from settings + secret storage. */
export interface ResolvedProviderConfig {
	readonly id: string;
	readonly label: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly suggestedModels: string[];
	readonly apiKeyUrl: string;
	readonly requiresApiKey: boolean;
	readonly hasApiKey: boolean;
	/** True when the key comes from an environment variable, which can't be cleared from the panel. */
	readonly hasEnvKey: boolean;
	readonly supportsTools: boolean;
	/** Regex sources (case-insensitive) marking which models support Agent mode. */
	readonly toolModelPatterns: string[];
	/** Regex sources (case-insensitive) marking which models accept image attachments. */
	readonly visionModelPatterns: string[];
	/** A configured web sign-in endpoint, if any (enables the "Sign in" button). */
	readonly authUrl: string;
	/** How the current credential was obtained: web sign-in, an API key, or nothing. */
	readonly authKind: 'oauth' | 'key' | 'none';
	/**
	 * Cloudflare Workers AI only: the account id `getBaseUrl` substitutes into the URL
	 * (a token alone can't authenticate — see `CLOUDFLARE_ACCOUNT_PLACEHOLDER`). Undefined
	 * for every other provider; the settings panel only renders the field when this is set.
	 */
	readonly cloudflareAccountId?: string;
	/**
	 * Raw `<id>.baseUrl` setting value, unlike {@link baseUrl} which is what requests
	 * actually use (trailing slash stripped, Cloudflare's `{account_id}` substituted). This
	 * is what the panel's base-URL field edits — substituting the placeholder into it and
	 * saving that back would bake today's account id in and break the substitution for the
	 * next one. Undefined for providers with no such setting (see `NO_BASE_URL_SETTING`).
	 */
	readonly baseUrlOverride?: string;
	/** How many backup keys are stored beyond the primary — see {@link EXTRA_KEY_PREFIX}. */
	readonly extraApiKeyCount: number;
}

/**
 * Owns the set of available chat providers and brokers access to their
 * configuration and (securely stored) API keys.
 */
export class ProviderRegistry {
	private readonly providers = new Map<string, ChatProvider>();
	/** OAuth sessions from the built-in web sign-in flows (Claude / ChatGPT accounts). */
	readonly oauth: OAuthTokenStore;
	/** Round-robins each provider's stored keys away from ones that just 401/403/429'd. */
	private readonly keyRotator = new KeyRotator();
	/** Per (provider, model) quota parking — see {@link CooldownTracker}. Public so
	 * `auto/router.ts` and `chatViewProvider.ts` can consult it without a registry method
	 * per call site. */
	readonly cooldowns = new CooldownTracker();

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.oauth = new OAuthTokenStore(secrets);
		for (const provider of [new NvidiaProvider(), new OpenAIProvider(), new AnthropicProvider(), new GeminiProvider(), new AntigravityProvider(), new OpenRouterProvider(), new GroqProvider(), new MistralProvider(), new CloudflareProvider(), new KimiProvider(), new QwenProvider(), new ZaiProvider(), new OpenCodeZenProvider(), new XkiroProvider(), new CopilotProvider(), new GrokProvider(), new KiroProvider(), new GeminiWebProvider(), new ClaudeCodeCliProvider(), new CustomProvider()]) {
			this.providers.set(provider.info.id, provider);
		}
	}

	get ids(): string[] {
		return [...this.providers.keys()];
	}

	getProvider(id: string): ChatProvider | undefined {
		return this.providers.get(id);
	}

	getDefaultProviderId(): string {
		const configured = vscode.workspace.getConfiguration('openvsChat').get<string>('defaultProvider');
		if (configured && this.providers.has(configured)) {
			return configured;
		}
		return this.ids[0];
	}

	getModel(id: string): string {
		const cfg = vscode.workspace.getConfiguration('openvsChat');
		const configured = cfg.get<string>(`${id}.model`);
		return configured?.trim() || this.providers.get(id)?.info.suggestedModels[0] || '';
	}

	getBaseUrl(id: string): string {
		const cfg = vscode.workspace.getConfiguration('openvsChat');
		const configured = (cfg.get<string>(`${id}.baseUrl`)?.trim() || '').replace(/\/+$/, '');
		if (id === 'cloudflare') {
			// Cloudflare is the one backend whose credential is split between a header and the
			// URL path, so the account id is substituted here — the single place the base URL is
			// resolved — rather than being threaded through every provider call. Left in place
			// when unset so the provider can raise a message that names the setting.
			const accountId = cfg.get<string>('cloudflare.accountId')?.trim();
			return accountId ? configured.replace(CLOUDFLARE_ACCOUNT_PLACEHOLDER, accountId) : configured;
		}
		return configured;
	}

	getAuthUrl(id: string): string {
		const cfg = vscode.workspace.getConfiguration('openvsChat');
		return (cfg.get<string>(`${id}.authUrl`)?.trim() || '');
	}

	getMaxTokens(): number {
		return vscode.workspace.getConfiguration('openvsChat').get<number>('maxTokens') ?? 8192;
	}

	getSystemPrompt(): string {
		return vscode.workspace.getConfiguration('openvsChat').get<string>('systemPrompt') ?? '';
	}

	/** The environment variable that can supply this provider's key, if any. */
	private envVarName(id: string): string | undefined {
		return ENV_VARS[id];
	}

	/** Whether this provider's key currently comes from an environment variable (takes precedence over, and can't be removed by, the stored secret). */
	hasEnvKey(id: string): boolean {
		const envName = this.envVarName(id);
		return !!(envName && process.env[envName]);
	}

	/**
	 * All usable keys for `id` in rotation order: the primary stored key first, then any
	 * backup keys from {@link getExtraApiKeys}. Empty when the provider authenticates via
	 * an environment variable or web sign-in instead of a pasted key — those aren't part of
	 * the rotation pool: an env var is a single fixed value, and a web sign-in session already
	 * refreshes itself independently of key rotation.
	 */
	async getApiKeys(id: string): Promise<string[]> {
		const envName = this.envVarName(id);
		if (envName && process.env[envName]) {
			return [];
		}
		const primary = await this.secrets.get(SECRET_PREFIX + id);
		if (!primary) {
			return [];
		}
		const extra = await this.getExtraApiKeys(id);
		return [primary, ...extra];
	}

	async getApiKey(id: string): Promise<string | undefined> {
		// Environment variables are a convenient escape hatch for power users / CI.
		const envName = this.envVarName(id);
		const fromEnv = envName ? process.env[envName] : undefined;
		if (fromEnv) {
			return fromEnv;
		}
		const keys = await this.getApiKeys(id);
		if (keys.length) {
			return keys[this.keyRotator.activeIndex(id, keys)];
		}
		// Web sign-in session, refreshed transparently when close to expiry.
		return this.oauth.getFreshAccessToken(id);
	}

	/**
	 * Call after a request against `id`'s current key failed with a 401/403/429. Marks that
	 * key errored and advances to the next stored key. Returns true when a *different* key is
	 * now active — the caller should re-resolve via {@link getApiKey} and retry the same
	 * request once. Returns false when there is no spare key (single-key or no-key providers),
	 * in which case the caller should treat the failure as final.
	 */
	async rotateApiKey(id: string): Promise<boolean> {
		const keys = await this.getApiKeys(id);
		return this.keyRotator.rotate(id, keys);
	}

	/** Drops `id`'s errored-key history after a successful call. See {@link KeyRotator.clear}. */
	noteApiKeySuccess(id: string): void {
		this.keyRotator.clear(id);
	}

	/** The provider's backup key pool, beyond the primary key — see {@link EXTRA_KEY_PREFIX}. */
	async getExtraApiKeys(id: string): Promise<string[]> {
		const raw = await this.secrets.get(EXTRA_KEY_PREFIX + id);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && k.trim().length > 0) : [];
		} catch {
			return [];
		}
	}

	/** Replaces the provider's backup key pool. An empty list clears the stored secret entirely
	 * rather than persisting an empty array, so `hasExtraApiKeys`-style checks stay simple. */
	async setExtraApiKeys(id: string, keys: string[]): Promise<void> {
		const cleaned = keys.map(k => k.trim()).filter(k => k.length > 0);
		if (cleaned.length) {
			await this.secrets.store(EXTRA_KEY_PREFIX + id, JSON.stringify(cleaned));
		} else {
			await this.secrets.delete(EXTRA_KEY_PREFIX + id);
		}
	}

	/** Whether any credential exists (env, key, or web sign-in) without refreshing tokens. */
	async hasCredentials(id: string): Promise<boolean> {
		return this.hasEnvKey(id)
			|| !!(await this.secrets.get(SECRET_PREFIX + id))
			|| !!(await this.oauth.get(id));
	}

	/** How the provider currently authenticates, for display purposes. */
	async getAuthKind(id: string): Promise<'oauth' | 'key' | 'none'> {
		if (this.hasEnvKey(id) || await this.secrets.get(SECRET_PREFIX + id)) {
			return 'key';
		}
		if (await this.oauth.get(id)) {
			return 'oauth';
		}
		return 'none';
	}

	async setApiKey(id: string, key: string): Promise<void> {
		await this.secrets.store(SECRET_PREFIX + id, key);
		// Pasting a key switches auth methods: drop any web sign-in session.
		await this.oauth.clear(id);
	}

	/** Makes a just-stored web sign-in session the active credential by dropping any stored API key. */
	async adoptOAuth(id: string): Promise<void> {
		await this.secrets.delete(SECRET_PREFIX + id);
	}

	async setModel(id: string, model: string): Promise<void> {
		await vscode.workspace.getConfiguration('openvsChat').update(
			`${id}.model`, model, vscode.ConfigurationTarget.Global);
	}

	/** Persists the Cloudflare account id — see `cloudflareAccountId` on {@link ResolvedProviderConfig}. */
	async setCloudflareAccountId(accountId: string): Promise<void> {
		await vscode.workspace.getConfiguration('openvsChat').update(
			'cloudflare.accountId', accountId.trim(), vscode.ConfigurationTarget.Global);
	}

	/**
	 * Persists a provider's base URL override, or clears it back to the package.json
	 * default when the field is emptied — an explicit empty string would otherwise win
	 * over that default rather than falling back to it.
	 */
	async setBaseUrl(id: string, value: string): Promise<void> {
		const trimmed = value.trim();
		await vscode.workspace.getConfiguration('openvsChat').update(
			`${id}.baseUrl`, trimmed || undefined, vscode.ConfigurationTarget.Global);
	}

	/** Fetches the live model list for a provider using its stored key (if it needs one). */
	async listModels(id: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const provider = this.providers.get(id);
		if (!provider) {
			throw new Error(`Unknown provider: ${id}`);
		}
		const apiKey = await this.getApiKey(id);
		if (!apiKey && provider.info.requiresApiKey) {
			throw new Error(`Set an API key for ${provider.info.label} first.`);
		}
		return provider.listModels(apiKey ?? '', this.getBaseUrl(id), signal);
	}

	async clearApiKey(id: string): Promise<void> {
		await this.secrets.delete(SECRET_PREFIX + id);
		await this.secrets.delete(EXTRA_KEY_PREFIX + id);
		await this.oauth.clear(id);
	}

	async resolve(id: string): Promise<ResolvedProviderConfig | undefined> {
		const provider = this.providers.get(id);
		if (!provider) {
			return undefined;
		}
		return {
			id,
			label: provider.info.label,
			model: this.getModel(id),
			baseUrl: this.getBaseUrl(id) || '',
			suggestedModels: provider.info.suggestedModels,
			apiKeyUrl: provider.info.apiKeyUrl,
			requiresApiKey: provider.info.requiresApiKey,
			hasApiKey: await this.hasCredentials(id),
			hasEnvKey: this.hasEnvKey(id),
			supportsTools: provider.info.supportsTools,
			toolModelPatterns: provider.info.toolModelPatterns,
			visionModelPatterns: provider.info.visionModelPatterns,
			authUrl: this.getAuthUrl(id),
			authKind: await this.getAuthKind(id),
			cloudflareAccountId: id === 'cloudflare'
				? (vscode.workspace.getConfiguration('openvsChat').get<string>('cloudflare.accountId')?.trim() ?? '')
				: undefined,
			baseUrlOverride: NO_BASE_URL_SETTING.has(id)
				? undefined
				: (vscode.workspace.getConfiguration('openvsChat').get<string>(`${id}.baseUrl`)?.trim() ?? ''),
			extraApiKeyCount: (await this.getExtraApiKeys(id)).length,
		};
	}

	async resolveAll(): Promise<ResolvedProviderConfig[]> {
		const result: ResolvedProviderConfig[] = [];
		for (const id of this.ids) {
			const resolved = await this.resolve(id);
			if (resolved) {
				result.push(resolved);
			}
		}
		return result;
	}
}
