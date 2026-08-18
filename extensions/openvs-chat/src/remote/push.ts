/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 6b of "remote control": the host-side copy of `openvs-relay/src/push.ts`'s `shouldPush`
 * rule. The relay never infers "should I push" from `t: 'm'` traffic — pushing must be an
 * explicit `push` control frame the host sends, precisely so the relay does not need its own
 * copy of this policy either way (see that file's doc and `openvs-relay/src/protocol.ts`'s
 * `PushFrame` doc). Since the *decision* has to be made here, before the control frame is ever
 * sent, this file hand-duplicates the relay's rule rather than the relay duplicating this one —
 * the same cross-package duplication `protocol.ts` already does for the wire envelope itself
 * (see that file's own top-of-file doc for why: no bundler links this extension to
 * `openvs-relay`, and they ship independently).
 *
 * `vscode`-free and pure, like `coalescer.ts`/`policy.ts`, so `scripts/test-remote-push.mjs` can
 * drive it under plain node with a fake clock.
 */

/** Minimum spacing between two pushes for the same session. Mirrors `openvs-relay/src/push.ts`'s `PUSH_RATE_LIMIT_MS`. */
const PUSH_RATE_LIMIT_MS = 10_000;

/** A `done` event only pushes if the run it closes ran at least this long. Mirrors `openvs-relay/src/push.ts`'s `DONE_PUSH_THRESHOLD_MS`. */
const DONE_PUSH_THRESHOLD_MS = 60_000;

/**
 * Whether a given event should raise a push notification: `approvalRequest`/`askRequest`/`error`
 * always push (subject to the rate limit below); `done` pushes only when the run it closes took
 * longer than {@link DONE_PUSH_THRESHOLD_MS}; everything else (`token`, `toolStart`, `info`, and
 * any event type not named here) never pushes. Rate limiting is 1 per {@link PUSH_RATE_LIMIT_MS}
 * per session: `lastPushAtMs` is the session's own last-push timestamp (or `undefined` if it has
 * never pushed), and `nowMs` is a parameter rather than `Date.now()` so this stays deterministic
 * under test. Kept byte-for-byte in step with `openvs-relay/src/push.ts`'s own `shouldPush` — see
 * this file's top doc for why the two can't just share one implementation.
 *
 * Written as `if`/`else` rather than a `switch` on purpose, the same reason
 * `remoteService.ts`'s `handleStatus` is: `scripts/test-remote-policy.mjs` (and
 * `test-webview.mjs`) statically scan every `.ts` file directly under `src/remote` for
 * `case '<word>':` to extract the host↔webview message vocabulary that has to be sorted into
 * `policy.ts`'s allow/deny lists — a `switch` here would put these *push-eligibility* event
 * names into that scan by accident, since the regex can't tell this switch apart from a message
 * dispatcher by shape alone.
 */
export function shouldPush(eventType: string, lastPushAtMs: number | undefined, nowMs: number, runDurationMs?: number): boolean {
	let eligible: boolean;
	if (eventType === 'approvalRequest' || eventType === 'askRequest' || eventType === 'error') {
		eligible = true;
	} else if (eventType === 'done') {
		eligible = (runDurationMs ?? 0) > DONE_PUSH_THRESHOLD_MS;
	} else {
		// 'token' / 'toolStart' / 'info', and any event type not named above: never eligible.
		eligible = false;
	}
	if (!eligible) {
		return false;
	}
	if (lastPushAtMs === undefined) {
		return true;
	}
	return nowMs - lastPushAtMs >= PUSH_RATE_LIMIT_MS;
}
