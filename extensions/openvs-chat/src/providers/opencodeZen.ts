/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for OpenCode Zen (`opencode.ai/zen`) — NOT the `opencode` CLI, a plain hosted
 * OpenAI-compatible API reachable with a `sk-` key and no billing setup for its free models.
 * Free-tier catalog membership rotates (a model retired without notice 404s every call until
 * `listModels` is re-checked), so `suggestedModels` names only what a companion project
 * measured as reliably free and complete as of 2026-08, and users should prefer `listModels`'s
 * live catalog over typing a name from memory.
 */
export class OpenCodeZenProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'opencode_zen',
		label: 'OpenCode Zen',
		suggestedModels: ['laguna-s-2.1-free', 'deepseek-v4-flash-free'],
		apiKeyUrl: 'https://opencode.ai/zen',
		requiresApiKey: true,
		supportsTools: true,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};
}
