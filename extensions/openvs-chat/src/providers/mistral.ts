/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { shortToolCallId } from './toolCalls';
import { ModelEntry, ProviderInfo } from './types';

/**
 * Provider for Mistral's La Plateforme API, which speaks the OpenAI Chat Completions
 * shape at `api.mistral.ai/v1`. The free "Experiment" tier needs no credit card and
 * reaches every model, in exchange for opting in to having your data used for training
 * (a checkbox during signup) — the trade is worth stating plainly, because it is the one
 * meaningful difference from the other free tiers here. Create a key at
 * console.mistral.ai/api-keys.
 *
 * Rate limits are not published as fixed numbers and are shown per organization in the
 * Admin Console under Limits; reports put the free tier around 1 request/second with a
 * large monthly token allowance, which makes it the roomiest free option for long agent
 * runs but the twitchiest for bursts. {@link apiFetch} absorbs the resulting 429s.
 */
export class MistralProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'mistral',
		label: 'Mistral (free tier)',
		// The `-latest` aliases track whichever snapshot Mistral currently points them at, so
		// they don't go stale here. `listModels` returns the account's authoritative catalog.
		suggestedModels: [
			'mistral-large-latest',
			'mistral-medium-latest',
			'mistral-small-latest',
			'codestral-latest',
			'ministral-8b-latest',
			'ministral-3b-latest',
		],
		apiKeyUrl: 'https://console.mistral.ai/api-keys',
		requiresApiKey: true,
		supportsTools: true,
		// Every current Mistral instruct/coding model supports function calling; the catalog
		// also carries embedding, moderation, OCR and audio models, which `listModels` filters.
		toolModelPatterns: [],
		// The current generation is multimodal across the board, but the catalog still serves
		// older text-only checkpoints (open-mistral-7b, open-mixtral-*, mistral-tiny) that
		// reject an image outright. Matched on the family rather than the version, so the
		// `-latest` aliases — which is what the picker offers — are covered too.
		visionModelPatterns: ['pixtral', 'mistral-large', 'mistral-medium', 'mistral-small', 'ministral'],
		// Codestral is the only Mistral family served by the FIM endpoint; the instruct
		// models reject it. Devstral is listed because the catalog serves it under both
		// names depending on tier.
		fimModelPatterns: ['codestral', 'devstral'],
	};

	/**
	 * The `^[a-zA-Z0-9]{9}$` id constraint is enforced by *this API*, not by the models
	 * behind it, so it applies to every model served here — including any whose id the
	 * base class's model-name test wouldn't recognize. See {@link shortToolCallId}.
	 */
	protected override toolCallId(id: string): string {
		return shortToolCallId(id);
	}

	/**
	 * Mistral serves fill-in-the-middle at its own path rather than the legacy
	 * `/completions` endpoint, which La Plateforme does not expose at all.
	 */
	protected override fimUrl(baseUrl: string): string {
		return this.url(baseUrl, '/fim/completions');
	}

	override async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const entries = await super.listModels(apiKey, baseUrl, signal);
		const chat = entries.filter(e => !/(embed|moderation|ocr|voxtral|tts|whisper)/i.test(e.id));
		// The Experiment tier reaches every model; there is no per-model free/paid split.
		return (chat.length ? chat : entries).map(e => ({ ...e, free: true }));
	}
}
