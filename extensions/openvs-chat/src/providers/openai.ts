/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CHATGPT_MODELS, chatgptAgentStep, chatgptStreamChat, isChatGptToken } from './chatgptBackend';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { AgentRequest, AgentStep, ChatRequest, ModelEntry, ProviderInfo, StreamChatResult } from './types';

/**
 * Provider for the OpenAI Chat Completions API (and any OpenAI-compatible endpoint,
 * configurable through the base URL setting). Used for ChatGPT models. When the
 * stored credential is a ChatGPT web sign-in token instead of an API key, requests
 * are routed through the ChatGPT backend (see `chatgptBackend.ts`).
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'openai',
		label: 'OpenAI (ChatGPT)',
		suggestedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'gpt-5'],
		apiKeyUrl: 'https://platform.openai.com/api-keys',
		requiresApiKey: true,
		supportsTools: true,
		// All current chat models (gpt-3.5/4/4o/4.1/5 and the o-series) support tools.
		toolModelPatterns: ['gpt-3\\.5', 'gpt-4', 'gpt-5', '^o[0-9]', 'chatgpt', 'codex'],
		// gpt-4o/4.1/5 and the o-series are multimodal; bare gpt-4/gpt-3.5 are not.
		visionModelPatterns: ['gpt-4o', 'gpt-4\\.1', 'gpt-4-turbo', 'gpt-5', '^o[0-9]'],
	};

	override async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		if (isChatGptToken(request.apiKey)) {
			return chatgptStreamChat(this.info.label, request);
		}
		return super.streamChat(request);
	}

	override async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		if (isChatGptToken(request.apiKey)) {
			return chatgptAgentStep(this.info.label, request);
		}
		return super.runAgentStep(request);
	}

	override async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		if (isChatGptToken(apiKey)) {
			// The ChatGPT backend has no models endpoint; it serves a fixed set.
			return CHATGPT_MODELS.map(id => ({ id }));
		}
		return super.listModels(apiKey, baseUrl, signal);
	}
}
