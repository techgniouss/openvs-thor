/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for Moonshot AI's Kimi models, exposed through an OpenAI-compatible API at
 * `api.moonshot.ai`. Sign up at platform.moonshot.ai to create an `sk-...` key
 * (China-mainland accounts should switch the base URL to `https://api.moonshot.cn/v1`).
 * The Kimi K2 family is strong at agentic tool calling with up to 256K context.
 */
export class KimiProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'kimi',
		label: 'Kimi (Moonshot AI)',
		suggestedModels: [
			'kimi-k2.5',
			'kimi-k2.6',
			'kimi-k2.7-code',
			'kimi-latest',
			'moonshot-v1-8k',
			'moonshot-v1-32k',
			'moonshot-v1-128k',
		],
		apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
		requiresApiKey: true,
		supportsTools: true,
		// All current Kimi / Moonshot chat models support function calling.
		toolModelPatterns: [],
		visionModelPatterns: ['vision', 'kimi-latest'],
	};

	protected override extraBody(): Record<string, unknown> {
		return { temperature: 0.3 };
	}
}
