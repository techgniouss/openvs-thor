/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MessageSink } from '../session/bus';
import { CoalescedMessage, TokenCoalescer } from './coalescer';
import { Envelope } from './protocol';
import { shouldPush } from './push';
import { RemoteSocket } from './socket';

/**
 * Phase 5 of "remote control": the {@link MessageSink} a remote (relay-connected) client is
 * registered on the bus as. Every outbound message is redacted (see {@link redactForRemote}),
 * then fed through a per-sink {@link TokenCoalescer} before being wrapped in a `t: 'm'`
 * envelope and sent down the wire — `token` deltas get batched, everything else flushes the
 * batch first and goes out immediately (the coalescer's own ordering barrier).
 *
 * Incoming traffic is deliberately not this class's job: `RemoteSocket.onMessage` is wired up
 * by `remoteService.ts`, which is what checks `isRemoteAllowed` and dispatches into the host —
 * this class only owns the outbound half.
 */

/** Bytes beyond which a redacted field is truncated with a marker. */
const REMOTE_TRUNCATE_BYTES = 8 * 1024;
const TRUNCATION_SUFFIX = '\n… [truncated for remote]';

/** Push notification bodies stay short — see `composePush`'s `error` case. */
const PUSH_BODY_TRUNCATE_CHARS = 120;

/** Message types {@link RemoteSink.post} ever considers pushing for — matches the event types `push.ts`'s `shouldPush` treats as potentially eligible. */
type PushableEventType = 'approvalRequest' | 'askRequest' | 'error' | 'done';

function isPushableEventType(type: string): type is PushableEventType {
	return type === 'approvalRequest' || type === 'askRequest' || type === 'error' || type === 'done';
}

/** Truncates `text` to at most `maxChars` characters, marking the cut with an ellipsis. Chars, not bytes — push notification bodies are short by nature, so the byte-precision `truncateUtf8` below uses for large tool output would be overkill here. */
function truncateForPush(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Builds `{title, body, tag}` for a `push` control frame from the host message that triggered
 * it, per the "remote control" plan's Web Push section. `tag` is the prompt's `id` for
 * `approvalRequest`/`askRequest` (so a later phase can close a matching desktop notification once
 * it's answered) and the message `type` otherwise.
 *
 * Written as `if`/`else` rather than a `switch` on purpose — same reason as `push.ts`'s
 * `shouldPush`: a `switch` here would put these event names into
 * `scripts/test-remote-policy.mjs`'s `case '<word>':` scan by accident. See that function's doc.
 */
function composePush(message: Record<string, unknown> & { type: string }, eventType: PushableEventType): { title: string; body: string; tag: string } {
	if (eventType === 'approvalRequest') {
		return {
			title: 'Approval needed',
			body: typeof message.title === 'string' ? message.title : 'A tool call needs your approval.',
			tag: typeof message.id === 'string' ? message.id : message.type,
		};
	}
	if (eventType === 'askRequest') {
		return {
			title: 'Question',
			body: typeof message.question === 'string' ? message.question : 'The agent has a question.',
			tag: typeof message.id === 'string' ? message.id : message.type,
		};
	}
	if (eventType === 'error') {
		return {
			title: 'Error',
			body: truncateForPush(typeof message.message === 'string' ? message.message : 'An error occurred.', PUSH_BODY_TRUNCATE_CHARS),
			tag: message.type,
		};
	}
	// eventType === 'done', the only remaining member of PushableEventType.
	return { title: 'Run finished', body: 'A long-running task finished.', tag: message.type };
}

/** Truncates `text` to at most `maxBytes` UTF-8 bytes, without splitting the fields it's applied to any more carefully than a byte boundary — good enough for a first pass. */
function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
		return text;
	}
	return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
}

/** `url`'s host only, or a fixed placeholder if it doesn't parse — never the original string, since a `custom` base URL can carry a token in its path or query. */
function hostnameOnly(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '[redacted]';
	}
}

/** Redacts `baseUrl`/`authUrl` to hostname-only inside a `config` message's per-provider list. */
function redactProviders(providers: unknown): unknown {
	if (!Array.isArray(providers)) {
		return providers;
	}
	return providers.map(entry => {
		if (typeof entry !== 'object' || entry === null) {
			return entry;
		}
		const redacted: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
		if (typeof redacted.baseUrl === 'string') {
			redacted.baseUrl = hostnameOnly(redacted.baseUrl);
		}
		if (typeof redacted.authUrl === 'string') {
			redacted.authUrl = hostnameOnly(redacted.authUrl);
		}
		return redacted;
	});
}

/**
 * First-pass redaction for a message about to leave over the wire to a remote client, per the
 * "remote control" plan's "Security boundary" section: large `content`/`preview` fields (tool
 * results, `read_file` output) truncate to 8KB with a marker, and `baseUrl`/`authUrl` — on the
 * message itself, or nested per-provider inside a `config` message — reduce to hostname-only.
 * This is deliberately small: full redaction (every field, every message type) is more than
 * this task needs and is left for a later hardening pass — see the plan's Phase 7 staging.
 */
export function redactForRemote(message: Record<string, unknown> & { type: string }): Record<string, unknown> & { type: string } {
	const clone: Record<string, unknown> = { ...message };
	for (const field of ['content', 'preview'] as const) {
		const value = clone[field];
		if (typeof value === 'string') {
			clone[field] = truncateUtf8(value, REMOTE_TRUNCATE_BYTES) + (Buffer.byteLength(value, 'utf8') > REMOTE_TRUNCATE_BYTES ? TRUNCATION_SUFFIX : '');
		}
	}
	if (typeof clone.baseUrl === 'string') {
		clone.baseUrl = hostnameOnly(clone.baseUrl);
	}
	if (typeof clone.authUrl === 'string') {
		clone.authUrl = hostnameOnly(clone.authUrl);
	}
	if (message.type === 'config' && 'providers' in clone) {
		clone.providers = redactProviders(clone.providers);
	}
	return clone as Record<string, unknown> & { type: string };
}

/**
 * The {@link MessageSink} implementation wrapping one {@link RemoteSocket}. `id` is caller-
 * supplied (matching the constant-id convention `chatViewProvider.ts` uses for its own sinks)
 * rather than minted here, since there is exactly one of these per connected relay socket and
 * `remoteService.ts` already knows what to call it.
 *
 * Also owns the Web Push *trigger*: every message posted here is checked against `push.ts`'s
 * `shouldPush` and, when it qualifies, sent to the relay as a `push` control frame — this is the
 * one place that already sees every outbound message and holds the socket to send one on, per
 * the plan's "wire it into the point that already knows a message is about to reach a remote
 * sink" framing. `lastPushAtMs`/`runStartedAtMs` are tracked per session id, in-memory only (no
 * persistence, resetting on extension restart is fine — there is no offline queue in this design
 * either, see `socket.ts`'s own doc). This extension has exactly one `RemoteSink` per connected
 * relay (one room, one host connection fanned out to however many client *devices* the relay
 * itself is talking to — see `room.ts`'s `routeAppMessage`), so there is no way from here to
 * tell "a device is already looking at this" from "no device is" — pushing whenever `shouldPush`
 * says yes, regardless, is an accepted simplification for this phase (a redundant notification on
 * a device already open is a minor annoyance, not a correctness bug), not an attempt to solve
 * per-device presence.
 */
export class RemoteSink implements MessageSink {
	readonly kind = 'remote' as const;
	readonly wantsChat = true;
	private readonly coalescer: TokenCoalescer;
	private seq = 0;
	/** Session id -> the `Date.now()` of this sink's last raised push. */
	private readonly lastPushAtMs = new Map<string, number>();
	/** Session id -> the `Date.now()` its current run started at, from the run's `runStart` message — needed for `shouldPush`'s `done` threshold. */
	private readonly runStartedAtMs = new Map<string, number>();

	constructor(readonly id: string, private readonly socket: RemoteSocket) {
		this.coalescer = new TokenCoalescer(message => this.transmit(message));
		this.socket.onRtt(rttMs => this.coalescer.setRttMs(rttMs));
	}

	post(message: Record<string, unknown> & { type: string }): void {
		this.maybeRaisePush(message);
		this.coalescer.feed(redactForRemote(message) as CoalescedMessage);
	}

	dispose(): void {
		// Anything still buffered when the sink tears down is worth sending — a disconnect
		// arriving mid-batch should not silently drop the tail of a streamed reply.
		this.coalescer.flushAll();
		this.socket.dispose();
	}

	private transmit(message: Record<string, unknown> & { type: string }): void {
		const envelope: Envelope = { v: 1, t: 'm', seq: ++this.seq, p: message };
		this.socket.send(envelope);
	}

	/**
	 * Tracks a run's start time (`runStart` carries no timestamp of its own; `chatViewProvider.ts`
	 * mints one host-side per message it posts via `sessionPost`, always including `sessionId` —
	 * see its doc), and — for every message type `push.ts`'s `shouldPush` might act on — raises a
	 * `push` control frame when it says yes.
	 */
	private maybeRaisePush(message: Record<string, unknown> & { type: string }): void {
		const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
		if (message.type === 'runStart') {
			this.runStartedAtMs.set(sessionId, Date.now());
			return;
		}
		if (!isPushableEventType(message.type)) {
			return;
		}
		const now = Date.now();
		const runDurationMs = message.type === 'done' ? this.runDurationMs(sessionId, now) : undefined;
		if (!shouldPush(message.type, this.lastPushAtMs.get(sessionId), now, runDurationMs)) {
			return;
		}
		this.lastPushAtMs.set(sessionId, now);
		const { title, body, tag } = composePush(message, message.type);
		this.socket.sendControl({ c: 'push', title, body, tag, sessionId });
	}

	/** Elapsed time since `sessionId`'s tracked run start, or `undefined` if none was ever recorded (e.g. a `done` from before this sink connected). */
	private runDurationMs(sessionId: string, now: number): number | undefined {
		const startedAt = this.runStartedAtMs.get(sessionId);
		return startedAt === undefined ? undefined : now - startedAt;
	}
}
