/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ModelEntry, ProviderInfo } from './types';

/**
 * Google's `/v1beta/openai/models` catalog mixes chat models in with embedding, Imagen,
 * Veo and TTS models that all fail (confusingly) if picked in a chat — the same problem
 * NVIDIA's catalog has; see `NON_CHAT_MODEL` in nvidia.ts. `imagen` (Google's dedicated
 * image-gen line) is distinct from `-image` chat models like `gemini-3-pro-image-preview`
 * ("nano banana"), which stay in the list — the pattern below only matches the former.
 */
const NON_CHAT_MODEL = /(embed|imagen|veo-|-tts\b|^aqa$)/i;

/**
 * Provider for Google's Gemini models via the official OpenAI-compatibility endpoint at
 * `generativelanguage.googleapis.com/v1beta/openai` — a real `AIza...` API key from
 * Google AI Studio, not the OAuth-proxy route. Google itself directs third-party coding
 * tools to this endpoint: since 2026-06-18 Gemini Code Assist for individuals no longer
 * serves the Gemini CLI / Antigravity OAuth clients outside Google's own Antigravity
 * suite, and using an Antigravity-authenticated session from a third-party agent violates
 * Antigravity's ToS (confirmed account-ban risk, including on paid tiers) — see
 * `docs/superpowers/specs/2026-07-18-antigravity-provider-design.md` for the closed
 * OAuth attempt this provider deliberately avoids repeating.
 */
export class GeminiProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'gemini',
		label: 'Google Gemini',
		// Curated from a live sweep against generativelanguage.googleapis.com's own
		// /v1beta/models catalog (not the internal Code Assist API antigravity.ts talks
		// to — different product surface, different model ids; `gemini-3-pro` and
		// `gemini-3.6-flash`, previously listed here, only exist on that other surface
		// and don't resolve here). `listModels()` below replaces this with the live,
		// per-key catalog once a key is set; this is only the pre-fetch fallback.
		suggestedModels: [
			'gemini-3.5-flash',
			'gemini-3.1-pro-preview',
			'gemini-3.1-flash-lite',
			'gemini-3-flash-preview',
			'gemini-flash-latest',
			'gemini-2.5-flash',
			'gemini-2.5-flash-lite',
			'gemini-2.5-pro',
			'gemini-pro-latest',
		],
		apiKeyUrl: 'https://aistudio.google.com/apikey',
		requiresApiKey: true,
		supportsTools: true,
		// All current Gemini chat models support function calling via the compat endpoint.
		toolModelPatterns: [],
		// Every current Gemini chat model accepts image input; none are text-only.
		visionModelPatterns: [],
		// Gemini 2.5+ models cache a repeated prompt prefix automatically (implicit caching,
		// ~90% off cached tokens) — no breakpoints to send, same shape as OpenAI's automatic
		// caching. See openai.ts for the identical reasoning.
		cachesPrompts: true,
	};

	protected override extraBody(): Record<string, unknown> {
		return { temperature: 0.3 };
	}

	override async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const entries = await super.listModels(apiKey, baseUrl, signal);
		const chat = entries.filter(e => !NON_CHAT_MODEL.test(e.id));
		// If the filter ever gets too aggressive, showing everything beats showing nothing.
		return chat.length ? chat : entries;
	}
}
