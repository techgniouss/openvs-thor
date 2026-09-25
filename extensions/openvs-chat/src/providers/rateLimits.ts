/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What a backend reports about its own token rate limits, read off response headers.
 *
 * The limits that actually stop an agent run are invisible to everything else we know about
 * a model: `qwen/qwen3.6-27b` has a 128k context window and, on Groq's free tier, an 8k
 * per-request token allowance. Nothing in a model catalog says so, so a budget derived from
 * the window overshoots by an order of magnitude and the request is refused outright. The
 * backend does say so — on every response, success or failure — and we were throwing it away.
 */

/** A backend's stated token allowance, as of the response it was read from. */
export interface RateLimitSnapshot {
	/** The window's token allowance — a quota gauge, together with {@link remainingTokens}. */
	readonly limitTokens?: number;
	/**
	 * Tokens one whole request (prompt and reserved reply) may carry, or undefined when the
	 * stated limit does not bound that. Only the `x-ratelimit-*` family does: those backends
	 * charge the whole request against the window and refuse one larger than it. Anthropic's
	 * input limit counts only *uncached* input and output is limited separately, so treating it
	 * as a ceiling cut a tier-1 key (30k/min) to ~30k per request on a 200k-window model — and
	 * compacted away the very cache that makes a large request cheap there.
	 */
	readonly requestCeiling?: number;
	/** Tokens left in the current window. */
	readonly remainingTokens?: number;
	/** How long until the token window refills, in ms from when the header was read. */
	readonly resetMs?: number;
	/** When this was read, so `remainingTokens` can be aged out rather than trusted forever. */
	readonly at: number;
}

/**
 * Header names, newest-standard first. OpenAI's `x-ratelimit-*` spelling is what most
 * OpenAI-compatible gateways emit (Groq included); Anthropic uses its own prefix and splits
 * input from output.
 */
const HEADERS = {
	limit: ['x-ratelimit-limit-tokens', 'anthropic-ratelimit-input-tokens-limit'],
	remaining: ['x-ratelimit-remaining-tokens', 'anthropic-ratelimit-input-tokens-remaining'],
	reset: ['x-ratelimit-reset-tokens', 'anthropic-ratelimit-input-tokens-reset'],
};

/** First present, non-empty value among `names`. */
function header(headers: Headers, names: string[]): string | undefined {
	for (const name of names) {
		const value = headers.get(name);
		if (value !== null && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/** A header's value as a token count, or undefined when it isn't one. */
function tokens(value: string | undefined): number | undefined {
	const n = value === undefined ? NaN : Number(value);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * A reset header as milliseconds from now.
 *
 * Three shapes in the wild and no way to know which a gateway will use: a Go-style duration
 * (`7.5s`, `2m59.56s`, `120ms`), a bare number of seconds, or an RFC3339 instant (Anthropic).
 * An unparseable value returns undefined, which callers treat as "no information" rather
 * than as zero — waiting zero on a limit we can't read would defeat the point.
 */
export function parseResetMs(value: string | undefined, now = Date.now()): number | undefined {
	if (!value) {
		return undefined;
	}
	const duration = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(value);
	if (duration && duration.slice(1).some(part => part !== undefined)) {
		const [h, m, s, ms] = duration.slice(1).map(part => (part === undefined ? 0 : Number(part)));
		return Math.round(h * 3_600_000 + m * 60_000 + s * 1_000 + ms);
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return Math.max(0, Math.round(seconds * 1_000));
	}
	const at = Date.parse(value);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** The rate-limit facts a response carries, or undefined when it carries none. */
export function parseRateLimitHeaders(headers: Headers, now = Date.now()): RateLimitSnapshot | undefined {
	const limitTokens = tokens(header(headers, HEADERS.limit));
	const remainingTokens = tokens(header(headers, HEADERS.remaining));
	const resetMs = parseResetMs(header(headers, HEADERS.reset), now);
	if (limitTokens === undefined && remainingTokens === undefined) {
		return undefined;
	}
	const wholeRequest = tokens(header(headers, [HEADERS.limit[0]])) !== undefined;
	return { limitTokens, remainingTokens, resetMs, at: now, ...(wholeRequest ? { requestCeiling: limitTokens } : {}) };
}

/**
 * A window's worth of remaining-token information is stale this long after it was read.
 *
 * Every limit we care about is per *minute*, so a reading from two minutes ago describes a
 * window that has since refilled twice. Treating it as current would make the pacer sleep
 * against a limit that no longer applies.
 */
const SNAPSHOT_TTL_MS = 60_000;

/** Never sleep longer than this for a refill: past here, failing loudly beats hanging. */
const MAX_PACE_MS = 30_000;

/**
 * How close a model's last-known token allowance is to exhausted, in the order a user should
 * read them: `'unknown'` is not "healthy", it is "we have no idea" — there is no reading at
 * all, or the one we have is stale (see {@link SNAPSHOT_TTL_MS}) or carries no `limitTokens`
 * to divide by, so no ratio is computable. Never invented from nothing.
 */
export type RateLimitStatus = 'ok' | 'near' | 'critical' | 'unknown';

/**
 * Below this fraction of the allowance remaining, a run is one or two more steps from a hard
 * 429 — worth a proactive, low-urgency notice so the user can switch models or add a backup
 * key before that happens rather than after.
 */
const RATE_LIMIT_NEAR_RATIO = 0.2;

/**
 * Below this fraction remaining, the next request is likely to be refused outright. Roughly
 * "one more request's worth" of headroom on a typical few-thousand-token chat turn against an
 * 8k-token free-tier allowance — tight enough to warrant a sharper word than `'near'`, not so
 * tight that it only ever fires after the 429 it was meant to warn about.
 */
const RATE_LIMIT_CRITICAL_RATIO = 0.05;

/**
 * The {@link RateLimitStatus} implied by `snapshot`, as of `now`.
 *
 * A pure function rather than a method, so the same ratio-threshold reasoning is usable both
 * from {@link RateLimitTracker.status} (the plain streaming and agent-loop paths, which read a
 * provider's shared tracker) and directly against whatever a `ChatProvider.rateLimit(model)`
 * call returns (callers that only have the snapshot, not the tracker that produced it) —
 * without the two ever computing the ratio differently.
 */
export function rateLimitStatus(snapshot: RateLimitSnapshot | undefined, now = Date.now()): RateLimitStatus {
	if (!snapshot || snapshot.limitTokens === undefined || snapshot.remainingTokens === undefined) {
		return 'unknown';
	}
	if (now - snapshot.at >= SNAPSHOT_TTL_MS) {
		// Every limit here is per-minute; a two-minute-old reading describes a window that has
		// since refilled, so treating it as current would raise a false alarm.
		return 'unknown';
	}
	if (snapshot.limitTokens <= 0) {
		return 'unknown';
	}
	const ratio = snapshot.remainingTokens / snapshot.limitTokens;
	if (ratio < RATE_LIMIT_CRITICAL_RATIO) {
		return 'critical';
	}
	if (ratio < RATE_LIMIT_NEAR_RATIO) {
		return 'near';
	}
	return 'ok';
}

/**
 * Per-model record of what each backend has said about its limits.
 *
 * Session-scoped and in memory on purpose. Persisting it would make an upgrade to a paid
 * tier, or a switch of API key, silently keep applying yesterday's ceiling — and the cost of
 * forgetting is one request, since the very next response re-states it.
 */
export class RateLimitTracker {
	private readonly byModel = new Map<string, RateLimitSnapshot>();

	/** Records what `response` says about `model`, if anything. */
	note(model: string, response: Response, now = Date.now()): void {
		const snapshot = parseRateLimitHeaders(response.headers, now);
		if (snapshot) {
			this.byModel.set(model, snapshot);
		}
	}

	/** The last thing this backend said about `model`. */
	get(model: string): RateLimitSnapshot | undefined {
		return this.byModel.get(model);
	}

	/** How close `model`'s last-known token allowance is to exhausted. See {@link rateLimitStatus}. */
	status(model: string, now = Date.now()): RateLimitStatus {
		return rateLimitStatus(this.byModel.get(model), now);
	}

	/**
	 * How long to wait before sending a request of `estimatedTokens`, in ms.
	 *
	 * Waiting out a window we know we cannot fit is strictly better than sending into it:
	 * the request would come back 429 (or 413), and on Groq a *failed* request still counts
	 * against the daily request budget. `apiFetch` would then back off on a schedule derived
	 * from nothing in particular, while the header says exactly when the tokens return.
	 *
	 * Returns 0 whenever the answer isn't clear-cut — no data, stale data, no reset to wait
	 * for, or a request so large it would not fit even a full window (that one is a budget
	 * problem, and sleeping would only delay the error that says so).
	 */
	/**
	 * The {@link ApiFetchOptions} fields that keep this tracker fed and acted upon, for a
	 * chat POST about `model`.
	 *
	 * A helper rather than two lines copied into each provider, because the two halves have
	 * to agree: recording under one model key while pacing against another would read a
	 * limit that belongs to a different model and either stall a healthy run or fail to
	 * pace a doomed one. The return type is structural to avoid importing `ApiFetchOptions`
	 * from `types.ts`, which already imports this module.
	 */
	fetchOpts(model: string): { onResponse: (response: Response) => void; pace: (estimated: number) => number } {
		return {
			onResponse: response => this.note(model, response),
			pace: estimated => this.delayFor(model, estimated),
		};
	}

	/**
	 * The recording half of {@link fetchOpts} without the pacing half.
	 *
	 * {@link fetchOpts} deliberately keeps the two together so a caller cannot record under
	 * one model while pacing against another. Inline completions need the split anyway, and
	 * for a reason that does not apply to chat: pacing means "send this later", and a
	 * completion has no later — the cursor will have moved. It skips the request instead.
	 * Readings are still recorded, because a real header beats a stale one for every caller.
	 */
	noteOnlyOpts(model: string): { onResponse: (response: Response) => void } {
		return { onResponse: response => this.note(model, response) };
	}

	delayFor(model: string, estimatedTokens: number, now = Date.now()): number {
		const snapshot = this.byModel.get(model);
		if (!snapshot || snapshot.remainingTokens === undefined || snapshot.resetMs === undefined) {
			return 0;
		}
		// A stated limit that is not a request ceiling (Anthropic's uncached-input bucket) is not
		// comparable with an estimate of the whole request: waiting on it only slowed every step
		// whose prompt was mostly cache (see {@link RateLimitSnapshot.requestCeiling}).
		if (snapshot.limitTokens !== undefined && snapshot.requestCeiling === undefined) {
			return 0;
		}
		const age = now - snapshot.at;
		if (age >= SNAPSHOT_TTL_MS || estimatedTokens <= snapshot.remainingTokens) {
			return 0;
		}
		if (snapshot.requestCeiling !== undefined && estimatedTokens > snapshot.requestCeiling) {
			return 0;
		}
		return Math.min(MAX_PACE_MS, Math.max(0, snapshot.resetMs - age));
	}
}
