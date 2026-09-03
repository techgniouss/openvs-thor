/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ambient declarations for the APIs a VS Code webview gets from its host rather than
 * from the DOM. `media/main.js` runs under `// @ts-check`, which is the only type safety
 * that file has; without this the very first line is an error, and an error on line 1
 * trains everyone to ignore the rest.
 */

/**
 * The messaging/state bridge injected into every webview. Callable exactly once.
 *
 * `getState` is typed `any` rather than `unknown` on purpose: what comes back is
 * whatever JSON a previous session wrote, possibly from an older build, and `main.js`
 * already re-validates every field it reads (`Array.isArray`, `typeof … === 'string'`).
 * Typing it `unknown` would only buy a wall of casts at the call sites that are already
 * doing the real checking.
 */
declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
	getState(): any;
	setState(state: unknown): void;
};

interface Window {
	/** Set by the host: true when this webview is the detached Settings editor tab. */
	__OPENVS_SETTINGS_ONLY__?: boolean;
	/**
	 * Set by the host: the `vscode-webview://` URI of `media/hero.png`, the brand mark
	 * drawn on the empty chat. The webview cannot build this itself — relative paths
	 * resolve against the document, not the extension's media folder.
	 */
	__OPENVS_HERO_URI__?: string;
}

/** One selectable answer offered by an `ask_user` question. */
interface OpenVSAskOption {
	label: string;
	description?: string;
}

/** A prompt the extension host is blocked on, as it arrives over postMessage. */
interface OpenVSPromptRequest {
	id: string;
	type: string;
	sessionId?: string;
	title?: string;
	detail?: string;
	preview?: string;
	previewLanguage?: string;
	question?: string;
	options?: OpenVSAskOption[];
	multiSelect?: boolean;
	chosen?: string[];
}

/**
 * Approval/question card rendering, provided by `media/prompts.js`, which the host loads
 * immediately before `media/main.js`.
 */
declare const OpenVSPrompts: {
	create(deps: {
		container: { appendChild(node: any): void };
		post: (message: any) => void;
		scroll?: () => void;
	}): {
		render(request: OpenVSPromptRequest): any;
		track(request: OpenVSPromptRequest): void;
		reattach(sessionId: string): void;
		cancel(id: string, reason?: string): void;
		has(id: string): boolean;
		size(): number;
	};
};

/** A freshly minted pairing code, as answered by the host's `remote` message's `pairing` field. */
interface OpenVSPairingResult {
	code: string;
	expiresAt: number;
	url: string;
}

/** One paired device, as answered by the host's `remote` message's `devices` field (Phase 7c). */
interface OpenVSDeviceInfo {
	id: string;
	name: string;
	createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

/**
 * The transcript's markdown renderer, provided by `media/markdown.js`, which the host loads
 * before `media/main.js`. Pure string → HTML: no DOM, so `scripts/test-markdown.mjs` drives
 * it directly.
 */
declare const OpenVSMarkdown: {
	render(text: string): string;
	escapeHtml(text: string): string;
	THOR_BOLT_PATH: string;
};

/** Byte-mode QR encoder (ECC level L, versions 1-6), provided by `media/qr.js`. */
declare const OpenVSQr: {
	encode(text: string): { size: number; modules: boolean[][] };
};

/**
 * Remote-control status indicator + pairing card, provided by `media/pairing.js`, which the
 * host loads after `media/qr.js` and before `media/main.js`.
 */
declare const OpenVSPairing: {
	create(deps: {
		container: { appendChild(node: any): void };
		post: (message: any) => void;
		now?: () => number;
	}): {
		update(payload: {
			enabled: boolean;
			connected: boolean;
			idleDisabled?: boolean;
			pairing?: OpenVSPairingResult;
			devices?: OpenVSDeviceInfo[];
		}): void;
	};
};
