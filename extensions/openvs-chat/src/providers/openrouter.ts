/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ModelEntry, ProviderInfo, apiFetch, describeHttpError } from './types';

/** The subset of OpenRouter's `/models` catalog entry we read. */
interface OpenRouterCatalogModel {
	readonly id?: string;
	readonly pricing?: { readonly prompt?: string | number; readonly completion?: string | number };
	readonly supported_parameters?: readonly string[];
	readonly context_length?: number;
}

/**
 * Provider for OpenRouter (openrouter.ai), a gateway that exposes hundreds of models
 * (Claude, GPT, Gemini, Llama, Kimi, Qwen, DeepSeek, …) behind one OpenAI-compatible
 * API and one key. Many models have a `:free` variant. Besides pasting a key
 * (openrouter.ai/settings/keys), users can log in with one click via OpenRouter's
 * PKCE flow (see `signInOpenRouter` in oauth.ts), which mints a key for them.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'openrouter',
		label: 'OpenRouter (all models)',
		suggestedModels: [
			'anthropic/claude-sonnet-4.5',
			'openai/gpt-4o-mini',
			'google/gemini-2.5-flash',
			'deepseek/deepseek-chat-v3-0324:free',
			'moonshotai/kimi-k2:free',
			'qwen/qwen3-coder:free',
			'meta-llama/llama-3.3-70b-instruct:free',
		],
		apiKeyUrl: 'https://openrouter.ai/settings/keys',
		requiresApiKey: true,
		supportsTools: true,
		// Tool calling varies per underlying model; allowlist the known function-calling families.
		toolModelPatterns: [
			'claude', 'gpt-', '^openai/o[0-9]', 'gemini', 'deepseek',
			'kimi', 'qwen', 'llama-3\\.[13]', 'mistral', 'grok', 'command',
		],
		visionModelPatterns: [
			'claude', 'gpt-4o', 'gpt-4\\.1', 'gpt-5', '^openai/o[0-9]',
			'gemini', 'pixtral', '-vl', 'vision', 'omni', 'llama-3\\.2',
		],
	};

	protected override extraHeaders(): Record<string, string> {
		// App attribution headers recommended by OpenRouter (shown on their rankings).
		return { 'HTTP-Referer': 'https://github.com/openvs', 'X-Title': 'OpenVS Thor' };
	}

	/**
	 * OpenRouter's `/models` catalog reports per-model pricing and supported parameters,
	 * so free models and tool-calling capability come from the API itself instead of the
	 * heuristic patterns: zero prompt+completion pricing (or a `:free` id) marks a model
	 * free, and `supported_parameters` containing "tools" marks it Agent-capable.
	 */
	override async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const response = await apiFetch(this.url(baseUrl, '/models'), {
			method: 'GET',
			headers: this.authHeaders(apiKey),
		}, signal);
		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}
		const json = await response.json();
		const data: OpenRouterCatalogModel[] = Array.isArray(json?.data) ? json.data : [];
		return data
			.filter((m): m is OpenRouterCatalogModel & { id: string } => typeof m?.id === 'string')
			.map(m => {
				const prompt = Number(m.pricing?.prompt ?? NaN);
				const completion = Number(m.pricing?.completion ?? NaN);
				const free = m.id.endsWith(':free') || (prompt === 0 && completion === 0);
				const contextLength = typeof m.context_length === 'number' && m.context_length > 0
					? m.context_length
					: undefined;
				const entry: ModelEntry = Array.isArray(m.supported_parameters)
					? { id: m.id, free, contextLength, toolCapable: m.supported_parameters.includes('tools') }
					: { id: m.id, free, contextLength };
				return entry;
			})
			.sort((a, b) => a.id.localeCompare(b.id));
	}
}
