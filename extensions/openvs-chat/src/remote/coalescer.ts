/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5 of "remote control": batches `token` streaming deltas per session before they go out
 * over a remote socket. One WebSocket frame per SSE delta is 20–60 radio wakes/second on LTE,
 * and wake count — not bytes — dominates mobile battery, so this exists purely to cut frame
 * count without adding perceptible latency. `vscode`-free and pure, like `policy.ts`, so
 * `scripts/test-remote-coalescer.mjs` can drive it under plain node with a fake clock.
 *
 * Not used for the webview sink — that sink is in-process, and `media/main.js`'s own rAF
 * repaint coalescer already handles it (see `chatViewProvider.ts`'s doc on `post()`).
 */

/** A host→client message, as fed into {@link TokenCoalescer.feed}. */
export type CoalescedMessage = Record<string, unknown> & { type: string; sessionId?: string };

/** A function the coalescer emits (batched or passed-through) messages through. */
export type CoalescerEmit = (message: CoalescedMessage) => void;

/**
 * The clock/timer seam, matching the `SessionDeps` pattern in `src/session/store.ts`: real
 * globals by default, a fake clock injected by the test so flush timing can be asserted
 * exactly instead of "eventually".
 */
export interface CoalescerDeps {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const REAL_DEPS: CoalescerDeps = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Default flush window before any RTT has been measured — below the ~150ms threshold where streaming stops reading as continuous. */
const DEFAULT_WINDOW_MS = 100;
/** Flush as soon as a session's buffered delta reaches this many bytes, even before the window elapses. */
const FLUSH_BYTES = 2 * 1024;
/** No emitted batch may exceed this many bytes, so one batch can never head-of-line-block a prompt behind it. */
const HARD_CAP_BYTES = 8 * 1024;
const MIN_WINDOW_MS = 50;
const MAX_WINDOW_MS = 250;
const FAST_RTT_MS = 80;
const SLOW_RTT_MS = 250;
const FAST_WINDOW_MS = 60;
const SLOW_WINDOW_MS = 200;

/** One session's in-flight buffered delta, awaiting a size- or time-triggered flush. */
interface Batch {
	delta: string;
	/** The most recently fed `token` message for this session, minus `delta` — reused as the emitted batch's other fields (`sessionId`, `runId`, …). */
	rest: CoalescedMessage;
	timer?: unknown;
}

/** UTF-8 byte length of a string — what actually crosses the wire, not its character count. */
function byteLength(s: string): number {
	return Buffer.byteLength(s, 'utf8');
}

/** The session a message belongs to, or `''` for one that carries no `sessionId` at all. */
function sessionKeyOf(message: CoalescedMessage): string {
	return typeof message.sessionId === 'string' ? message.sessionId : '';
}

/**
 * Batches `token` deltas per session and flushes them as a single concatenated `token` message,
 * per the "remote control" plan's "Token coalescing" section. See the class-level rules this
 * implements: 100ms/2KB flush trigger, RTT-adaptive window, the non-`token` ordering barrier,
 * and the 8KB hard cap.
 */
export class TokenCoalescer {
	private readonly batches = new Map<string, Batch>();
	private windowMs = DEFAULT_WINDOW_MS;

	constructor(private readonly emit: CoalescerEmit, private readonly deps: CoalescerDeps = REAL_DEPS) { }

	/**
	 * Adjusts the flush window from a measured heartbeat round-trip time: under 80ms uses a
	 * tight 60ms window, over 250ms relaxes to 200ms, and everything in between is linearly
	 * interpolated — always clamped to [50, 250]. Only affects timers armed *after* this call;
	 * a batch already waiting on the previous window is not rescheduled.
	 */
	setRttMs(rtt: number): void {
		let window: number;
		if (rtt < FAST_RTT_MS) {
			window = FAST_WINDOW_MS;
		} else if (rtt > SLOW_RTT_MS) {
			window = SLOW_WINDOW_MS;
		} else {
			const t = (rtt - FAST_RTT_MS) / (SLOW_RTT_MS - FAST_RTT_MS);
			window = FAST_WINDOW_MS + t * (SLOW_WINDOW_MS - FAST_WINDOW_MS);
		}
		this.windowMs = Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.round(window)));
	}

	/**
	 * Feeds one outbound message. A `token` message is buffered into its session's batch; every
	 * other message type first flushes that session's pending batch (the ordering barrier — a
	 * tool block or approval card must never queue behind buffered prose) and is then emitted
	 * immediately, un-reordered.
	 */
	feed(message: CoalescedMessage): void {
		if (message.type !== 'token') {
			this.flushKey(sessionKeyOf(message));
			this.emit(message);
			return;
		}
		const key = sessionKeyOf(message);
		const delta = typeof message.delta === 'string' ? message.delta : '';
		let batch = this.batches.get(key);
		// The hard cap: if this delta would push the batch over 8KB, flush what's already
		// buffered first rather than let one emitted batch grow past the cap.
		if (batch && byteLength(batch.delta) + byteLength(delta) > HARD_CAP_BYTES) {
			this.flushBatch(key, batch);
			batch = undefined;
		}
		if (!batch) {
			batch = { delta: '', rest: message };
			this.batches.set(key, batch);
		}
		batch.delta += delta;
		batch.rest = message;
		if (byteLength(batch.delta) >= FLUSH_BYTES) {
			this.flushBatch(key, batch);
			return;
		}
		if (batch.timer === undefined) {
			batch.timer = this.deps.setTimeout(() => {
				const current = this.batches.get(key);
				if (current) {
					this.flushBatch(key, current);
				}
			}, this.windowMs);
		}
	}

	/** Flushes every session's pending batch immediately — used when the sink holding this coalescer tears down. */
	flushAll(): void {
		for (const key of [...this.batches.keys()]) {
			this.flushKey(key);
		}
	}

	private flushKey(key: string): void {
		const batch = this.batches.get(key);
		if (batch) {
			this.flushBatch(key, batch);
		}
	}

	private flushBatch(key: string, batch: Batch): void {
		if (batch.timer !== undefined) {
			this.deps.clearTimeout(batch.timer);
		}
		this.batches.delete(key);
		if (!batch.delta) {
			return;
		}
		this.emit({ ...batch.rest, type: 'token', delta: batch.delta });
	}
}
