/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ModelEntry, ProviderInfo, apiFetch, describeHttpError } from './types';

/**
 * Stands in for the Cloudflare account id inside the default base URL. Cloudflare is the
 * only provider here whose credential is split in two — the API token goes in the
 * `Authorization` header like everywhere else, but the account id is part of the URL
 * *path* — so the id arrives from its own setting and the registry substitutes it here.
 */
export const CLOUDFLARE_ACCOUNT_PLACEHOLDER = '{account_id}';

/** Raised (as a normal Error) when the account id setting is still empty. */
const MISSING_ACCOUNT =
	'Cloudflare Workers AI: set "openvsChat.cloudflare.accountId" to your Cloudflare account ID. ' +
	'It is part of the request URL, so an API token alone is not enough — find it on the ' +
	'Workers & Pages overview page in the Cloudflare dashboard.';

/**
 * Provider for Cloudflare Workers AI through its OpenAI-compatible endpoint at
 * `api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1`.
 *
 * The free allocation — 10,000 Neurons per day — is the only one here that *renews*: it
 * resets daily rather than being a one-off grant, which on a small model is on the order
 * of a million input tokens a day and on a large one closer to a hundred thousand. No
 * credit card is needed for the allocation itself.
 *
 * Two credentials are required, unlike every other provider: an API token (header) and the
 * account id (URL path). See {@link CLOUDFLARE_ACCOUNT_PLACEHOLDER}.
 */
export class CloudflareProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'cloudflare',
		label: 'Cloudflare Workers AI (free tier)',
		// Function calling is a per-model property in Cloudflare's catalog and most of its
		// smaller checkpoints lack it, so every id here is one the catalog marks as
		// tool-capable — a suggestion that can't drive Agent mode just looks like Agent mode
		// is broken. `test-model-axes.mjs` enforces that.
		suggestedModels: [
			'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
			'@cf/openai/gpt-oss-120b',
			'@cf/openai/gpt-oss-20b',
			'@cf/meta/llama-4-scout-17b-16e-instruct',
			'@cf/mistralai/mistral-small-3.1-24b-instruct',
			'@cf/qwen/qwen3-30b-a3b-fp8',
			'@cf/zai-org/glm-4.7-flash',
			'@cf/google/gemma-4-26b-a4b-it',
		],
		apiKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
		requiresApiKey: true,
		supportsTools: true,
		// Function calling is a per-model property in Cloudflare's catalog, and most of the
		// smaller Llama/Gemma checkpoints do not have it. `listModels` reports the catalog's
		// own answer, which overrides these patterns whenever the list has been fetched.
		toolModelPatterns: [
			'llama-3\\.3', 'llama-4', 'gpt-oss', 'qwen3', 'mistral-small', 'glm', 'kimi',
			'nemotron', 'granite', 'gemma-4',
		],
		visionModelPatterns: ['scout', 'maverick', 'vision', 'gemma-4', 'kimi'],
	};

	/**
	 * Fails loudly rather than sending a request to a URL with `{account_id}` still in it,
	 * which Cloudflare answers with an opaque 400 that says nothing about the real problem.
	 */
	protected override url(baseUrl: string, path: string): string {
		if (!baseUrl || baseUrl.includes(CLOUDFLARE_ACCOUNT_PLACEHOLDER)) {
			throw new Error(MISSING_ACCOUNT);
		}
		return super.url(baseUrl, path);
	}

	/**
	 * Cloudflare's OpenAI-compatible surface has no `/models`; the catalog lives on the
	 * account's own REST API one level up, where it also reports each model's task and
	 * whether it supports function calling.
	 */
	override async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		if (!baseUrl || baseUrl.includes(CLOUDFLARE_ACCOUNT_PLACEHOLDER)) {
			throw new Error(MISSING_ACCOUNT);
		}
		// `.../ai/v1` → `.../ai/models/search`.
		const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
		const url = `${root}/models/search?task=Text+Generation&per_page=200&hide_experimental=false`;
		const response = await apiFetch(url, { method: 'GET', headers: this.authHeaders(apiKey) }, signal);
		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}
		const json = await response.json();
		const raw: unknown[] = Array.isArray(json?.result) ? json.result : [];
		const entries: ModelEntry[] = [];
		for (const item of raw) {
			const model = item as { name?: unknown; properties?: unknown };
			if (typeof model.name !== 'string' || !model.name) {
				continue;
			}
			entries.push({
				id: model.name,
				// The whole Text Generation catalog is served from the daily Neuron allocation.
				free: true,
				toolCapable: readFlag(model.properties, 'function_calling'),
				contextLength: readNumber(model.properties, 'context_window', 'max_total_tokens'),
			});
		}
		return entries.sort((a, b) => a.id.localeCompare(b.id));
	}
}

/** The `properties` array Cloudflare attaches to each catalog entry, when it has one. */
function properties(value: unknown): Array<{ property_id?: unknown; value?: unknown }> {
	return Array.isArray(value) ? value : [];
}

/** Reads a boolean-ish catalog property, or undefined when the catalog doesn't state one. */
function readFlag(props: unknown, id: string): boolean | undefined {
	for (const p of properties(props)) {
		if (p.property_id === id) {
			return p.value === true || p.value === 'true';
		}
	}
	return undefined;
}

/** Reads the first numeric catalog property named by `ids`, if any. */
function readNumber(props: unknown, ...ids: string[]): number | undefined {
	for (const p of properties(props)) {
		if (typeof p.property_id !== 'string' || !ids.includes(p.property_id)) {
			continue;
		}
		const parsed = typeof p.value === 'number' ? p.value : Number(p.value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}
