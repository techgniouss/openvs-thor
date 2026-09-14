/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parks a (provider, model) pair for a while after a quota failure, so Auto mode and the
 * plain chat path don't immediately re-select a model that just told us it has nothing left.
 * Ported from `ProviderManager.mark_quota_cooldown` in a companion Python batch-dispatcher
 * project, with the same two-tier duration: a plain rate limit clears in under a minute, but a
 * daily/monthly exhaustion or a billing refusal will not, and re-probing it every request for
 * the rest of the day wastes a request each time for nothing.
 *
 * Session-scoped and in-memory, same convention as {@link RateLimitTracker} — persisting this
 * would let a stale cooldown outlive a plan upgrade or a fresh API key.
 */
export class CooldownTracker {
	private readonly until = new Map<string, number>();

	private static key(providerId: string, model: string): string {
		return `${providerId} ${model}`;
	}

	/** A 429 usually means "too fast" — the window reopens in seconds. */
	static readonly COOLDOWN_MS = 60_000;
	/** A daily/monthly allowance is gone; seconds do not help. */
	static readonly DAILY_COOLDOWN_MS = 900_000;

	/**
	 * Substrings marking a quota error as a daily/monthly exhaustion or a billing/entitlement
	 * refusal rather than a momentary rate limit, matched case-insensitively. A billing refusal
	 * ("payment required", "membership") is grouped in here rather than treated as permanent,
	 * because {@link CooldownTracker} has no concept of "never retry" — 15 minutes is simply
	 * long enough that a session re-probes it at most a few times a day instead of on every
	 * message.
	 */
	private static readonly DAILY_MARKERS = [
		'per day', 'daily', 'per-day', 'requests per day', 'rpd',
		'quota exceeded', 'resource_exhausted', 'insufficient_quota',
		'out of credits', 'insufficient credits', 'monthly', 'run out of credits',
		'payment required', 'payment_required', 'billing', 'membership',
	];

	/**
	 * Parks `providerId`/`model` after a quota failure. `detail` is the provider's error
	 * text (typically the message from {@link describeHttpError}); a daily-exhaustion
	 * message earns {@link DAILY_COOLDOWN_MS} instead of {@link COOLDOWN_MS}. Returns the
	 * cooldown deadline (epoch ms).
	 */
	markCooldown(providerId: string, model: string, detail: string, now = Date.now()): number {
		const blob = (detail || '').toLowerCase();
		const daily = CooldownTracker.DAILY_MARKERS.some(marker => blob.includes(marker));
		const ms = daily ? CooldownTracker.DAILY_COOLDOWN_MS : CooldownTracker.COOLDOWN_MS;
		const deadline = now + ms;
		this.until.set(CooldownTracker.key(providerId, model), deadline);
		return deadline;
	}

	isCoolingDown(providerId: string, model: string, now = Date.now()): boolean {
		const deadline = this.until.get(CooldownTracker.key(providerId, model));
		return deadline !== undefined && deadline > now;
	}

	remainingMs(providerId: string, model: string, now = Date.now()): number {
		const deadline = this.until.get(CooldownTracker.key(providerId, model)) ?? 0;
		return Math.max(0, deadline - now);
	}

	/** Ends a cooldown early — call after a successful response for this pair. */
	clear(providerId: string, model: string): void {
		this.until.delete(CooldownTracker.key(providerId, model));
	}
}
