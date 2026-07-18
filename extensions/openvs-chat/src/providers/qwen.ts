/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for Alibaba Cloud's Qwen models via DashScope's OpenAI-compatible mode.
 * Create a key in Alibaba Cloud Model Studio (free quota on signup). The default
 * base URL is the international endpoint; Beijing-region accounts should switch it
 * to `https://dashscope.aliyuncs.com/compatible-mode/v1`.
 */
export class QwenProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'qwen',
		label: 'Qwen (Alibaba)',
		suggestedModels: [
			'qwen3-max',
			'qwen-plus',
			'qwen-turbo',
			'qwen3-coder-plus',
			'qwen-max',
			'qwen-vl-max',
		],
		apiKeyUrl: 'https://modelstudio.console.alibabacloud.com/?tab=model#/api-key',
		requiresApiKey: true,
		supportsTools: true,
		// Qwen chat models broadly support function calling in compatible mode.
		toolModelPatterns: [],
		visionModelPatterns: ['-vl', 'omni', 'qvq'],
	};
}
