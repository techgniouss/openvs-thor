/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Watches how long a backend actually takes and trips a breaker when it is too slow to be
 * useful for completion.
 *
 * Necessary because the free tiers this extension targets queue requests server-side: a
 * model can be perfectly healthy and still take twenty seconds to start. With no breaker
 * that reads to the user as "inline completions do not work" — no error, nothing to act on.
 * With one, the feature stands down and says which setting to change.
 *
 * A single slow sample is never a verdict: a cold model's first request is expected to be
 * slow, and disabling on it would disable the feature on every fresh session.
 */
/** First pause after a failed completion request, doubled per further failure. */
const BASE_BACKOFF_MS = 2_000;
/** Longest pause between automatic attempts while a backend keeps failing. */
const MAX_BACKOFF_MS = 60_000;

export class HealthTracker {
	private readonly samples: number[] = [];

	constructor(
		/** Latency above which a backend is considered unusable for completion, in ms. */
		private readonly slowMs = 3000,
		/** How many recent samples the verdict is drawn from. */
		private readonly window = 5,
	) { }

	/** Records one completed request's round-trip time. */
	/** Consecutive failed requests; see {@link recordFailure}. */
	private failures = 0;
	/** Until when automatic requests stand down after a failure, epoch ms. */
	private pausedUntil = 0;

	record(ms: number): void {
		this.failures = 0;
		this.pausedUntil = 0;
		this.samples.push(ms);
		if (this.samples.length > this.window) {
			this.samples.shift();
		}
	}

	/**
	 * Whether the backend is currently too slow. Requires a full window of samples, so the
	 * breaker cannot trip on a cold start, and clears itself as soon as latency recovers.
	 *
	 * Trips on a majority of the window, not any single sample — with the default window of
	 * 5, a percentile-based verdict (e.g. p95) degenerates to the plain maximum and one cold
	 * request would trip it alone, exactly what the class-level doc comment above says must
	 * not happen.
	 *
	 * `slowMs` defaults to the constructor's value but should be passed fresh by the caller
	 * (`openvsChat.completions.slowMs` is meant to apply immediately, not only once this
	 * tracker is next rebuilt).
	 */
	isSlow(slowMs: number = this.slowMs): boolean {
		if (this.samples.length < this.window) {
			return false;
		}
		const slow = this.samples.filter(ms => ms > slowMs).length;
		return slow > this.samples.length / 2;
	}

	/** Forgets history — used when the model changes, since the old latency says nothing. */
	/**
	 * Records a failed request and backs automatic requests off: 2s, then doubling to a
	 * minute while failures continue.
	 *
	 * Only successes were recorded, so a backend failing every request — a 429, a revoked
	 * key, a local endpoint that is down — was asked again on every pause in typing, each
	 * attempt spending quota (and, on a rate limit, deepening it) to show nothing.
	 */
	recordFailure(now = Date.now()): void {
		this.failures++;
		this.pausedUntil = now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (this.failures - 1));
	}

	/** Seconds automatic requests are still standing down for, or 0 when they are not. */
	backoffSeconds(now = Date.now()): number {
		return now < this.pausedUntil ? Math.ceil((this.pausedUntil - now) / 1000) : 0;
	}

	reset(): void {
		this.samples.length = 0;
		this.failures = 0;
		this.pausedUntil = 0;
	}
}
