/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deny-by-default policy for the "remote control" feature: which webview→host message types a
 * *remote* client (e.g. a phone attached to a running session) is permitted to send.
 *
 * The desktop webview and a remote client are not the same trust boundary. The desktop
 * webview runs next to the developer who owns the machine; a remote client is, by design, a
 * second device the run-owning developer is not sitting at. Every message type the host
 * dispatcher accepts from the desktop webview is therefore sorted into exactly one of two
 * lists here — there is no third, unlisted state a message type can be in. `REMOTE_ALLOWED`
 * is the phone's actual job (drive a run, pick a model, answer a prompt); `REMOTE_DENIED` is
 * everything else, including anything that touches local files, secrets, or the desktop's
 * security posture.
 *
 * This file imports nothing and has no side effects: it is pure data plus one predicate, so
 * it can be read by a node test without a build step, and later phases (the actual remote
 * transport) import `isRemoteAllowed` rather than re-deriving this list.
 *
 * A message type added in a later phase must be placed in exactly one of these two lists.
 * `scripts/test-remote-policy.mjs` enforces this mechanically: it extracts every `case`
 * handled by the host dispatcher and asserts the two lists exactly partition that set, so a
 * forgotten new type fails the test rather than defaulting to allowed.
 */

/**
 * Message types a remote client may send. Kept intentionally small: enough to drive an
 * existing run (send, steer, stop, answer a prompt) and pick what it runs with (provider,
 * model, skills, MCP servers) — nothing that reaches outside the chat itself.
 */
export const REMOTE_ALLOWED: readonly string[] = [
	'ready',
	'send',
	'promptResponse',
	'stop',
	'stopAll',
	'setProvider',
	'setModel',
	'listModels',
	'listSkills',
	'setSkill',
	'toggleSkill',
	'listMcp',
	'enhancePrompt',
	'steer',
	'createSession',
	'switchSession',
	'closeSession',
	'clearSession',
	'restoreSession',
	'setMode',
	'setQueue',
	'sync',
	'fetchTranscript',
	// Host-side slash-command dispatch (Phase 6a): everything it can do (mode/provider
	// switches, clear, skills, MCP) is already reachable individually through the allowed
	// types above — `slash` is just one more way to reach the same, already-vetted effects.
	'slash',
	// Phase 6c: the read-only, no-picker equivalent of `attachContext` — see REMOTE_DENIED's
	// entry for `attachContext` for why that one stays denied while this one is allowed.
	'attachActive',
	// Phase 6c: chunked image upload. Safe to allow because the *host* enforces bounded
	// per-upload (8MB) and per-session (32MB) size ceilings in src/remote/attachments.ts
	// regardless of what the client claims to be sending — a compromised or buggy device
	// cannot exhaust host memory by lying about chunk counts or resending forever. The
	// client-side resize-before-encode (1568px longest edge) is a courtesy that keeps
	// well-behaved uploads small and fast; it is not what makes this safe to allow, since
	// nothing stops a client from skipping it, so the security boundary is entirely the
	// host-side caps, not client behaviour.
	'attachImage',
];

/**
 * Message types a remote client may never send. This is the larger list on purpose — anything
 * not obviously safe belongs here, not in `REMOTE_ALLOWED`.
 *
 * Six entries are denied for reasons that are not obvious from the name alone:
 *  - `openExternal` would let a remote client open any URL on the developer's desktop.
 *  - `setBaseUrl` and `setApproval` let a remote client *lower the security posture* (point a
 *    provider at an attacker-controlled endpoint, or turn off approval prompts) before doing
 *    anything else; that escalation path must not exist.
 *  - `applyEdit` / `insertAtCursor` write into whatever file the desktop user currently has
 *    open, at a cursor position the remote user cannot see and did not choose.
 *  - `attachContext` is *not* denied because it opens a picker — `handleAttachContext` in
 *    `chatViewProvider.ts` never shows one; it just reads the active editor's selection (or
 *    whole file), same as `attachActive` below. It stays denied because its webview-side
 *    sender is wired to whatever the desktop's "Attach context" button happens to do today —
 *    an implicit, UI-driven contract this task does not want to commit a remote client to.
 *    `attachActive` (`REMOTE_ALLOWED`) is the same read, exposed through its own message type
 *    with an explicit, remote-safe contract: read-only, no picker, truncated to 24KB, and its
 *    reply routed to the requesting sink alone via `bus.postTo` rather than broadcast.
 *  - `adopt` carries the *desktop* webview's own legacy `vscode.getState()` payload for a
 *    one-shot, one-device migration into the session store; it is meaningless — and a way to
 *    overwrite live session state wholesale — coming from anywhere else.
 *  - `requestPairing` mints a fresh pairing code for a *new, third* device. It is how the
 *    desktop user extends trust to someone else, not something an already-paired device should
 *    be able to trigger on its own — letting it would let one compromised device pair
 *    unlimited others.
 *  - `listDevices` (Phase 7c) enumerates every device paired to this room — names, creation and
 *    last-seen times. A remote client learning who else is trusted here is exactly the kind of
 *    cross-device visibility this boundary exists to prevent.
 *  - `revokeDevice` (Phase 7c) revokes another device's trust — or, worse, a device revoking
 *    *itself* or another paired device it has no business touching. Device administration is
 *    desktop-only, same reasoning as `requestPairing` immediately above.
 */
export const REMOTE_DENIED: readonly string[] = [
	'saveHistory',
	'requestOpenSettings',
	'closeSettingsWindow',
	'saveKey',
	'clearKey',
	'signIn',
	'setRole',
	'setApproval',
	'setReviewEnabled',
	'setCloudflareAccountId',
	'setBaseUrl',
	'setSystemPrompt',
	'setMaxTokens',
	'setRules',
	'setMaxSteps',
	'setMaxRunMinutes',
	'setDecompose',
	'attachContext',
	'applyEdit',
	'insertAtCursor',
	'testKey',
	'slashInline',
	'createSkill',
	'mcpAdd',
	'mcpReconnect',
	'mcpOpenConfig',
	'openExternal',
	'adopt',
	'requestPairing',
	'listDevices',
	'revokeDevice',
];

/**
 * Whether a remote client is permitted to send a message of the given `type`. A type that is
 * in neither list (should be unreachable once `test-remote-policy.mjs` passes) is treated as
 * denied — deny-by-default holds even if the partition test is somehow bypassed.
 */
export function isRemoteAllowed(type: string): boolean {
	return REMOTE_ALLOWED.includes(type);
}
