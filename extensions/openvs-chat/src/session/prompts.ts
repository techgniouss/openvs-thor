/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 3 of "remote control": host-side state for the agent's two blocking channels to the
 * user (approval requests and `ask_user` questions), ported out of `chatViewProvider.ts`'s
 * `pendingPrompts: Map<string, (reply) => void>` plus `promptSeq`. `vscode`-free, like the
 * rest of `src/session/` — the webview-focus / native-dialog-fallback side effects stay in
 * `chatViewProvider.ts`'s `promptUser`; this module only tracks which prompts are outstanding
 * and how to settle each one.
 */

/** A prompt request currently awaiting a reply, as tracked by {@link PromptRegistry}. */
export interface PendingPrompt {
	readonly id: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly request: Record<string, unknown> & { type: string };
}

/** {@link PendingPrompt} plus the callbacks that settle the promise waiting on it. */
interface PromptRecord extends PendingPrompt {
	readonly resolve: (reply: Record<string, unknown> | undefined) => void;
	readonly reject: (err: Error) => void;
}

/**
 * Tracks outstanding approval/question prompts, keyed by a self-minted id. Re-keyed from the
 * old bare counter (`` `p${++promptSeq}` ``) to `` `${sessionId}:${runId}:${sequence}` `` per
 * the "remote control" plan's "Prompt arbitration" section, so an id carries which session and
 * run it belongs to instead of being opaque. `prompts.js` never parses a prompt id (it is only
 * ever round-tripped via `data-prompt-id`/`promptId`), so the colons are harmless there — and
 * they are fine for the contract tests too: the `[a-zA-Z]+` naming rule those enforce is on
 * message *type* fields, not on this id.
 */
export class PromptRegistry {
	private readonly pending = new Map<string, PromptRecord>();
	private seq = 0;

	/**
	 * Registers a new prompt and returns its id. `resolve`/`reject` are the caller's own
	 * promise executor's settle functions — the registry stores them (with the request, so a
	 * pending prompt can be replayed to a reconnecting sink) but never calls them itself except
	 * through {@link resolve}/{@link cancel}/{@link settleAllUnanswered}.
	 */
	register(
		sessionId: string,
		runId: string,
		request: Record<string, unknown> & { type: string },
		resolve: (reply: Record<string, unknown> | undefined) => void,
		reject: (err: Error) => void,
	): string {
		const id = `${sessionId}:${runId}:${++this.seq}`;
		this.pending.set(id, { id, sessionId, runId, request, resolve, reject });
		return id;
	}

	/**
	 * Settles a pending prompt with the user's reply and forgets it. Returns whether a prompt
	 * was actually found — `false` means it was already answered or cancelled, which is how
	 * `chatViewProvider.ts`'s `resolvePrompt` tells a genuine double-answer from the ordinary
	 * case. `reply` may be `undefined`: an escalation timeout resolves with that, so the run
	 * falls through to the native-dialog fallback exactly as an absent chat sink always has.
	 */
	resolve(id: string, reply: Record<string, unknown> | undefined): boolean {
		const record = this.pending.get(id);
		if (!record) {
			return false;
		}
		this.pending.delete(id);
		record.resolve(reply);
		return true;
	}

	/** The prompt's current record, or `undefined` if it isn't (or is no longer) pending. */
	get(id: string): PendingPrompt | undefined {
		return this.pending.get(id);
	}

	/** Every prompt still awaiting a reply — used by `chatViewProvider.ts`'s `rebindPrompts`. */
	allPending(): readonly PendingPrompt[] {
		return [...this.pending.values()];
	}

	/**
	 * Settles a prompt by rejection instead of resolution — used when the run that raised it
	 * is aborted, so the caller's `await` throws instead of hanging forever. Returns whether a
	 * prompt was found, same contract as {@link resolve}.
	 */
	cancel(id: string, err: Error): boolean {
		const record = this.pending.get(id);
		if (!record) {
			return false;
		}
		this.pending.delete(id);
		record.reject(err);
		return true;
	}

	/**
	 * Settles every still-pending prompt with an empty reply — "denied" to an approval, and
	 * "dismissed" to a question. This is the renamed, narrowed-scope replacement for the old
	 * `flushPrompts()`. Per the "remote control" plan's "Prompt arbitration" section, **it must
	 * be called only on extension deactivate, never on a webview reload** — a reload is what
	 * `chatViewProvider.ts`'s `rebindPrompts` handles instead, replaying the same cards to the
	 * reconnecting sink so the run they belong to is never disturbed. Do not wire this back to
	 * a `case 'ready':` handler without re-reading why it was moved here.
	 */
	settleAllUnanswered(): void {
		const waiting = [...this.pending.values()];
		this.pending.clear();
		for (const record of waiting) {
			record.resolve({});
		}
	}
}
