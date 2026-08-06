/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ModelEntry, ProviderInfo } from './types';

/**
 * Groq's `/models` catalog mixes chat LLMs with speech (Whisper, Orpheus/PlayAI TTS) and
 * the Llama Guard / Prompt Guard safety classifiers, none of which behave like a chat model
 * if picked in the dropdown.
 */
const NON_CHAT_MODEL = /(whisper|-tts|tts-|orpheus|playai|guard|embed)/i;

/**
 * Provider for GroqCloud, exposed through an OpenAI-compatible API at
 * `api.groq.com/openai/v1`. Groq's free tier is a genuine free tier rather than expiring
 * trial credits: no credit card, no per-token charge, gated only by rate limits (30
 * requests/minute and 14,400 requests/day, applied per *organization* — extra API keys
 * don't raise it). Create a `gsk_...` key at console.groq.com/keys.
 *
 * The catch is tokens, not requests: the free tier's tokens-per-minute ceiling is low
 * (single-digit thousands on the larger models), and an agent step re-sends the whole
 * conversation, so long Agent runs will hit HTTP 429 well before the daily request budget
 * runs out. {@link apiFetch} backs off and retries those, but Ask/Plan is the comfortable
 * fit here; use a bigger-context provider for long agentic runs.
 *
 * That ceiling is also *per request*, and it is unrelated to the model's context window —
 * `qwen/qwen3.6-27b` has a 128k window and an 8k TPM allowance, and a single request over
 * the allowance is refused outright with HTTP 413 ("Request too large … Limit 8000"), not
 * queued. The reservation counts too: the default 8192 `max_tokens` alone exceeds an 8k
 * allowance, so no amount of trimming the conversation can rescue it. Neither number is
 * discoverable before the first request (it varies by model and by account tier), so the
 * agent loop learns it from the rejection and re-derives both budgets from it — see
 * `agentRunner.adoptRequestCeiling`. One request per run pays for the lesson.
 */
export class GroqProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'groq',
		label: 'Groq (free tier)',
		suggestedModels: [
			'llama-3.3-70b-versatile',
			'openai/gpt-oss-120b',
			'openai/gpt-oss-20b',
			'llama-3.1-8b-instant',
			'qwen/qwen3.6-27b',
			'minimaxai/minimax-m2.7',
			'groq/compound',
		],
		apiKeyUrl: 'https://console.groq.com/keys',
		requiresApiKey: true,
		supportsTools: true,
		// Groq's tool support is model-specific; allowlist the known function-calling families.
		toolModelPatterns: [
			'llama-3\\.[13]', 'llama-4', 'gpt-oss', 'qwen', 'minimax', 'compound', 'kimi', 'deepseek',
		],
		// Only the Llama 4 multimodal checkpoints accept images; everything else is text-only
		// and answers an image attachment with an unhelpful 400.
		visionModelPatterns: ['scout', 'maverick', 'vision'],
		// Groq caches a repeated prefix automatically, with no code changes and no opt-in.
		// It matters more here than anywhere else: cached tokens are billed at half price AND
		// do not count against the rate limits, which is exactly what the free tier's low
		// tokens-per-minute ceiling runs out of. Declaring it also stops the agent loop
		// compacting early — compaction rewrites the middle and so throws the cache away.
		cachesPrompts: true,
	};

	override async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const entries = await super.listModels(apiKey, baseUrl, signal);
		const chat = entries.filter(e => !NON_CHAT_MODEL.test(e.id));
		// Groq's free tier is not per-model — every model in the catalog is served on it, so
		// the badge is accurate for any account that hasn't upgraded to the Developer plan.
		// If the filter ever gets too aggressive, showing everything beats showing nothing.
		return (chat.length ? chat : entries).map(e => ({ ...e, free: true }));
	}
}
