// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Exercises `pwa/transcript.js` against a minimal fake DOM. `transcript.js` reaches
// `document.createElement`/`createTextNode` directly (no injected deps), so this stubs
// `globalThis.document` before importing it. The fake supports exactly the DOM surface the
// renderer is allowed to use — element creation, `textContent`, child insertion/removal, plain
// properties — which is also what keeps the renderer honest: no `innerHTML`, no selectors.
// Structural assertions (tag + text per node), not full DOM semantics.
import assert from 'node:assert/strict';

class FakeNode {
	constructor(tagName) {
		this.tagName = tagName;
		this.className = '';
		this.children = [];
		this.parentNode = null;
		this._text = '';
		this.attributes = {};
	}
	set textContent(v) { this._text = String(v); this.children = []; }
	get textContent() {
		return this.children.length ? this.children.map(c => c.textContent).join('') : this._text;
	}
	get firstChild() { return this.children[0] ?? null; }
	get lastChild() { return this.children[this.children.length - 1] ?? null; }
	appendChild(node) {
		if (node.parentNode) { node.parentNode.removeChild(node); }
		node.parentNode = this;
		this.children.push(node);
		return node;
	}
	insertBefore(node, ref) {
		if (node.parentNode) { node.parentNode.removeChild(node); }
		node.parentNode = this;
		const i = this.children.indexOf(ref);
		this.children.splice(i === -1 ? this.children.length : i, 0, node);
		return node;
	}
	removeChild(node) {
		const i = this.children.indexOf(node);
		if (i !== -1) { this.children.splice(i, 1); }
		node.parentNode = null;
		return node;
	}
	replaceChildren(...nodes) {
		for (const child of this.children) { child.parentNode = null; }
		this.children = [];
		for (const node of nodes) { this.appendChild(node); }
	}
	setAttribute(name, value) { this.attributes[name] = String(value); }
	addEventListener(type, fn) { (this.listeners ??= {})[type] = fn; }
}

class FakeTextNode {
	constructor(text) { this.nodeType = 3; this.textContent = text; this.parentNode = null; }
}

globalThis.document = {
	createElement: tag => new FakeNode(tag),
	createTextNode: text => new FakeTextNode(text),
};

const { render, renderPending, appendEntry, updateToolRow, renderTodos, argHint } = await import('../pwa/transcript.js');

/** A node's children as `{tag, text}` — `undefined` tag for a plain text node. */
function shape(node) {
	return node.children.map(child => ({
		tag: child.nodeType === 3 ? undefined : child.tagName,
		text: child.textContent,
	}));
}

/** The `.msg-body` of the container's `index`th row. */
function bodyOf(container, index = 0) {
	return container.children[index].children.find(c => c.className === 'msg-body');
}

function renderOne(content, extra = {}) {
	const container = new FakeNode('div');
	render(container, { messages: [{ role: 'assistant', content, ...extra }] });
	return container;
}

// ---- 1. Plain text is one paragraph holding one text node ----------------------------------------

{
	const body = bodyOf(renderOne('just plain text, nothing fancy'));
	assert.deepEqual(shape(body), [{ tag: 'p', text: 'just plain text, nothing fancy' }]);
	assert.deepEqual(shape(body.children[0]), [{ tag: undefined, text: 'just plain text, nothing fancy' }]);
}

// ---- 2. Inline bold / italic / code / strikethrough become real elements -------------------------

{
	const p = bodyOf(renderOne('a **bold** word, an *italic* one, ~~gone~~, and `code()` too')).children[0];
	assert.deepEqual(shape(p), [
		{ tag: undefined, text: 'a ' },
		{ tag: 'strong', text: 'bold' },
		{ tag: undefined, text: ' word, an ' },
		{ tag: 'em', text: 'italic' },
		{ tag: undefined, text: ' one, ' },
		{ tag: 'del', text: 'gone' },
		{ tag: undefined, text: ', and ' },
		{ tag: 'code', text: 'code()' },
		{ tag: undefined, text: ' too' },
	]);
}

// ---- 3. Code spans are opaque: nothing inside them is formatted ---------------------------------

{
	const p = bodyOf(renderOne('see `**not bold**` here')).children[0];
	assert.deepEqual(shape(p), [
		{ tag: undefined, text: 'see ' },
		{ tag: 'code', text: '**not bold**' },
		{ tag: undefined, text: ' here' },
	]);
}

// ---- 4. Fenced code: its own block, language shown as a label, content verbatim ------------------

{
	const body = bodyOf(renderOne('before\n```js\nconsole.log(1);\n```\nafter'));
	assert.deepEqual(body.children.map(n => n.tagName), ['p', 'pre', 'p']);
	const pre = body.children[1];
	assert.deepEqual(shape(pre), [{ tag: 'span', text: 'js' }, { tag: 'code', text: 'console.log(1);' }]);
	assert.equal(body.children[2].textContent, 'after');
}

// ---- 5. An unclosed fence mid-stream renders as code from its first line -------------------------

{
	const container = new FakeNode('div');
	render(container, { messages: [], pending: 'Here:\n```py\nprint(1', streaming: true });
	const body = bodyOf(container);
	assert.deepEqual(body.children.map(n => n.tagName), ['p', 'pre']);
	assert.equal(body.children[1].children[1].textContent, 'print(1');
}

// ---- 6. Headings, lists (nested + ordered + tasks), quotes, rules, tables ------------------------

{
	const body = bodyOf(renderOne([
		'## Plan',
		'- one',
		'  - nested',
		'- [x] done task',
		'',
		'3. third',
		'4. fourth',
		'',
		'> quoted **line**',
		'',
		'---',
		'| a | b |',
		'|---|:-:|',
		'| 1 | 2 |',
	].join('\n')));
	assert.deepEqual(body.children.map(n => n.tagName), ['h4', 'ul', 'ol', 'blockquote', 'hr', 'div']);
	const ul = body.children[1];
	assert.equal(ul.children.length, 2, 'two top-level items');
	assert.equal(ul.children[0].children.at(-1).tagName, 'ul', 'the indented item nests under the first');
	assert.equal(ul.children[1].children[0].tagName, 'input', 'a task item gets a checkbox');
	assert.equal(ul.children[1].children[0].checked, true);
	assert.equal(body.children[2].start, 3, 'an ordered list keeps its starting number');
	assert.equal(body.children[3].children[0].children[1].tagName, 'strong', 'quotes render their own markdown');
	const table = body.children[5].children[0];
	assert.deepEqual(table.children.map(r => r.children.map(c => `${c.tagName}:${c.textContent}`)), [['th:a', 'th:b'], ['td:1', 'td:2']]);
}

// ---- 7. Links: http(s) become anchors that open outside the app; anything else stays text -------

{
	const p = bodyOf(renderOne('[docs](https://example.com/x) and [bad](javascript:alert(1)) and https://a.dev/p.')).children[0];
	const anchor = p.children[0];
	assert.equal(anchor.tagName, 'a');
	assert.equal(anchor.href, 'https://example.com/x');
	assert.equal(anchor.rel, 'noopener noreferrer');
	assert.equal(anchor.textContent, 'docs');
	assert.ok(!p.children.some(n => n.tagName === 'a' && String(n.href).startsWith('javascript')), 'a javascript: link never becomes an anchor');
	const bare = p.children.find(n => n.tagName === 'a' && n.href === 'https://a.dev/p');
	assert.ok(bare, 'a bare URL is linked, without its trailing full stop');
}

// ---- 8. No HTML injection surface: literal markup stays inert text --------------------------------

{
	const p = bodyOf(renderOne('<script>alert(1)</script> and **bold**')).children[0];
	assert.equal(p.children[0].nodeType, 3, 'the raw markup is a plain text node, never parsed as an element');
	assert.equal(p.children[0].textContent, '<script>alert(1)</script> and ');
	assert.equal(p.children[1].tagName, 'strong');
}

// ---- 9. Tool calls fold their results into one row per call ---------------------------------------

{
	const container = new FakeNode('div');
	render(container, {
		messages: [
			{ role: 'user', content: 'fix it' },
			{ role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } }] },
			{ role: 'tool', toolCallId: 'c1', content: 'line1\nline2' },
			{ role: 'assistant', content: 'Done.' },
		],
	});
	assert.equal(container.children.length, 3, 'the tool result is folded into its call, not its own row');
	const group = container.children[1].children.find(c => c.className === 'tool-group');
	const row = group.children[0];
	assert.equal(row.className, 'tool tool-done');
	assert.match(row.textContent, /read_file/);
	assert.match(row.textContent, /src\/a\.ts/);
	assert.match(row.textContent, /2 lines/);
	assert.equal(argHint({ command: 'npm   test' }), 'npm test');
}

// ---- 10. Streaming touches one pending row; finished entries land above it ------------------------

{
	const container = new FakeNode('div');
	const session = { messages: [{ role: 'user', content: 'hi' }], streaming: true, pending: '' };
	render(container, session);
	assert.equal(container.lastChild.className, 'working', 'a run with nothing streamed yet shows the working row');

	session.pending = 'Hel';
	renderPending(container, session);
	const pendingRow = container.lastChild;
	assert.equal(pendingRow.className, 'msg msg-assistant msg-pending');
	session.pending = 'Hello';
	renderPending(container, session);
	assert.equal(container.lastChild, pendingRow, 'the same row is updated in place');
	assert.equal(container.children.length, 2, 'nothing else was rebuilt or added');

	const entry = { role: 'tool', live: true, name: 'run_command', args: { command: 'ls' }, status: 'running' };
	const toolEl = appendEntry(container, entry);
	assert.equal(container.lastChild, pendingRow, 'an appended entry goes above the streaming row');
	assert.equal(toolEl.className, 'tool tool-running');
	updateToolRow(toolEl, { ...entry, status: 'error', result: 'boom' });
	assert.equal(toolEl.className, 'tool tool-error');
	assert.equal(toolEl.children[0].open, true, 'a failed call shows its output');

	session.streaming = false;
	renderPending(container, session);
	assert.ok(!container.children.includes(pendingRow), 'an idle session has no pending row');
}

// ---- 11. Todos: the host's { content, status } items ----------------------------------------------

{
	const container = new FakeNode('div');
	renderTodos(container, [
		{ content: 'read', status: 'completed' },
		{ content: 'edit', status: 'in_progress' },
		{ content: 'test', status: 'pending' },
	]);
	assert.equal(container.hidden, false);
	const summary = container.children[0].children[0];
	assert.equal(summary.textContent, '1/3edit', 'progress plus the item in hand');
	renderTodos(container, []);
	assert.equal(container.hidden, true, 'no todos, no strip');
}

// ---- 12. A windowed transcript offers the page before it -----------------------------------------

{
	const container = new FakeNode('div');
	let asked = 0;
	render(container, { messages: [{ role: 'user', content: 'later turn' }], from: 30 }, { onLoadEarlier: () => { asked++; } });
	const more = container.children[0];
	assert.equal(more.className, 'load-earlier');
	more.listeners.click();
	assert.deepEqual([asked, more.disabled], [1, true], 'one request, and the control can’t fire twice');
	const whole = new FakeNode('div');
	render(whole, { messages: [{ role: 'user', content: 'first turn' }], from: 0 }, { onLoadEarlier: () => { } });
	assert.notEqual(whole.children[0].className, 'load-earlier', 'nothing earlier, no control');
}

console.log('test-transcript: all assertions passed');
