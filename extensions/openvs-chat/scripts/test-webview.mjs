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
const host = fs.readFileSync(url('../src/chatViewProvider.ts'), 'utf8');
const { CHAT_APP_HTML } = await import(url('../out/webviewHtml.js'));

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

/** Message `type` values the host sends to the webview, from its `post({ type: … })` calls. */
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
	assert.match(main, /prompts\.cancel\(msg\.id\)/, 'cancellation reaches the card');
	assert.match(main, /function renderOpenPrompts\(\)[\s\S]{0,120}prompts\.reattach/,
		'open cards are re-attached after a transcript rebuild');
	assert.ok(main.includes('renderOpenPrompts()'), 'and renderAll actually calls it');
}

// 6b. Both webview scripts are served, in the order prompts.js must load first.
{
	const promptsAt = host.search(/mediaUri\('prompts\.js'\)/);
	const mainAt = host.search(/mediaUri\('main\.js'\)/);
	assert.ok(promptsAt > 0, 'prompts.js is served');
	assert.ok(mainAt > promptsAt, 'prompts.js loads before main.js, which calls it at startup');
}

// 7. The host must settle waiting prompts when the webview goes away, in both directions:
// a reload (`ready`) and a disposal. Either leak parks a run on an unanswerable question.
{
	assert.match(host, /case 'ready':[\s\S]{0,400}this\.flushPrompts\(\)/, 'a reloaded webview settles its prompts');
	assert.match(host, /onDidDispose\(\(\) => \{[\s\S]{0,600}this\.flushPrompts\(\)/, 'a disposed view settles its prompts');
	assert.match(host, /this\.view = undefined/, 'the disposed view handle is dropped');
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

console.log('test-webview: all assertions passed');
