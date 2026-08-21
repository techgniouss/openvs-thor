/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RateLimitSnapshot } from '../providers/rateLimits';

/** How long a rate-limit reading is trusted before it is treated as no information. */
const SNAPSHOT_TTL_MS = 300_000;

/**
 * Whether a completion request may proceed, and if not, why it is standing down.
 *
 * Only the quota reason belongs here — latency is `HealthTracker`'s concern, checked at a
 * separate call site, so `'paused-slow'` is deliberately not a member: a discriminant this
 * function can never produce would leave the caller unable to tell "the real reason" from
 * "whatever this collapses unhandled values to", which is exactly the failure a caller
 * collapsing everything non-`'ok'` to one hardcoded label would otherwise hide.
 */
export type GateResult = 'ok' | 'paused-quota';

/**
 * Serializes completion requests and decides when not to send one at all.
 *
 * Debouncing is deliberately *not* done here: the editor applies `debounceDelayMs` from the
 * provider metadata before it ever calls us, which is strictly better because it costs no
 * work at all. What is left is the part the editor cannot do — keeping one request in flight,
 * and refusing to spend the tail of a token window that Agent mode is about to need.
 */
export class CompletionScheduler {
	private inFlight?: AbortController;

	/**
	 * Runs `work` as the only outstanding completion request, aborting any predecessor.
	 *
	 * Resolves undefined when this request was itself superseded, so a caller can tell
	 * "no suggestion" from "a newer keystroke won" without inspecting abort errors — and so
	 * a slow reply can never be rendered against a cursor that has since moved.
	 */
	async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		this.inFlight?.abort();
		const controller = new AbortController();
		this.inFlight = controller;
		try {
			const result = await work(controller.signal);
			return controller.signal.aborted ? undefined : result;
		} catch (err) {
			if (controller.signal.aborted) {
				return undefined;
			}
			throw err;
		} finally {
			if (this.inFlight === controller) {
				this.inFlight = undefined;
			}
		}
	}

	/**
	 * Whether there is enough of the token window left to spend on a completion.
	 *
	 * Conservative in both directions. Missing or stale data permits the request — refusing
	 * on no evidence would disable the feature on every backend that reports nothing, which
	 * is most of them. A fresh reading below the reserve refuses it, so a burst of typing
	 * cannot consume the budget an agent run is about to need.
	 *
	 * This governs *tokens* only. {@link RateLimitSnapshot} carries no request-count fields,
	 * so a daily request cap — which is what Groq's free tier actually meters — is invisible
	 * here, and is defended against by the editor debounce, the cache and the breaker instead.
	 */
	gate(snapshot: RateLimitSnapshot | undefined, reserve: number, now = Date.now()): GateResult {
		if (!snapshot || snapshot.limitTokens === undefined || snapshot.remainingTokens === undefined) {
			return 'ok';
		}
		if (now - snapshot.at >= SNAPSHOT_TTL_MS) {
			return 'ok';
		}
		return snapshot.remainingTokens < snapshot.limitTokens * reserve ? 'paused-quota' : 'ok';
	}

	/** Aborts anything outstanding. Called when the provider is disposed or disabled. */
	dispose(): void {
		this.inFlight?.abort();
		this.inFlight = undefined;
	}
}
