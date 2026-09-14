/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for xkiro.com, a free-tier aggregator gateway speaking the OpenAI Chat Completions
 * shape. Its catalog lists far more models than its free plan actually serves — many answer
 * HTTP 403 ("requires real deposited balance") or HTTP 500 on anything beyond a small prompt —
 * so `suggestedModels` names only what a companion project measured as working at real prompt
 * sizes rather than the catalog's full list.
 */
export class XkiroProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'xkiro',
		label: 'Xkiro',
		suggestedModels: ['mistralai/mistral-medium-3.5'],
		apiKeyUrl: 'https://xkiro.com',
		requiresApiKey: true,
		supportsTools: true,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};
}
