/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 3 of "remote control": a registry of message destinations plus origin-aware fan-out,
 * replacing `ChatViewProvider.post()`'s two-destination broadcast (`this.view` and
 * `this.settingsPanel`, hardcoded). `vscode`-free, like the rest of `src/session/` —
 * `chatViewProvider.ts` builds the concrete {@link MessageSink}s (a webview `postMessage`
 * wrapper, a settings-panel wrapper, a loopback `OutputChannel` writer) and registers/removes
 * them as those surfaces come and go; this file only fans messages out to whatever is
 * currently registered.
 *
 * Deliberately small: a registry plus two fan-out methods, not a message-bus framework.
 * Sequencing, replay rings and per-sink coalescing belong to Phase 5's `snapshot.ts` /
 * `coalescer.ts` — this phase only needs to know *where* a message should go, not how to
 * catch a sink up on what it missed.
 */

/** One destination a {@link SessionBus} can post a message to. */
export interface MessageSink {
	readonly id: string;
	readonly kind: 'webview' | 'settings' | 'remote';
	/** False for a sink that must not see chat traffic (the Settings tab). */
	readonly wantsChat: boolean;
	post(message: Record<string, unknown> & { type: string }): void;
	dispose(): void;
}

/**
 * Registry of {@link MessageSink}s plus origin-aware fan-out. `chatViewProvider.ts`'s `post()`
 * delegates to {@link post} here; the two-argument-list broadcast it used to do by hand is now
 * "however many sinks happen to be registered", which is what lets a later phase add a remote
 * sink without touching the fan-out logic itself.
 */
export class SessionBus {
	private readonly sinks = new Map<string, MessageSink>();
	/**
	 * Message `type`s that must never reach a `wantsChat: false` sink. Not hardcoded here: the
	 * canonical list (`CHAT_ONLY_MESSAGES` in `media/main.js`) lives in the webview, and this
	 * file has to stay `vscode`-free, so `chatViewProvider.ts` supplies its own copy once.
	 */
	private chatOnlyTypes: ReadonlySet<string> = new Set();

	/** Declares which message `type`s are chat-only; see {@link chatOnlyTypes}'s doc. */
	setChatOnlyTypes(types: ReadonlySet<string>): void {
		this.chatOnlyTypes = types;
	}

	/** Registers a sink, replacing any previous sink with the same id. */
	addSink(sink: MessageSink): void {
		this.sinks.set(sink.id, sink);
	}

	/** Unregisters and disposes a sink. A no-op if no sink with that id is registered. */
	removeSink(id: string): void {
		const sink = this.sinks.get(id);
		if (!sink) {
			return;
		}
		this.sinks.delete(id);
		sink.dispose();
	}

	/** Broadcasts to every registered sink, withholding chat-only types from a `wantsChat: false` sink. */
	post(message: Record<string, unknown> & { type: string }): void {
		const chatOnly = this.chatOnlyTypes.has(message.type);
		for (const sink of this.sinks.values()) {
			if (chatOnly && !sink.wantsChat) {
				continue;
			}
			sink.post(message);
		}
	}

	/** Posts to exactly one sink by id. Silently no-ops if that sink isn't registered. */
	postTo(sinkId: string, message: Record<string, unknown> & { type: string }): void {
		this.sinks.get(sinkId)?.post(message);
	}

	/** True if any registered sink can render chat traffic. */
	hasChatSink(): boolean {
		for (const sink of this.sinks.values()) {
			if (sink.wantsChat) {
				return true;
			}
		}
		return false;
	}

	/** Every registered sink of a given kind. Unused before a later phase adds a remote sink. */
	sinksOfKind(kind: MessageSink['kind']): MessageSink[] {
		return [...this.sinks.values()].filter(sink => sink.kind === kind);
	}
}
