/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for media/markdown.js — the renderer every transcript message passes through. Run:
//   node extensions/openvs-chat/scripts/test-markdown.mjs
//
// The module is a plain <script> that assigns `globalThis.OpenVSMarkdown`, so it is loaded
// by evaluating the file rather than importing it. Everything below is string → string:
// no DOM, which is the whole reason the renderer was split out of main.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../media/markdown.js', import.meta.url)), 'utf8');
const sandbox = { globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { render, escapeHtml } = sandbox.OpenVSMarkdown;

// 1. The constructs a model emits every single message. Each of these used to reach the
// transcript as literal punctuation — the table as `|---|---|` rubble, the emphasis as
// asterisks, the quote as a stray `>`.
assert.equal(render('*emphasis* and **strong** and ~~gone~~'),
	'<em>emphasis</em> and <strong>strong</strong> and <del>gone</del><br />');
assert.equal(render('# H1\n###### H6'), '<h1>H1</h1><h6>H6</h6>');
assert.equal(render('> quoted\n> lines'), '<blockquote>quoted<br />lines<br /></blockquote>');
assert.equal(render('a\n\n---\n\nb'), 'a<br /><br /><hr /><br />b<br />');

// 2. Tables, including alignment and a ragged row — a model routinely writes one cell short.
assert.equal(
	render('| Model | Cost |\n|:---|---:|\n| a | 1 |\n| b |'),
	'<table><thead><tr><th style="text-align:left">Model</th><th style="text-align:right">Cost</th></tr></thead>'
	+ '<tbody><tr><td style="text-align:left">a</td><td style="text-align:right">1</td></tr>'
	+ '<tr><td style="text-align:left">b</td><td style="text-align:right"></td></tr></tbody></table>');

// 3. Nested lists keep their nesting, an ordered list keeps the number it started at, and a
// checklist renders as checkboxes. Flattening these lost the structure of every plan the
// assistant produced.
assert.equal(render('- one\n  - deep\n- two'),
	'<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>');
assert.equal(render('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
assert.equal(render('- [x] done\n- [ ] todo'),
	'<ul><li class="task"><input type="checkbox" disabled checked />done</li>'
	+ '<li class="task"><input type="checkbox" disabled />todo</li></ul>');

// 4. Code is literal. Markdown inside a code span is text, not markup — the bug this
// module's token table exists to prevent — and a fenced block keeps its language.
assert.equal(render('`**not bold**` and `a_b_c`'),
	'<code>**not bold**</code> and <code>a_b_c</code><br />');
assert.equal(render('```ts\nconst a = 1;\n```'),
	'<pre><code class="language-ts" data-language="ts">const a = 1;</code></pre>');
// An unterminated fence is the normal state of a streaming answer.
assert.equal(render('```\nhalf'), '<pre><code>half</code></pre>');

// 5. Identifiers must survive. snake_case and a*b are not emphasis, and mangling them in a
// coding assistant's transcript is worse than not supporting emphasis at all.
assert.equal(render('call some_long_name(x) with a*b'), 'call some_long_name(x) with a*b<br />');

// 6. Links: explicit, bare, and hostile. `javascript:` must never reach an href, and an
// image is rendered as a link rather than a fetch the transcript performs on its own —
// a model can write a URL, and an <img> would make that an exfiltration channel.
assert.equal(render('[docs](https://example.com/a)'), '<a href="https://example.com/a">docs</a><br />');
assert.equal(render('see https://example.com/x, ok'),
	'see <a href="https://example.com/x">https://example.com/x</a>, ok<br />');
assert.equal(render('[x](javascript:alert(1))'), '[x](javascript:alert(1))<br />');
assert.match(render('![shot](https://example.com/a.png)'), /^<a href="https:\/\/example\.com\/a\.png">🖼 shot<\/a>/);

// 7. Model text is escaped exactly once, wherever it lands — prose, a table cell, a code
// block, a link label.
assert.equal(render('<img src=x onerror=alert(1)>'),
	'&lt;img src=x onerror=alert(1)&gt;<br />');
assert.equal(render('| a |\n|---|\n| <b>x</b> |'),
	'<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>&lt;b&gt;x&lt;/b&gt;</td></tr></tbody></table>');
assert.equal(escapeHtml(`<&"'>`), '&lt;&amp;&quot;&#39;&gt;');

// 8. Reasoning blocks still collapse, and the fences inside one do not pair with the
// answer's — the reason the thinking split runs before the code-fence pass at all.
{
	const html = render('🤔 *Thinking…*\n\n```js\nx\n```\n[thought for 3s]\n\n---\n\nAnswer');
	assert.match(html, /<details class="thinking" data-think="0">/);
	assert.match(html, /Thought for 3s/);
	assert.match(html, /<\/details>Answer<br \/>$/);
}

console.log('PASS test-markdown.mjs');
