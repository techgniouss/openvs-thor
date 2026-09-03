/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the pure parsing pieces of
// src/providers/webCookie/geminiWebProvider.ts: the batchexecute frame extractor and the app
// shell's session-token scraper. No network, no real session. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-gemini-web.mjs
import assert from 'node:assert/strict';
import Module from 'node:module';

// geminiWebProvider.ts reads a vscode setting (openvsChat.webGemini.enabled) at call time,
// which the pure functions under test here never reach — stubbed only so the module loads.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
	}
	return originalLoad(request, parent, isMain);
};

const m = await import(new URL('../out/providers/webCookie/geminiWebProvider.js', import.meta.url));

/** Builds one batchexecute frame line carrying `answer` as the assistant's text. */
function frameLine(answer) {
	const inner = [null, null, null, null, [[null, [answer]]]];
	const part = ['wrb.fr', null, JSON.stringify(inner)];
	return JSON.stringify([part]);
}

// A single frame with a body.
{
	const text = `)]}'\n\n${frameLine('Hello world')}\n`;
	assert.equal(m.extractGeminiText(text), 'Hello world');
}

// Frames are cumulative snapshots: the LAST frame carrying a body wins, earlier ones are
// discarded rather than concatenated (concatenating would duplicate the answer).
{
	const text = [
		")]}'",
		'',
		frameLine('Hel'),
		frameLine('Hello world, the complete answer'),
	].join('\n');
	assert.equal(m.extractGeminiText(text), 'Hello world, the complete answer');
}

// A frame whose inner[4] is falsy (still generating) is skipped in favor of the next real one.
{
	const emptyInner = JSON.stringify([null, null, null, null, null]);
	const emptyFrame = JSON.stringify([['wrb.fr', null, emptyInner]]);
	const text = [")]}'", '', emptyFrame, frameLine('final answer')].join('\n');
	assert.equal(m.extractGeminiText(text), 'final answer');
}

// No parseable frame at all, or a body that is not batchexecute format, returns '' rather
// than throwing.
assert.equal(m.extractGeminiText(''), '');
assert.equal(m.extractGeminiText(")]}'\nnot json at all"), '');
assert.equal(m.extractGeminiText('{"just": "a plain json object, not a frame line"}'), '');

// ── parseSessionTokens ──────────────────────────────────────────────────────────────────────

{
	const html = '<script>window.WIZ_global_data = {"SNlM0e":"abc123==","cfb2h":"boq_assistant-bard-web-server_20260101.09_p0"};</script>';
	assert.deepStrictEqual(m.parseSessionTokens(html), { at: 'abc123==', bl: 'boq_assistant-bard-web-server_20260101.09_p0' });
}

// Falls back to scraping a bare build-id-looking string when cfb2h itself is absent. The
// fallback regex is intentionally greedy over `[\w.]+` (ported as-is), so a trailing `.js`
// on a script-tag URL is captured too rather than trimmed — a wrong build id 400s and is
// re-scraped, so over-capturing here is the safe direction to be wrong in, not silent.
{
	const html = '<script>"SNlM0e":"tok-only"</script><script src="/_/BardChatUi/js/boq_assistant-bard-web-server_20260215.11_p1.js"></script>';
	assert.deepStrictEqual(m.parseSessionTokens(html), { at: 'tok-only', bl: 'boq_assistant-bard-web-server_20260215.11_p1.js' });
}

// No SNlM0e at all means the session isn't signed in — a clear, specific error, not a
// generic parse failure.
assert.throws(() => m.parseSessionTokens('<html>accounts.google.com sign-in redirect</html>'), /not signed in/);

// SNlM0e present but no build id anywhere — a different, equally specific error.
assert.throws(() => m.parseSessionTokens('"SNlM0e":"tok"'), /build id/);

console.log('All gemini-web assertions passed.');
