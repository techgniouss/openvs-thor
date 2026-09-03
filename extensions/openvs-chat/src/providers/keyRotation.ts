/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Round-robins a provider's stored API keys away from ones that just failed, so a free-tier
 * user with several accounts' keys spreads load across them instead of every 429 stopping the
 * conversation cold. Ported from the same idea in a batch-scraper's provider dispatcher
 * (`ProviderManager.api_key_rotate` in a companion Python project) but kept session-scoped and
 * in-memory, matching {@link RateLimitTracker}'s convention: a stale rotation is worth at most
 * one wasted request, since {@link ProviderRegistry.getApiKeys} re-reads the stored list fresh
 * on every call and a key that was only ever temporarily rate-limited is trusted again the next
 * time the extension reloads.
 */
export class KeyRotator {
	private readonly activeIndexByProvider = new Map<string, number>();
	private readonly erroredByProvider = new Map<string, Set<number>>();

	private errored(id: string): Set<number> {
		let set = this.erroredByProvider.get(id);
		if (!set) {
			set = new Set();
			this.erroredByProvider.set(id, set);
		}
		return set;
	}

	/**
	 * Index into `keys` that is currently active for `id`. Clamped to the list's current
	 * length so a key removed from settings after becoming active can't leave a stale
	 * out-of-range index around.
	 */
	activeIndex(id: string, keys: readonly string[]): number {
		const current = this.activeIndexByProvider.get(id) ?? 0;
		if (current >= keys.length) {
			this.activeIndexByProvider.set(id, 0);
			return 0;
		}
		return current;
	}

	/**
	 * Marks `id`'s currently active key as errored and advances to the next non-errored
	 * key. When every key has now failed, the errored set is reset and rotation restarts
	 * — matching `ProviderManager.api_key_rotate`'s "all keys errored -> reset and start
	 * over from index 0" behaviour, so a transient outage across every key doesn't
	 * permanently strand the provider once the outage clears.
	 *
	 * Returns false (no-op) for a single-key list — there is nothing to rotate to, and the
	 * caller should treat the failure as final rather than retrying with the same key.
	 */
	rotate(id: string, keys: readonly string[]): boolean {
		if (keys.length <= 1) {
			return false;
		}
		const current = this.activeIndex(id, keys);
		const errored = this.errored(id);
		errored.add(current);

		let available = keys.map((_, i) => i).filter(i => !errored.has(i));
		if (!available.length) {
			errored.clear();
			available = keys.map((_, i) => i);
		}
		const next = available.find(i => i !== current) ?? available[0];
		this.activeIndexByProvider.set(id, next);
		return next !== current;
	}

	/** Drops `id`'s errored-key history after a successful call, so a key that only failed
	 * transiently is trusted again immediately rather than staying skipped until it's the
	 * last one left. Does not change which key is currently active. */
	clear(id: string): void {
		this.erroredByProvider.get(id)?.clear();
	}
}
