/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ModelEntry, ProviderInfo } from './types';

/**
 * NVIDIA's `/models` catalog mixes chat LLMs with embeddings, rerankers, ASR/TTS,
 * image/protein/etc. models that all fail (confusingly) if picked in a chat. Filter
 * the obvious non-chat families out of the dropdown.
 */
const NON_CHAT_MODEL = /(embed|rerank|reward|retriever|nemoretriever|clip\b|siglip|ocr|paddle|parakeet|canary|fastpitch|riva|maxine|-tts|_tts|asr|bge-|\be5-|sdxl|stable-diffusion|flux\.|genmol|molmim|diffdock|esmfold|proteinmpnn|evo2|audio|speech|translate|background-removal|upscal|studiovoice|eyecontact|vista|cuopt|earth2|fourcastnet|corrdiff|weather|medical|vila\b|guard)/i;

/**
 * Provider for NVIDIA's hosted models, exposed through an OpenAI-compatible API at
 * `integrate.api.nvidia.com`. NVIDIA offers a generous free tier (sign up at
 * build.nvidia.com to get an `nvapi-...` key) which makes these models a good
 * zero-cost default for the editor's chat.
 */
export class NvidiaProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'nvidia',
		label: 'NVIDIA (free models)',
		suggestedModels: [
			'meta/llama-3.3-70b-instruct',
			'openai/gpt-oss-20b',
			'qwen/qwen3-next-80b-a3b-instruct',
			'deepseek-ai/deepseek-v4-flash',
			'moonshotai/kimi-k2.6',
			'nvidia/nemotron-nano-3-30b-a3b',
			'z-ai/glm-5.2',
		],
		apiKeyUrl: 'https://build.nvidia.com/',
		requiresApiKey: true,
		supportsTools: true,
		// NVIDIA tool calling is model-specific; allowlist the known function-calling families.
		toolModelPatterns: [
			'llama-3\\.[123]', 'llama-4', 'nemotron', 'ministral',
			'mixtral-8x22b', 'mistral-large', 'mistral-small', 'mistral-medium', 'devstral', 'magistral',
			'qwen2\\.5', 'qwen3', 'deepseek', 'kimi', 'gpt-oss', 'glm', 'granite', 'command-[ar]',
			'minimax', 'phi-4', 'jamba',
		],
		// NVIDIA hosts an open-ended catalog of vision and text-only models; we can't
		// enumerate vision-capable ones in advance, so stay permissive and let the API
		// surface a real error if a specific model can't accept images.
		visionModelPatterns: [],
	};

	protected override extraBody(): Record<string, unknown> {
		return { temperature: 0.2, top_p: 0.7 };
	}

	/**
	 * NVIDIA's endpoint rejects assistant turns that carry both narration text and
	 * tool_calls (HTTP 400 "Assistant message must have either content or tool_calls,
	 * but not both"), so the serialized history keeps only the tool_calls.
	 */
	protected override allowsContentWithToolCalls(): boolean {
		return false;
	}

	override async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const entries = await super.listModels(apiKey, baseUrl, signal);
		const chat = entries.filter(e => !NON_CHAT_MODEL.test(e.id));
		// If the filter ever gets too aggressive, showing everything beats showing nothing.
		// Everything in the build.nvidia.com catalog is served on the free (credit) tier.
		return (chat.length ? chat : entries).map(e => ({ ...e, free: true }));
	}
}
