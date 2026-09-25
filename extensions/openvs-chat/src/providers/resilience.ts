/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderRegistry } from './registry';

/**
 * A 401 (bad/expired key), 403 (forbidden — often a quota/entitlement refusal dressed up as
 * a permission error, e.g. Qwen's `AccessDenied.Unpurchased`) or 429 (rate limit) — the three
 * HTTP statuses {@link describeHttpError} already renders distinctly and that a *different*
 * API key has a real chance of surviving. Matched against the message text rather than a
 * status code because providers throw `Error`, not a typed HTTP failure — see
 * `describeHttpError`'s wording ("authentication failed (HTTP 401", "HTTP 403", "rate limited
 * (HTTP 429") in `providers/types.ts`.
 */
const KEY_FAILURE = /\bhttp (401|403|429)\b/i;

/** Whether `message` names one of the three statuses a different stored API key has a real
 * chance of surviving. Exported so `agent/agentRunner.ts` can apply the same rule to a
 * mid-step failure without duplicating the regex — see {@link AgentOptions.onKeyFailure}. */
export function isKeyFailure(message: string): boolean {
	return KEY_FAILURE.test(message);
}

/**
 * Resolves `providerId`'s current API key, calls `fn` with it, and on a 401/403/429 rotates
 * to the next stored key (if one exists) and retries `fn` exactly once with the new key.
 * Every outcome — success, a failure that got a fresh key, or a failure with none left —
 * also records or clears a quota cooldown for the (providerId, model) pair via
 * {@link ProviderRegistry.cooldowns}, so Auto-mode routing and repeated sends both benefit
 * from the same signal without each call site tracking it separately.
 *
 * Precondition: `fn` must not have produced any user-visible output (streamed tokens, partial
 * UI state) before it can throw the failure this reacts to. This holds for every current
 * `ChatProvider` because each implementation checks `response.ok` and throws before it starts
 * reading the SSE stream (see `OpenAICompatibleProvider.streamChat`, `AnthropicProvider`,
 * `AntigravityProvider`) — a 401/403/429 is a rejected request, never a stream that started
 * and then failed mid-token. A future provider that streams before validating the response
 * would break this assumption and must not be wrapped here.
 */
export async function withProviderResilience<T>(
	registry: ProviderRegistry,
	providerId: string,
	model: string,
	fn: (apiKey: string) => Promise<T>,
): Promise<T> {
	const apiKey = (await registry.getApiKey(providerId)) ?? '';
	try {
		const result = await fn(apiKey);
		registry.noteApiKeySuccess(providerId);
		registry.cooldowns.clear(providerId, model);
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!isKeyFailure(message)) {
			throw err;
		}
		registry.cooldowns.markCooldown(providerId, model, message);
		const rotated = await registry.rotateApiKey(providerId);
		if (!rotated) {
			throw err;
		}
		const nextKey = (await registry.getApiKey(providerId)) ?? '';
		const result = await fn(nextKey);
		registry.noteApiKeySuccess(providerId);
		registry.cooldowns.clear(providerId, model);
		return result;
	}
}
