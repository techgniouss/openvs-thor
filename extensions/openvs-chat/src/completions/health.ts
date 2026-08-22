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
export class HealthTracker {
	private readonly samples: number[] = [];

	constructor(
		/** Latency above which a backend is considered unusable for completion, in ms. */
		private readonly slowMs = 3000,
		/** How many recent samples the verdict is drawn from. */
		private readonly window = 5,
	) { }

	/** Records one completed request's round-trip time. */
	record(ms: number): void {
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
	reset(): void {
		this.samples.length = 0;
	}
}
