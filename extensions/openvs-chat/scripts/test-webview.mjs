/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Contract tests between the extension host (src/chatViewProvider.ts) and the webview
// (media/main.js). Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-webview.mjs
//
// The webview is a plain <script> with no module boundary, so it cannot be imported and
// there is no DOM here to render it into. What CAN be checked without either — and what
// actually breaks in practice — is whether the two halves still agree:
//
//   * every element id main.js looks up exists in the markup the host serves,
//   * every message the host posts is handled by the webview's switch,
//   * every message the webview posts is handled by the host's switch,
//   * the blocking prompt round-trip names the same fields on both sides.
//
// A mismatch in any of these is silent at build time and shows up at runtime as a null
// dereference or, worse, an agent run that waits forever for a reply nobody will send.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = p => new URL(p, import.meta.url);
const main = fs.readFileSync(url('../media/main.js'), 'utf8');
const promptsJs = fs.readFileSync(url('../media/prompts.js'), 'utf8');
// The host's message dispatcher is expected to move out of chatViewProvider.ts over time,
// into src/session/ and src/remote/. hostSends and hostHandles below are the whole contract
// check between the two sides — a handler that moved to a new file without joining this
// read would silently weaken hostSends (fewer messages the webview is required to handle)
// and hard-fail hostHandles (a real case regex-invisible to this file, reported as "the
// webview posts this but the host ignores it"). So this reads a *set* of files, not one.
const host = readSourceSet(['../src/chatViewProvider.ts'], ['../src/session', '../src/remote']);
const { CHAT_APP_HTML } = await import(url('../out/webviewHtml.js'));

/**
 * Concatenates `fixed` files with every `.ts` file directly under each of `dirs`, joined by
 * `'\n'`. Directories that do not exist yet (a later phase has not created them) are skipped
 * rather than throwing.
 */
function readSourceSet(fixed, dirs) {
	const parts = fixed.map(p => fs.readFileSync(url(p), 'utf8'));
	for (const dir of dirs) {
		const dirUrl = url(dir + '/');
		if (!fs.existsSync(dirUrl)) {
			continue;
		}
		for (const entry of fs.readdirSync(dirUrl).sort()) {
			if (entry.endsWith('.ts')) {
				parts.push(fs.readFileSync(new URL(entry, dirUrl), 'utf8'));
			}
		}
	}
	return parts.join('\n');
}

/** All matches of `re`'s first capture group, deduped. */
function captures(text, re) {
	return [...new Set([...text.matchAll(re)].map(m => m[1]))];
}

// 1. Every element the webview resolves by id must exist in the served markup. main.js
// caches these in `els` at load; a missing one is `null` and blows up much later.
{
	const ids = captures(main, /\$\('([A-Za-z0-9_-]+)'\)/g);
	assert.ok(ids.length > 15, `expected the els table to be found, got ${ids.length} ids`);
	const missing = ids.filter(id => !CHAT_APP_HTML.includes(`id="${id}"`));
	assert.deepStrictEqual(missing, [], 'these ids are looked up but not present in the markup');
}

// 1b. …and ids the webview creates at runtime are deliberately absent from the markup,
// so the check above stays meaningful rather than vacuously passing.
{
	assert.ok(!CHAT_APP_HTML.includes('id="todoPanel"'), 'todoPanel is created on demand');
	assert.ok(CHAT_APP_HTML.includes('id="messages"'), 'the transcript container is served');
}

// 1c. Bootstrap globals are the other half of the host↔webview contract: the host writes
// them into an inline script, the webview reads them at load. Neither side fails loudly
// when the other drops out — a missing `__OPENVS_HERO_URI__` just silently returns the
// empty chat to the drawn orb, and a missing media file is a broken image with no error.
{
	const globals = captures(main, /window\)?\.(__OPENVS_[A-Z_]+__)/g);
	assert.ok(globals.length > 0, 'expected the webview to read at least one bootstrap global');
	const unset = globals.filter(g => !host.includes(`window.${g} =`));
	assert.deepStrictEqual(unset, [], 'the webview reads these globals but the host never sets them');

	const assets = captures(host, /mediaUri\('([^']+)'\)/g);
	const missing = assets.filter(f => !fs.existsSync(url(`../media/${f}`)));
	assert.deepStrictEqual(missing, [], 'the host serves these media files but they do not exist');
}

/**
 * Message `type` values the host sends to the webview, from its `post({ type: … })` calls.
 * The regex only matches that literal shape — `post({ type: 'x', … })` written out, not a
 * variable or a spread — so any host file in the scanned set (see `readSourceSet` above)
 * must keep sending messages that way for this extraction to see them.
 */
const hostSends = new Set([
	...captures(host, /post\(\{\s*type:\s*'([a-zA-Z]+)'/g),
	// Blocking prompts go out through promptUser rather than post, but they are still
	// messages the webview has to recognize.
	...captures(host, /promptUser\(\{\s*type:\s*'([a-zA-Z]+)'/g),
]);
/** Message `type` values the webview's dispatcher handles. */
const webviewHandles = new Set(captures(main, /^\s*case '([a-zA-Z]+)':/gm));
/**
 * Message `type` values the webview sends. Drawn from both of its scripts: main.js posts
 * through `vscode.postMessage`, prompts.js through the `post` callback it is handed.
 */
const webviewSends = new Set([
	...captures(main, /vscode\.postMessage\(\{\s*type:\s*'([a-zA-Z]+)'/g),
	...captures(promptsJs, /deps\.post\(\{\s*type:\s*'([a-zA-Z]+)'/g),
]);
/** Message `type` values the host's dispatcher handles. */
const hostHandles = new Set(captures(host, /^\s*case '([a-zA-Z]+)':/gm));

// 2. Nothing the host posts may go unhandled: a dropped message is a feature that
// silently does nothing.
{
	const unhandled = [...hostSends].filter(t => !webviewHandles.has(t));
	assert.deepStrictEqual(unhandled, [], 'the host posts these but the webview ignores them');
	// Sanity: the extraction found the real traffic, not an empty set.
	for (const expected of ['token', 'done', 'toolStart', 'toolEnd', 'approvalRequest', 'askRequest', 'promptCancel']) {
		assert.ok(hostSends.has(expected), `expected the host to post "${expected}"`);
	}
}

// 3. …and nothing the webview posts may go unhandled either. `promptResponse` is the one
// that matters most: unhandled, every approval and question would hang its run forever.
{
	const unhandled = [...webviewSends].filter(t => !hostHandles.has(t));
	assert.deepStrictEqual(unhandled, [], 'the webview posts these but the host ignores them');
	assert.ok(webviewSends.has('promptResponse'), 'the webview can answer a prompt');
	assert.ok(hostHandles.has('promptResponse'), 'the host listens for prompt answers');
}

// 4. Chat-stream messages are filtered out of the detached Settings tab, which shares no
// live conversation. A prompt card rendered there would be unanswerable.
{
	const list = /const CHAT_ONLY_MESSAGES = \[([\s\S]*?)\];/.exec(main);
	assert.ok(list, 'CHAT_ONLY_MESSAGES is still declared');
	for (const type of ['approvalRequest', 'askRequest', 'promptCancel', 'token', 'done']) {
		assert.ok(list[1].includes(`'${type}'`), `${type} must not reach the Settings tab`);
	}
	// 'remote' must NOT be in this list: unlike sessions/transcript/commands, connection
	// status/pairing/device/error payloads are not chat-scoped — they are the desktop's one
	// global remote-control state, and the "Remote control" section lives inside the Settings
	// panel itself. Filtering it out here silently blinded the detached Settings tab (which is
	// what the gear icon always opens — see `requestOpenSettings`/`openSettingsWindow`) to
	// every status update, pairing reply and error `media/pairing.js` ever needed to show,
	// leaving the status dot stuck at "off" regardless of the real connection state.
	assert.ok(!list[1].includes(`'remote'`), 'remote status/pairing/device updates must reach the Settings tab — it is where the Remote control panel lives');
}

// 5. The prompt round-trip has to name the same fields on both sides. These are read out
// of untyped `Record<string, unknown>` on the host, so nothing else would catch a rename.
{
	// Host → webview: the approval card's inputs. Read in prompts.js (see 5b), so here
	// we only confirm the host still sends each one.
	for (const field of ['title', 'detail', 'preview', 'previewLanguage']) {
		assert.ok(host.includes(`${field}:`), `the host sends "${field}"`);
	}
	// Webview → host: the answer. Sent from prompts.js, read by the host.
	for (const field of ['approved', 'always', 'feedback']) {
		assert.ok(promptsJs.includes(field), `the webview sends "${field}"`);
		assert.ok(host.includes(`reply.${field}`), `the host reads "${field}"`);
	}
	assert.ok(promptsJs.includes('answer'), 'the webview sends an answer for ask_user');
	assert.ok(host.includes('reply.answer'), 'the host reads the ask_user answer');
	assert.ok(promptsJs.includes('promptId'), 'the webview correlates its reply');
	assert.ok(host.includes('message.promptId'), 'the host correlates the reply');
}

// 5a. The Auto run's closing "models used" line is the only place the *actual* model of
// each phase survives: the per-phase headers scroll away, and after a runtime fallback they
// name a model that did not answer. Its payload is untyped on both sides, so a renamed
// field would silently render a row of blanks instead of failing.
{
	assert.ok(host.includes("type: 'autoSummary'"), 'the host posts the closing summary');
	assert.match(main, /case 'autoSummary':[\s\S]{0,900}appendAutoSummary\(msg\.phases\)/,
		'the webview draws it from msg.phases');
	// Recorded in the transcript, not just drawn: a run that ends in a background tab draws
	// nothing, and the next renderAll discards a node that was only appended.
	assert.match(main, /case 'autoSummary':[\s\S]{0,900}s\.messages\.push\(\{[^}]*kind: 'auto'/,
		'the summary is kept in the session transcript');
	assert.match(main, /m\.kind === 'auto'[\s\S]{0,120}appendAutoSummary\(m\.phases\)/,
		'and re-rendered from it');
	// `kind` is what keeps notices out of the history sent to the model; the summary is one.
	// This used to be `main.js`'s own `sendableMessages` — Phase 2's ownership flip moved it
	// to the host's `SessionStore` (the webview no longer assembles what to send at all, see
	// assertion 9b), so the filter is checked there now instead.
	assert.match(host, /sendableMessages\(sessionId: string\)[\s\S]{0,300}filter\(m => !m\.kind/,
		'entries carrying a kind are never sent back as conversation');
	for (const field of ['label', 'provider', 'model', 'source']) {
		assert.ok(main.includes(`phase.${field}`), `the summary row renders "${field}"`);
	}
	// Summaries are chat traffic: rendered into the detached Settings tab they would attach
	// to a session that tab does not have.
	assert.ok(/const CHAT_ONLY_MESSAGES = \[[\s\S]*?'autoSummary'[\s\S]*?\];/.test(main),
		'autoSummary must not reach the Settings tab');
}

// 5c. Switching a role's provider must not keep the previous provider's model in the box.
// It did, and the pair was persisted verbatim: choosing NVIDIA fills in
// `meta/llama-3.3-70b-instruct`, switching to Anthropic then pinned
// `anthropic:meta/llama-3.3-70b-instruct` — a pair that cannot exist, 404s on the first
// request of every Auto run, and (being pinned) is never substituted.
{
	const handler = /provSel\.addEventListener\('change'[\s\S]*?\n\t\t\t\}\);/.exec(main);
	assert.ok(handler, 'the role-provider change handler is still there');
	assert.match(handler[0], /offered\.includes\(modelInput\.value\.trim\(\)\)/,
		'a model the new provider does not offer is replaced, not carried over');
	assert.match(handler[0], /provider: '', model: ''/,
		'and a provider with nothing to offer clears the pin instead of leaving the old pair');
}

// 5b. The card module reads exactly the request fields the host sends. Behaviour is
// covered by test-prompt-cards.mjs; what that test can't see is the host's half.
{
	for (const field of ['title', 'detail', 'preview', 'previewLanguage', 'question', 'options', 'multiSelect']) {
		assert.ok(promptsJs.includes(`request.${field}`), `prompts.js reads "${field}"`);
	}
}

// 6. main.js must route every prompt message into the card module, and re-attach open
// cards after a transcript rebuild — a card lost on a tab switch blocks its run forever.
{
	assert.match(main, /prompts\.render\(msg\)/, 'visible prompts are drawn');
	assert.match(main, /prompts\.track\(msg\)/, 'background-tab prompts are remembered');
	assert.match(main, /prompts\.cancel\(msg\.id, msg\.reason\)/,
		'cancellation reaches the card, along with why (e.g. answered on another sink first)');
	assert.match(main, /function renderOpenPrompts\(\)[\s\S]{0,120}prompts\.reattach/,
		'open cards are re-attached after a transcript rebuild');
	assert.ok(main.includes('renderOpenPrompts()'), 'and renderAll actually calls it');
}

// 6b. All four webview scripts are served, in dependency order: qr.js (no deps) before
// pairing.js (uses OpenVSQr), pairing.js before prompts.js (no dependency between the two,
// but this pins them anyway so a reorder is a deliberate edit, not an accident), prompts.js
// before main.js, which calls both `OpenVSPrompts.create` and `OpenVSPairing.create` at startup.
{
	const positions = ['qr.js', 'pairing.js', 'prompts.js', 'main.js'].map(file => {
		const at = host.search(new RegExp(`mediaUri\\('${file.replace('.', '\\.')}'\\)`));
		assert.ok(at > 0, `${file} is served`);
		return at;
	});
	for (let i = 1; i < positions.length; i++) {
		assert.ok(positions[i] > positions[i - 1],
			`scripts are served in the right order: …${['qr.js', 'pairing.js', 'prompts.js', 'main.js'][i - 1]} before ${['qr.js', 'pairing.js', 'prompts.js', 'main.js'][i]}`);
	}
}

// 7. The host must never strand a run on an unanswerable question, across the sink
// lifecycle: a reload (`ready`) rebinds the card to whichever sink reconnected rather than
// flushing it, a disposal that leaves no chat-capable sink arms an escalation instead of
// settling immediately, and only extension deactivate ever settles everything unconditionally
// (Phase 3's "remote control" prompt arbitration — see PromptRegistry.settleAllUnanswered's
// doc for why `ready` must not do this anymore).
{
	assert.match(host, /case 'ready':[\s\S]{0,400}rebindPrompts\(/, 'a reloaded/reconnected sink has its prompts rebound');
	assert.ok(!/case 'ready':[\s\S]{0,400}this\.(flushPrompts|promptRegistry\.settleAllUnanswered)\(\)/.test(host),
		'ready no longer flushes/settles prompts unconditionally');
	assert.match(host, /onDidDispose\(\(\) => \{[\s\S]{0,800}armEscalations\(\)/,
		'losing a sink arms an escalation instead of settling immediately');
	assert.ok(!/onDidDispose\(\(\) => \{[\s\S]{0,800}this\.(flushPrompts|promptRegistry\.settleAllUnanswered)\(\)/.test(host),
		'disposal no longer flushes/settles prompts unconditionally');
	assert.match(host, /this\.view = undefined/, 'the disposed view handle is dropped');
	// Only the extension's own deactivate — never a reload, never a disposed sink — is allowed
	// to settle every prompt unconditionally.
	const extensionSrc = fs.readFileSync(url('../src/extension.ts'), 'utf8');
	assert.match(extensionSrc, /function deactivate\(\)[\s\S]{0,400}\.dispose\(\)/,
		'extension deactivate disposes the chat view provider');
	assert.match(host, /dispose\(\): void \{[\s\S]{0,300}promptRegistry\.settleAllUnanswered\(\)/,
		'and that is what finally settles every unanswered prompt');
}

// 8. Tool names the webview labels must be tools the agent can actually call, or the
// transcript falls back to a raw JSON signature for a first-party tool.
{
	const tools = fs.readFileSync(url('../src/agent/tools.ts'), 'utf8');
	const todos = fs.readFileSync(url('../src/persona/todos.ts'), 'utf8');
	const declared = new Set([
		...captures(tools, /^\t*name: '([a-z_]+)',$/gm),
		...captures(todos, /^\t*name: '([a-z_]+)',$/gm),
	]);
	const labelled = captures(main, /^\s*case '([a-z_]+)': return /gm);
	assert.ok(labelled.includes('ask_user'), 'the question tool is labelled in the transcript');
	const unknown = labelled.filter(t => !declared.has(t));
	assert.deepStrictEqual(unknown, [], 'the webview labels tools that no longer exist');
}

// 9. Every message that belongs to a specific RUN must carry `runId`, and the host must
// fence on it. A chat tab outlives its runs: `send` supersedes the previous run in that
// tab, and a message posted as one run ends arrives after the next has started. `steer`
// was the one run-scoped message without the stamp, so a correction typed at the wrong
// moment was delivered to whichever run happened to be live — the user watched their
// instruction be applied to a different task.
{
	const runScoped = ['send', 'steer'];
	for (const type of runScoped) {
		const post = new RegExp(`vscode\\.postMessage\\(\\{[^}]*type: '${type}'[\\s\\S]{0,400}?\\}\\)`).exec(main);
		assert.ok(post, `the webview still posts "${type}"`);
		assert.match(post[0], /runId/, `"${type}" must carry the run it belongs to`);
	}
	// The host has to actually use it, not just accept it: steering is drained per run.
	assert.match(host, /drainSteering\(sessionId, runId\)/, 'steering is drained for the current run only');
	assert.match(host, /entry\.runId === runId/, 'a steer left behind by an ended run is discarded');
}

// 9b. The load-bearing statement that the Phase 2 ownership flip is complete: `send`'s payload
// no longer includes `messages` — the host computes history from its own `SessionStore` now
// (falling back to whatever the webview sends only while it isn't yet tracking a session, see
// `chatViewProvider.ts`'s `handleSend`), so the webview has nothing left to assemble.
{
	const post = /vscode\.postMessage\(\{[^}]*type: 'send'[\s\S]{0,400}?\}\)/.exec(main);
	assert.ok(post, 'the webview still posts "send"');
	assert.ok(!/messages:/.test(post[0]), '"send" must not carry a client-assembled message history');
}

// 10. Streaming repaints must stay coalesced. Painting per token re-renders the whole
// accumulated answer through markdown and innerHTML on every delta — O(n²) over a
// response, which froze the panel on long answers and on reasoning models that stream
// thousands of tokens. The accumulate/paint split is easy to undo by accident, so pin it.
{
	const tokenCase = /case 'token': \{[\s\S]{0,500}?\n\t\t\t\}/.exec(main);
	assert.ok(tokenCase, 'the token handler is still there');
	assert.match(tokenCase[0], /s\.pending \+= msg\.delta/, 'every token still accumulates');
	assert.match(tokenCase[0], /scheduleStreamRender\(s\)/, 'painting is deferred to a frame');
	assert.ok(!/setBodyMarkdown/.test(tokenCase[0]), 'a token must not repaint synchronously');
	// …and every path that reads or replaces the bubble must settle the queued frame first,
	// or the last tokens before a boundary are on `pending` but never on screen.
	assert.match(main, /function commitPending\(s\) \{[\s\S]{0,400}?flushStreamRender\(\)/,
		'committing a turn flushes the queued frame');
	assert.match(main, /function openStream\(s\) \{[\s\S]{0,300}?flushStreamRender\(\)/,
		'opening a new bubble flushes the queued frame');
	assert.match(main, /function renderAll\(\) \{[\s\S]{0,300}?cancelStreamRender\(\)/,
		'a full rebuild drops the queued frame instead of painting doomed DOM');
}

console.log('test-webview: all assertions passed');
