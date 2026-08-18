// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// The cross-boundary drift check the plan calls out by name: without this, the PWA would slowly
// reproduce the exact class of silent failure `extensions/openvs-chat/scripts/test-webview.mjs`
// exists to prevent for the desktop webview — a message type the host starts sending (or the PWA
// starts sending) that the other side quietly doesn't handle. It reads the extension's own
// sources (never the reverse — the extension's test suite stays hermetic, this file lives here
// specifically so scanning it does not become that package's problem) and `pwa/app.js`, and
// applies the exact same regex-extraction technique `test-webview.mjs`/`test-remote-policy.mjs`
// use, so a change to either half fails loudly here instead of only showing up as a phone
// silently not rendering something, or the relay's own policy silently drifting from what the
// PWA actually sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = p => new URL(p, import.meta.url);
const EXT = '../../extensions/openvs-chat';

/** Same helper as test-webview.mjs/test-remote-policy.mjs: concatenates fixed files with every `.ts` directly under each dir. */
function readSourceSet(fixed, dirs) {
	const parts = fixed.map(p => fs.readFileSync(url(p), 'utf8'));
	for (const dir of dirs) {
		const dirUrl = url(`${dir}/`);
		if (!fs.existsSync(dirUrl)) { continue; }
		for (const entry of fs.readdirSync(dirUrl).sort()) {
			if (entry.endsWith('.ts')) { parts.push(fs.readFileSync(new URL(entry, dirUrl), 'utf8')); }
		}
	}
	return parts.join('\n');
}

const host = readSourceSet([`${EXT}/src/chatViewProvider.ts`], [`${EXT}/src/session`, `${EXT}/src/remote`]);
const policySrc = fs.readFileSync(url(`${EXT}/src/remote/policy.ts`), 'utf8');
const appJs = fs.readFileSync(url('../pwa/app.js'), 'utf8');
// cards.js sends `promptResponse` via the `post` callback it is handed (`deps.post({ type: ... })`)
// rather than `sendApp` directly — the same split test-webview.mjs accounts for between main.js's
// `vscode.postMessage` and prompts.js's `deps.post`.
const cardsJs = fs.readFileSync(url('../pwa/cards.js'), 'utf8');

/** All matches of `re`'s first capture group, deduped. */
function captures(text, re) {
	return [...new Set([...text.matchAll(re)].map(m => m[1]))];
}

// ---- What the host sends -------------------------------------------------------------------

/** Every message type the host posts, via `post({ type: '...' })` or the blocking `promptUser({ type: '...' })`. Same extraction `test-webview.mjs` uses. */
const hostSends = new Set([
	...captures(host, /post\(\{\s*type:\s*'([a-zA-Z]+)'/g),
	...captures(host, /promptUser\(\{\s*type:\s*'([a-zA-Z]+)'/g),
]);
assert.ok(hostSends.size > 20, `expected the host's outbound message set to be found, got ${hostSends.size}`);

/**
 * Message types a lean remote client genuinely does not need, with the reasoning inline (per the
 * task's instruction to document this list rather than reuse `main.js`'s much larger
 * `CHAT_ONLY_MESSAGES` — that list exists to keep the detached *Settings* tab off chat traffic
 * entirely; a remote client is the opposite case, it wants chat traffic and the settings-ish
 * catalogs (`models`/`skills`/`mcp`) it needs to drive pickers, so the exclusion here is much
 * smaller and for different reasons per type). `config` is deliberately *not* in this list even
 * though most of its payload is desktop-only (base URLs, key-presence flags, guardrail config,
 * none of which a remote client can act on — every message type that would let it try is
 * `REMOTE_DENIED`): `pwa/app.js`'s `case 'config':` pulls out just `providers`/`selectedProvider`
 * to drive its own provider picker, the one part of that payload a remote client genuinely needs
 * (this was the actual bug once — `config` went fully unhandled, so `providers` stayed empty
 * forever and the model dropdown, which only fills in once a provider is selected, was empty too).
 *  - `selectProvider` — mirrors a desktop command-palette selection into the *local* webview's
 *                    own provider dropdown state; a remote client picks its own provider via
 *                    `setProvider`/`setModel` per session, it does not need to be told what the
 *                    desktop's dropdown currently shows.
 *  - `newChat`     — a desktop UI-focus trigger (the "+" button/command); redundant with the
 *                    `sessions` push that follows it, which is what actually updates state.
 *  - `inline`      — an editor-command-triggered Ask/Edit invocation (Explain/Fix/Doc/Optimize
 *                    selection); tied to a local editor selection the remote user cannot see.
 *  - `editProposal`  — a proposed file edit tied to a local editor apply button; `applyEdit` is
 *                    `REMOTE_DENIED`, so a remote client has nothing to do with this either.
 *  - `context`     — the reply to `attachContext`, which is itself `REMOTE_DENIED` (it opens a
 *                    local file picker with nobody at the desktop to drive it); the read-only
 *                    `attachActive` replacement the plan describes for remote sinks is Phase 6
 *                    work, not yet sent by the host at all.
 */
const EXCLUDED_FROM_PWA = new Set(['selectProvider', 'newChat', 'inline', 'editProposal', 'context']);

for (const excluded of EXCLUDED_FROM_PWA) {
	assert.ok(hostSends.has(excluded), `"${excluded}" is in the exclusion list but the host no longer sends it — remove it from EXCLUDED_FROM_PWA`);
}

// ---- 1. Every host-sent type the PWA needs has a real case in pwa/app.js -----------------------

const pwaHandles = new Set(captures(appJs, /^\s*case '([a-zA-Z]+)':/gm));
assert.ok(pwaHandles.size > 10, `expected pwa/app.js's dispatcher to be found, got ${pwaHandles.size} cases`);

{
	const unhandled = [...hostSends].filter(t => !EXCLUDED_FROM_PWA.has(t) && !pwaHandles.has(t));
	assert.deepStrictEqual(unhandled, [], 'the host posts these but pwa/app.js does not handle them');
	for (const expected of ['sessions', 'transcript', 'runStart', 'token', 'agentStepEnd', 'toolStart', 'toolEnd', 'todos', 'done', 'error', 'info', 'approvalRequest', 'askRequest', 'promptCancel', 'commands', 'remote']) {
		assert.ok(hostSends.has(expected), `expected the host to post "${expected}" (sanity check on the extraction itself)`);
		assert.ok(pwaHandles.has(expected), `pwa/app.js must handle "${expected}" — it is in this task's stated minimum set`);
	}
}

// ---- 2. Everything pwa/app.js sends is REMOTE_ALLOWED *and* has a real host case ----------------

const pwaSends = new Set([
	...captures(appJs, /sendApp\(\{\s*type:\s*'([a-zA-Z]+)'/g),
	...captures(cardsJs, /deps\.post\(\{\s*type:\s*'([a-zA-Z]+)'/g),
]);
assert.ok(pwaSends.size > 5, `expected pwa/app.js's outbound sends to be found, got ${pwaSends.size}`);

function extractList(src, name) {
	const re = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`);
	const match = re.exec(src);
	assert.ok(match, `expected src/remote/policy.ts to export ${name}`);
	return captures(match[1], /'([a-zA-Z]+)'/g);
}
const remoteAllowed = extractList(policySrc, 'REMOTE_ALLOWED');
const hostHandles = new Set(captures(host, /^\s*case '([a-zA-Z]+)':/gm));

{
	const notAllowed = [...pwaSends].filter(t => !remoteAllowed.includes(t));
	assert.deepStrictEqual(notAllowed, [], 'pwa/app.js sends these but they are not in REMOTE_ALLOWED — either the PWA or the policy has drifted');

	const notHandled = [...pwaSends].filter(t => !hostHandles.has(t));
	assert.deepStrictEqual(notHandled, [], 'pwa/app.js sends these but the host dispatcher has no case for them');

	assert.ok(pwaSends.has('send'), 'the PWA can send a chat message');
	assert.ok(pwaSends.has('promptResponse'), 'the PWA can answer a prompt');
}

// ---- 3. The PWA's own hand-copied REMOTE_ALLOWED list (its top-of-file doc references it) must
// match the real one exactly, or its own "is this type allowed" reasoning silently goes stale. ---

{
	const appJsListMatch = /const REMOTE_ALLOWED = \[([\s\S]*?)\];/.exec(appJs);
	assert.ok(appJsListMatch, 'pwa/app.js documents its own copy of REMOTE_ALLOWED');
	const appJsList = captures(appJsListMatch[1], /'([a-zA-Z]+)'/g);
	assert.deepStrictEqual([...appJsList].sort(), [...remoteAllowed].sort(),
		"pwa/app.js's hand-copied REMOTE_ALLOWED has drifted from src/remote/policy.ts's real list");
}

console.log('test-pwa-contract: all assertions passed');
