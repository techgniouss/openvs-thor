/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for Z.AI (Zhipu)'s GLM models at `api.z.ai/api/paas/v4`, which speaks the OpenAI
 * Chat Completions shape. The `-flash` line (`glm-4.5-flash`, `glm-4.6-flash`) is free-forever
 * as of 2026, but metered by *concurrency* rather than a token budget — roughly one request in
 * flight at a time before the next earns a 429, which {@link apiFetch}'s rate-limit retry
 * absorbs the same way it does for every other free tier here. Z.AI's own `/models` catalog
 * lists only its paid `glm-4.5`..`glm-5.3` line; the free `-flash` variants are undocumented
 * there, so `suggestedModels` names them explicitly rather than relying on `listModels`
 * to surface them. Create a key at z.ai (console -> API keys).
 */
export class ZaiProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'zai',
		label: 'Z.AI (GLM)',
		suggestedModels: ['glm-4.6-flash', 'glm-4.5-flash', 'glm-4.6', 'glm-4.5'],
		apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
		requiresApiKey: true,
		supportsTools: true,
		// The catalog also serves non-chat GLM variants (embedding/vision-only checkpoints)
		// under names that don't share a common prefix with the chat line, so an empty list
		// (meaning "every model from this provider is assumed tool-capable") is the honest
		// default here rather than a pattern likely to exclude a valid chat model.
		toolModelPatterns: [],
		visionModelPatterns: ['glm-4\\.[5-9]v', 'glm-5'],
	};

	// Z.AI's endpoint does not reliably honour `response_format: json_schema`, so this stays
	// on the base class's default request body rather than opting into a stricter ask the
	// backend might ignore anyway.
}
