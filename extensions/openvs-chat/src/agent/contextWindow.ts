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
	[/mistral-large|mixtral-8x22b|ministral/i, 128_000],
	[/mistral|mixtral/i, 32_000],
];

/** The model's total context window in tokens (input + output). */
export function contextWindowFor(model: string): number {
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
export function contextBudgetFor(model: string, maxOutputTokens: number, override?: number): number {
	if (override && override > 0) {
		return override;
	}
	return Math.max(MIN_BUDGET, Math.floor(contextWindowFor(model) * WINDOW_SHARE) - maxOutputTokens);
}
