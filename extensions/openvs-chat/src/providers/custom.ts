/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for any OpenAI-compatible endpoint the user points it at: local runners
 * (Ollama, LM Studio, vLLM) or hosted open-model gateways (OpenRouter, Together, …).
 * The base URL defaults to Ollama's local endpoint and no API key is required —
 * if one is saved it is sent as a standard Bearer header for secured endpoints.
 */
export class CustomProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'custom',
		label: 'Custom (Local / Self-hosted)',
		suggestedModels: [
			'llama3.1',
			'qwen2.5-coder',
			'deepseek-r1',
			'mistral',
		],
		apiKeyUrl: '',
		requiresApiKey: false,
		supportsTools: true,
		// Arbitrary OSS models — we can't enumerate tool-capable ones in advance,
		// so stay permissive and let the backend's real error surface if a model
		// can't do tool calling.
		toolModelPatterns: [],
		// Same reasoning for vision (matches the NVIDIA provider's approach).
		visionModelPatterns: [],
	};
}
