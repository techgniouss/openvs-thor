// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Exercises `pwa/transcript.js`'s markdown-lite renderer (renderInline/renderBody, reached via
// `render`) against a minimal fake DOM — `transcript.js` reaches `document.createElement`/
// `createTextNode` directly (no injected deps, unlike `session/store.ts`'s `SessionDeps`
// pattern), so this stubs `globalThis.document` before importing it, the same approach
// `test-pairing-card.mjs`'s sibling package uses for `media/pairing.js`. Structural assertions
// only (tag + text per node), not full DOM semantics — this file is plain `createElement`/
// `textContent`/`appendChild`, so a fake that supports exactly those three calls is enough.
import assert from 'node:assert/strict';

class FakeNode {
	constructor(tagName) {
		this.tagName = tagName;
		this.className = '';
		this.children = [];
		this._text = '';
	}
	set textContent(v) { this._text = String(v); this.children = []; }
	get textContent() {
		return this.children.length ? this.children.map(c => c.textContent).join('') : this._text;
	}
	appendChild(node) { this.children.push(node); return node; }
	replaceChildren() { this.children = []; }
}

class FakeTextNode {
	constructor(text) { this.nodeType = 3; this.textContent = text; }
}

globalThis.document = {
	createElement: tag => new FakeNode(tag),
	createTextNode: text => new FakeTextNode(text),
};

const { render } = await import('../pwa/transcript.js');

/** The `msg-body` div's rendered children, as `{tag, text}` — `undefined` tag for a plain text node, matching how a reader would describe what's actually on screen. */
function shape(container) {
	return container.children.map(node => ({
		tag: node.nodeType === 3 ? undefined : node.tagName,
		text: node.textContent,
	}));
}

function bodyOf(container) {
	// row.children = [roleDiv, bodyDiv]
	const row = container.children[0];
	return row.children[1];
}

// ---- 1. Plain text: no formatting markers, renders as a single text node -----------------------

{
	const container = new FakeNode('div');
	render(container, { messages: [{ role: 'assistant', content: 'just plain text, nothing fancy' }] });
	assert.deepEqual(shape(bodyOf(container)), [{ tag: undefined, text: 'just plain text, nothing fancy' }]);
}

// ---- 2. Inline bold / italic / code, each becomes a real element with clean text ----------------

{
	const container = new FakeNode('div');
	render(container, { messages: [{ role: 'assistant', content: 'a **bold** word, an *italic* one, and `code()` too' }] });
	assert.deepEqual(shape(bodyOf(container)), [
		{ tag: undefined, text: 'a ' },
		{ tag: 'strong', text: 'bold' },
		{ tag: undefined, text: ' word, an ' },
		{ tag: 'em', text: 'italic' },
		{ tag: undefined, text: ' one, and ' },
		{ tag: 'code', text: 'code()' },
		{ tag: undefined, text: ' too' },
	]);
}

// ---- 3. Fenced code block: language line stripped, content becomes a <pre><code> ----------------

{
	const container = new FakeNode('div');
	render(container, { messages: [{ role: 'assistant', content: 'before\n```js\nconsole.log(1);\n```\nafter' }] });
	const nodes = bodyOf(container).children;
	assert.equal(nodes[0].textContent, 'before\n');
	assert.equal(nodes[1].tagName, 'pre');
	assert.equal(nodes[1].children[0].tagName, 'code');
	assert.equal(nodes[1].children[0].textContent, 'console.log(1);', 'the js language line is stripped, only the code remains');
	assert.equal(nodes[2].textContent, '\nafter');
}

// ---- 4. A fence with no recognizable language line on its first line is kept verbatim -----------

{
	const container = new FakeNode('div');
	render(container, { messages: [{ role: 'assistant', content: '```\nplain fenced text\n```' }] });
	const pre = bodyOf(container).children[0];
	assert.equal(pre.tagName, 'pre');
	assert.equal(pre.children[0].textContent, 'plain fenced text');
}

// ---- 5. An unterminated fence (still streaming) does not throw and renders as prose --------------

{
	const container = new FakeNode('div');
	assert.doesNotThrow(() => render(container, {
		messages: [], pending: 'still writing ```js\nconsole.log(', streaming: true,
	}));
	const body = bodyOf(container);
	assert.equal(body.textContent, 'still writing ```js\nconsole.log(', 'no fence match yet, so it falls through to plain prose untouched');
}

// ---- 6. No HTML injection surface: a literal `<script>` in model output stays inert text ---------

{
	const container = new FakeNode('div');
	render(container, { messages: [{ role: 'assistant', content: '<script>alert(1)</script> and **bold**' }] });
	const nodes = bodyOf(container).children;
	assert.equal(nodes[0].tagName, undefined, 'the raw markup is a plain text node, never parsed as an element');
	assert.equal(nodes[0].textContent, '<script>alert(1)</script> and ');
	assert.equal(nodes[1].tagName, 'strong');
}

console.log('test-transcript: all assertions passed');
