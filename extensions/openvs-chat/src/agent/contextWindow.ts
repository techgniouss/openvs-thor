/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-model context-window resolution. The old fixed 120k budget overshot small
 * models (guaranteeing a wasted 400 round-trip before the halving fallback kicked
 * in) and undersold big ones. Patterns are matched in order — first hit wins —
 * against the raw model id, so gateway prefixes like `deepseek-ai/` still match.
 */

import { ModelEntry } from '../providers/types';

/** Conservative fallback for models we don't recognize. */
const DEFAULT_WINDOW = 32_000;

/** Floor below which shrinking the budget would starve the conversation entirely. */
const MIN_BUDGET = 8_000;

/** Share of the window offered to the conversation; the rest absorbs estimate error. */
const WINDOW_SHARE = 0.8;

const WINDOWS: Array<[RegExp, number]> = [
	[/claude/i, 200_000],
	[/gpt-5/i, 400_000],
	[/gpt-4\.1/i, 1_000_000],
	[/gpt-oss/i, 128_000],
	[/o[134](-mini|-pro)?\b/i, 200_000],
	[/gpt-4o|gpt-4-turbo/i, 128_000],
	[/deepseek-r1|deepseek-reasoner/i, 64_000],
	[/deepseek/i, 128_000],
	[/kimi-k2|moonshot.*256k/i, 256_000],
	[/kimi|moonshot/i, 128_000],
	[/qwen/i, 128_000],
	[/llama-?3\.[123]|llama-?4/i, 128_000],
	[/llama/i, 8_000],
	[/gemini/i, 1_000_000],
	[/grok/i, 128_000],
	// GLM-5.2 is documented at 1M, but gateways routinely serve the family with a smaller
	// window than the model card claims, and overshooting costs a 400 and a halving retry on
	// every request until it settles. 200k is GLM-5.1's window — comfortably large, safely
	// under 5.2's — and a fetched catalog raises it to the truth where the host reports one.
	[/glm-5/i, 200_000],
	[/glm-4|glm-z/i, 128_000],
	[/minimax/i, 192_000],
	[/command-a|command-r/i, 128_000],
	[/nemotron/i, 128_000],
	// Gemma 4 broke the family's small-window pattern outright: 256k, against 8k for 2 and 3.
	[/gemma-?4/i, 256_000],
	[/gemma-?3|gemma-?2/i, 8_000],
	[/phi-?[34]/i, 128_000],
	[/mistral-large|mistral-medium|mistral-small|mixtral-8x22b|ministral|magistral|devstral|codestral/i, 128_000],
	[/mistral|mixtral/i, 32_000],
	// Groq's agentic systems; the underlying Llama checkpoints are matched above, but the
	// `groq/compound` ids carry no model family in the name to match on.
	[/compound/i, 128_000],
];

/**
 * The model's total context window in tokens (input + output).
 *
 * `entries` is the provider's fetched model catalog, when it has been loaded. A window
 * the catalog reports is authoritative and always wins: the name patterns below cannot
 * know every model a gateway serves, and falling back to {@link DEFAULT_WINDOW} for a
 * large-window model makes compaction fire from the first few file reads onward, which
 * summarizes away working state the run still needs.
 */
export function contextWindowFor(model: string, entries?: ModelEntry[]): number {
	const reported = entries?.find(e => e.id === model)?.contextLength;
	if (reported && reported > 0) {
		return reported;
	}
	for (const [pattern, window] of WINDOWS) {
		if (pattern.test(model)) {
			return window;
		}
	}
	return DEFAULT_WINDOW;
}

/**
 * The estimated-token budget for the conversation sent to `model`: a share of the
 * window minus the response headroom, floored. An explicit user `override`
 * (openvsChat.agent.maxContextTokens > 0) wins outright.
 */
export function contextBudgetFor(model: string, maxOutputTokens: number, override?: number, entries?: ModelEntry[]): number {
	if (override && override > 0) {
		return override;
	}
	return Math.max(MIN_BUDGET, Math.floor(contextWindowFor(model, entries) * WINDOW_SHARE) - maxOutputTokens);
}
