/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OAuthTokenStore } from '../oauth';
import { AnthropicProvider } from './anthropic';
import { CustomProvider } from './custom';
import { KimiProvider } from './kimi';
import { NvidiaProvider } from './nvidia';
import { OpenAIProvider } from './openai';
import { OpenRouterProvider } from './openrouter';
import { QwenProvider } from './qwen';
import { ChatProvider, ModelEntry } from './types';

const SECRET_PREFIX = 'openvsChat.apiKey.';

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
}

/**
 * Owns the set of available chat providers and brokers access to their
 * configuration and (securely stored) API keys.
 */
export class ProviderRegistry {
	private readonly providers = new Map<string, ChatProvider>();
	/** OAuth sessions from the built-in web sign-in flows (Claude / ChatGPT accounts). */
	readonly oauth: OAuthTokenStore;

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.oauth = new OAuthTokenStore(secrets);
		for (const provider of [new NvidiaProvider(), new OpenAIProvider(), new AnthropicProvider(), new OpenRouterProvider(), new KimiProvider(), new QwenProvider(), new CustomProvider()]) {
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
		const configured = cfg.get<string>(`${id}.baseUrl`);
		return (configured?.trim() || '').replace(/\/+$/, '');
	}

	getAuthUrl(id: string): string {
		const cfg = vscode.workspace.getConfiguration('openvsChat');
		return (cfg.get<string>(`${id}.authUrl`)?.trim() || '');
	}

	getMaxTokens(): number {
		return vscode.workspace.getConfiguration('openvsChat').get<number>('maxTokens') ?? 2048;
	}

	getSystemPrompt(): string {
		return vscode.workspace.getConfiguration('openvsChat').get<string>('systemPrompt') ?? '';
	}

	/** The environment variable that can supply this provider's key, if any. */
	private envVarName(id: string): string | undefined {
		return id === 'openai' ? 'OPENAI_API_KEY'
			: id === 'anthropic' ? 'ANTHROPIC_API_KEY'
				: id === 'nvidia' ? 'NVIDIA_API_KEY'
					: id === 'openrouter' ? 'OPENROUTER_API_KEY'
						: id === 'kimi' ? 'MOONSHOT_API_KEY'
							: id === 'qwen' ? 'DASHSCOPE_API_KEY'
								: undefined;
	}

	/** Whether this provider's key currently comes from an environment variable (takes precedence over, and can't be removed by, the stored secret). */
	hasEnvKey(id: string): boolean {
		const envName = this.envVarName(id);
		return !!(envName && process.env[envName]);
	}

	async getApiKey(id: string): Promise<string | undefined> {
		// Environment variables are a convenient escape hatch for power users / CI.
		const envName = this.envVarName(id);
		const fromEnv = envName ? process.env[envName] : undefined;
		if (fromEnv) {
			return fromEnv;
		}
		const stored = await this.secrets.get(SECRET_PREFIX + id);
		if (stored) {
			return stored;
		}
		// Web sign-in session, refreshed transparently when close to expiry.
		return this.oauth.getFreshAccessToken(id);
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
