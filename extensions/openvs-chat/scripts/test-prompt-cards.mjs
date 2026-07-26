/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Behavioural tests for the approval/question cards in media/prompts.js. Run:
//   node extensions/openvs-chat/scripts/test-prompt-cards.mjs
//
// This runs the real card code — not a reimplementation — against a small DOM stand-in.
// prompts.js is deliberately written with createElement/textContent and direct child
// references (no innerHTML, no querySelector), so the stand-in below needs no HTML parser
// and no selector engine to be faithful. What it exercises is the part that actually
// strands an agent run when it breaks: which reply each button produces, and whether the
// card stops accepting input once answered.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// ---- Minimal DOM ---------------------------------------------------------------

/** A node supporting exactly the surface prompts.js touches. */
class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this.value = '';
		this._text = '';
		const classes = new Set();
		this.classList = {
			add: (...names) => names.forEach(n => classes.add(n)),
			remove: (...names) => names.forEach(n => classes.delete(n)),
			contains: name => classes.has(name),
			toggle: (name, force) => {
				const on = force === undefined ? !classes.has(name) : !!force;
				if (on) { classes.add(name); } else { classes.delete(name); }
				return on;
			},
			_all: classes,
		};
	}
	set className(value) {
		this.classList._all.clear();
		for (const name of String(value).split(/\s+/).filter(Boolean)) { this.classList._all.add(name); }
	}
	get className() { return [...this.classList._all].join(' '); }
	set textContent(value) {
		this.children = [];
		this._text = String(value);
	}
	get textContent() {
		return this.children.length ? this.children.map(c => c.textContent).join('') : this._text;
	}
	appendChild(node) { this.children.push(node); return node; }
	setAttribute(name, value) { this.attributes[name] = String(value); }
	getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
	addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
	/** Test driver: fire an event on this node. */
	fire(type, event = {}) { for (const h of this.listeners[type] || []) { h(event); } }
	/** Test driver: depth-first search by class name. */
	find(className) {
		if (this.classList.contains(className)) { return this; }
		for (const child of this.children) {
			const hit = child.find(className);
			if (hit) { return hit; }
		}
		return undefined;
	}
	/** Test driver: every descendant with a class name, in document order. */
	findAll(className) {
		const out = this.classList.contains(className) ? [this] : [];
		for (const child of this.children) { out.push(...child.findAll(className)); }
		return out;
	}
}

/** Loads media/prompts.js into a sandbox with the stand-in DOM and returns its namespace. */
function loadPrompts() {
	const source = fs.readFileSync(new URL('../media/prompts.js', import.meta.url), 'utf8');
	const sandbox = { document: { createElement: tag => new El(tag) } };
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'prompts.js' });
	assert.ok(sandbox.OpenVSPrompts, 'prompts.js published its namespace');
	return sandbox.OpenVSPrompts;
}

const OpenVSPrompts = loadPrompts();

/**
 * A controller plus the container and the messages it posted.
 *
 * Payloads are round-tripped through JSON on the way in. prompts.js runs in its own vm
 * realm, so the objects it builds have that realm's `Object.prototype` and would fail
 * `deepStrictEqual` against literals written here despite being identical in content.
 * The real `postMessage` structured-clones them anyway, so this matches production.
 */
function harness() {
	const container = new El('main');
	const posted = [];
	const api = OpenVSPrompts.create({ container, post: m => posted.push(JSON.parse(JSON.stringify(m))) });
	return { container, posted, api, card: () => container.children[container.children.length - 1] };
}

const approvalRequest = {
	id: 'p1', type: 'approvalRequest', sessionId: 's1',
	title: 'Overwrite src/foo.ts?', detail: '40 line(s) → 12 line(s).',
	preview: '@@ line 3 @@\n-old\n+new', previewLanguage: 'diff',
};
const askRequest = {
	id: 'q1', type: 'askRequest', sessionId: 's1',
	question: 'Patch the parser or rewrite it?',
	options: [{ label: 'Patch it', description: 'Smaller diff' }, { label: 'Rewrite it' }],
};

// 1. An approval card shows what will happen, including the diff — approving without
// seeing the change is how a truncated response destroys a file unnoticed.
{
	const h = harness();
	h.api.render(approvalRequest);
	const card = h.card();
	assert.strictEqual(card.getAttribute('data-prompt-id'), 'p1');
	assert.ok(card.classList.contains('prompt-open'));
	assert.strictEqual(card.find('prompt-title').textContent, 'Overwrite src/foo.ts?');
	assert.strictEqual(card.find('prompt-detail').textContent, '40 line(s) → 12 line(s).');
	assert.strictEqual(card.find('prompt-preview').textContent, '@@ line 3 @@\n-old\n+new');
	assert.deepStrictEqual(card.findAll('prompt-btn').map(b => b.getAttribute('data-act')),
		['allow', 'always', 'deny']);
}

// 2. Each button produces the reply the host expects. `always` must also be `approved`,
// or "allow for this run" would deny and remember the denial.
{
	for (const [act, expected] of [
		['allow', { approved: true, always: false, feedback: '' }],
		['always', { approved: true, always: true, feedback: '' }],
		['deny', { approved: false, always: false, feedback: '' }],
	]) {
		const h = harness();
		h.api.render({ ...approvalRequest });
		h.card().findAll('prompt-btn').find(b => b.getAttribute('data-act') === act).fire('click');
		assert.deepStrictEqual(h.posted, [{ type: 'promptResponse', promptId: 'p1', response: expected }],
			`"${act}" posts the right reply`);
	}
}

// 3. A denial carries the reason typed into the box — that text is what stops the model
// retrying the identical thing.
{
	const h = harness();
	h.api.render({ ...approvalRequest });
	const card = h.card();
	card.find('prompt-feedback').value = '  rewrite it with the tests instead  ';
	card.findAll('prompt-btn').find(b => b.getAttribute('data-act') === 'deny').fire('click');
	assert.strictEqual(h.posted[0].response.feedback, 'rewrite it with the tests instead', 'trimmed and forwarded');
	assert.strictEqual(h.posted[0].response.approved, false);
}

// 3b. Enter in the feedback box denies with that reason.
{
	const h = harness();
	h.api.render({ ...approvalRequest });
	const card = h.card();
	card.find('prompt-feedback').value = 'no';
	let prevented = false;
	card.find('prompt-feedback').fire('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
	assert.ok(prevented, 'the keypress is consumed');
	assert.deepStrictEqual(h.posted[0].response, { approved: false, always: false, feedback: 'no' });
}

// 4. Answering retires the card and it stops accepting input. A second click must not
// post again: the host discards the duplicate, but the card would misreport the outcome.
{
	const h = harness();
	h.api.render({ ...approvalRequest });
	const card = h.card();
	const allow = card.findAll('prompt-btn').find(b => b.getAttribute('data-act') === 'allow');
	allow.fire('click');
	allow.fire('click');
	assert.strictEqual(h.posted.length, 1, 'answered once');
	assert.ok(!card.classList.contains('prompt-open'));
	assert.ok(card.classList.contains('prompt-answered'));
	assert.strictEqual(card.textContent, '✓ Allowed');
	assert.strictEqual(h.api.size(), 0, 'no longer pending');
}

// 5. A single-select question answers on the first click, with the option's label.
{
	const h = harness();
	h.api.render({ ...askRequest });
	const card = h.card();
	const options = card.findAll('prompt-option');
	assert.strictEqual(options.length, 2);
	assert.strictEqual(options[0].find('prompt-option-label').textContent, 'Patch it');
	assert.strictEqual(options[0].find('prompt-option-desc').textContent, 'Smaller diff');
	options[1].fire('click');
	assert.deepStrictEqual(h.posted, [{ type: 'promptResponse', promptId: 'q1', response: { answer: 'Rewrite it' } }]);
}

// 6. Multi-select accumulates instead of answering, stays editable, and toggles off.
{
	const h = harness();
	h.api.render({ ...askRequest, multiSelect: true });
	const card = h.card();
	const [first, second] = card.findAll('prompt-option');
	first.fire('click');
	second.fire('click');
	assert.strictEqual(h.posted.length, 0, 'picking does not submit in multi-select');
	assert.strictEqual(card.find('prompt-answer').value, 'Patch it, Rewrite it');
	assert.ok(first.classList.contains('prompt-option-on'));
	first.fire('click');
	assert.strictEqual(card.find('prompt-answer').value, 'Rewrite it', 'clicking again deselects');
	assert.ok(!first.classList.contains('prompt-option-on'));
	card.findAll('prompt-btn').find(b => b.getAttribute('data-act') === 'send').fire('click');
	assert.deepStrictEqual(h.posted[0].response, { answer: 'Rewrite it' });
}

// 7. A free-text answer wins over the options; an empty one is not submitted, so Send on
// an untouched card can't send a blank answer the model would have to interpret.
{
	const h = harness();
	h.api.render({ ...askRequest });
	const card = h.card();
	const send = card.findAll('prompt-btn').find(b => b.getAttribute('data-act') === 'send');
	send.fire('click');
	assert.strictEqual(h.posted.length, 0, 'empty answers are ignored');
	card.find('prompt-answer').value = 'Neither — use the existing helper';
	send.fire('click');
	assert.deepStrictEqual(h.posted[0].response, { answer: 'Neither — use the existing helper' });
}

// 8. Switching chat tabs rebuilds the transcript. The card must come back, keep a
// half-made multi-select, and the redrawn buttons must still work — a card that survives
// visually but answers nothing is worse than one that vanishes.
{
	const h = harness();
	const request = { ...askRequest, multiSelect: true };
	h.api.render(request);
	h.card().findAll('prompt-option')[0].fire('click');

	h.container.children = []; // renderAll() clears the transcript
	h.api.reattach('s1');
	assert.strictEqual(h.container.children.length, 1, 'the card was redrawn');
	const redrawn = h.card();
	assert.strictEqual(redrawn.find('prompt-answer').value, 'Patch it', 'the selection survived');
	assert.ok(redrawn.findAll('prompt-option')[0].classList.contains('prompt-option-on'));
	redrawn.findAll('prompt-btn').find(b => b.getAttribute('data-act') === 'send').fire('click');
	assert.deepStrictEqual(h.posted, [{ type: 'promptResponse', promptId: 'q1', response: { answer: 'Patch it' } }]);
	assert.strictEqual(h.api.size(), 0);
}

// 8b. reattach only draws the tab it was asked for, and a tracked (never-drawn) card for
// a background tab appears when the user switches to it.
{
	const h = harness();
	h.api.track({ ...askRequest, id: 'other', sessionId: 's2' });
	h.api.reattach('s1');
	assert.strictEqual(h.container.children.length, 0, 'another tab is left alone');
	h.api.reattach('s2');
	assert.strictEqual(h.container.children.length, 1, 'switching to that tab draws it');
	assert.strictEqual(h.card().getAttribute('data-prompt-id'), 'other');
}

// 9. Stopping the run retires the card without answering — the host has already torn the
// promise down, so a reply would go nowhere.
{
	const h = harness();
	h.api.render({ ...approvalRequest });
	h.api.cancel('p1');
	assert.strictEqual(h.posted.length, 0, 'cancelling never replies');
	assert.match(h.card().textContent, /Cancelled/);
	assert.strictEqual(h.api.size(), 0);
	h.api.cancel('p1'); // must be idempotent
	h.card().findAll('prompt-btn').forEach(b => b.fire('click'));
	assert.strictEqual(h.posted.length, 0, 'a cancelled card is inert');
}

// 10. Model-supplied text goes through textContent, never innerHTML, so markup in a
// question is shown literally rather than parsed.
{
	const h = harness();
	h.api.render({ ...askRequest, question: '<img src=x onerror=alert(1)>' });
	assert.strictEqual(h.card().find('prompt-title').textContent, '🙋 <img src=x onerror=alert(1)>');
	// Belt and braces: the stand-in has no innerHTML at all, so an assignment would have
	// thrown above — but assert on the source too, so the guarantee survives someone
	// making the stand-in more capable later.
	const source = fs.readFileSync(new URL('../media/prompts.js', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /\.innerHTML\s*=/, 'prompts.js never assigns innerHTML');
}

// 11. Options with no label are dropped rather than rendered as empty buttons.
{
	const h = harness();
	h.api.render({ ...askRequest, options: [{ label: 'Keep' }, { label: '' }, {}] });
	assert.strictEqual(h.card().findAll('prompt-option').length, 1);
}

console.log('test-prompt-cards: all assertions passed');
