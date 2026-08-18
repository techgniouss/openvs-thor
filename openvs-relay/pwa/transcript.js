// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Renders one session's transcript into the DOM, plus a deliberately small markdown-lite pass
// (fenced code blocks, inline code, bold, italics — see `renderInline`/`renderBody` below): the
// PWA is a public page and this renders untrusted model output, so unlike
// `extensions/openvs-chat/media/main.js`'s `innerHTML`-based renderer (safe there behind VS
// Code's webview CSP), everything here still goes through `createElement`/`textContent` only,
// never `innerHTML` — a bold/italic/code span is a real element with its own `textContent`, not
// a string of HTML. Same no-querySelector discipline as `extensions/openvs-chat/media/prompts.js`
// for the same reason: no child is ever found again by selector, only kept by direct reference.
'use strict';

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

/**
 * A single transcript entry as the host sends it. Shape mirrors (a subset of) what
 * `extensions/openvs-chat/media/main.js` reads off `s.messages[i]` — only the fields this
 * plain-text renderer actually draws.
 * @typedef {{ role?: string, content?: string, kind?: string, tool?: string, text?: string }} TranscriptMessage
 */

/** Inline tokens: `` `code` ``, `**bold**`, then `*italic*`/`_italic_` — checked in that order (as one alternation) so `**bold**` isn't first split into two unmatched `*italic*` halves. Deliberately not nested: the matched inner text becomes a single element's `textContent` verbatim, formatting marks and all, rather than recursing — good enough for how these actually appear in model output, and simpler stays safer for a renderer with no innerHTML escape hatch to fall back on. */
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)/g;

/**
 * Renders one prose segment's inline formatting into `container` — text nodes for plain runs,
 * a real `<code>`/`<strong>`/`<em>` element (via `createElement`, never `innerHTML`) for each
 * matched span.
 * @param {{ appendChild(node: any): void }} container
 * @param {string} text
 */
function renderInline(container, text) {
	let last = 0;
	for (const match of text.matchAll(INLINE_RE)) {
		if (match.index > last) { container.appendChild(document.createTextNode(text.slice(last, match.index))); }
		const [whole, code, bold, italic] = match;
		if (code) {
			container.appendChild(el('code', undefined, code.slice(1, -1)));
		} else if (bold) {
			container.appendChild(el('strong', undefined, bold.slice(2, -2)));
		} else if (italic) {
			container.appendChild(el('em', undefined, italic.slice(1, -1)));
		}
		last = match.index + whole.length;
	}
	if (last < text.length) { container.appendChild(document.createTextNode(text.slice(last))); }
}

/** Matches a fenced code block, capturing its inner content (language line + code) — mirrors `media/main.js`'s own split, minus the HTML-string assembly. */
const FENCE_RE = /```([\s\S]*?)```/g;

/**
 * Renders `text` into `container`: fenced code blocks as `<pre><code>` (language line on the
 * fence's first line stripped, matching `media/main.js`'s convention), everything else through
 * {@link renderInline}. `white-space: pre-wrap` on `.msg-body` (styles.css) already preserves
 * line breaks in the prose runs, so this never has to synthesize a `<br>`.
 * @param {{ appendChild(node: any): void }} container
 * @param {string} text
 */
function renderBody(container, text) {
	let last = 0;
	for (const match of text.matchAll(FENCE_RE)) {
		if (match.index > last) { renderInline(container, text.slice(last, match.index)); }
		const inner = match[1];
		const nl = inner.indexOf('\n');
		const code = nl !== -1 && /^[a-zA-Z0-9+#._-]*$/.test(inner.slice(0, nl).trim()) ? inner.slice(nl + 1) : inner;
		const pre = el('pre');
		pre.appendChild(el('code', undefined, code.replace(/\n$/, '')));
		container.appendChild(pre);
		last = match.index + match[0].length;
	}
	if (last < text.length) { renderInline(container, text.slice(last)); }
}

/**
 * @param {TranscriptMessage} message
 */
function renderMessage(message) {
	const role = message.kind === 'auto' ? 'auto' : (message.role || 'assistant');
	const row = el('div', `msg msg-${role}`);
	row.appendChild(el('div', 'msg-role', role));
	const body = el('div', 'msg-body');
	renderBody(body, String(message.content ?? message.text ?? ''));
	row.appendChild(body);
	return row;
}

/**
 * Rebuilds `container`'s children from a session's messages plus any in-flight streamed text.
 * @param {{ appendChild(node: any): void, replaceChildren?: (...nodes: any[]) => void }} container
 * @param {{ messages?: TranscriptMessage[], pending?: string | null, streaming?: boolean }} session
 */
export function render(container, session) {
	if (typeof container.replaceChildren === 'function') {
		container.replaceChildren();
	}
	const messages = Array.isArray(session.messages) ? session.messages : [];
	for (const message of messages) {
		container.appendChild(renderMessage(message));
	}
	if (session.streaming && typeof session.pending === 'string' && session.pending.length > 0) {
		const row = el('div', 'msg msg-assistant msg-pending');
		row.appendChild(el('div', 'msg-role', 'assistant'));
		const body = el('div', 'msg-body');
		// Streaming text is very likely to contain a still-open, unterminated fence — `FENCE_RE`
		// simply won't match it yet, so `renderBody` falls through to `renderInline` and renders
		// it as prose until the closing ``` actually arrives. That's the same "not there yet"
		// behavior plain textContent had, just with bold/italic/inline-code applied once they
		// close.
		renderBody(body, session.pending);
		row.appendChild(body);
		container.appendChild(row);
	}
}

/**
 * Appends a one-line system/tool/info notice — used for `toolStart`/`toolEnd`/`info`/`error`/
 * `autoPhase`/`compacted`, which are transient narration rather than transcript entries proper.
 * @param {{ appendChild(node: any): void }} container
 * @param {string} className
 * @param {string} text
 */
export function appendNotice(container, className, text) {
	container.appendChild(el('div', `notice ${className}`, text));
}

/**
 * Renders the todo checklist the agent is tracking for the active run.
 * @param {{ replaceChildren?: (...nodes: any[]) => void, appendChild(node: any): void }} container
 * @param {{ text?: string, done?: boolean }[]} todos
 */
export function renderTodos(container, todos) {
	if (typeof container.replaceChildren === 'function') {
		container.replaceChildren();
	}
	for (const todo of Array.isArray(todos) ? todos : []) {
		const row = el('div', `todo ${todo.done ? 'todo-done' : ''}`.trim());
		row.appendChild(el('span', 'todo-mark', todo.done ? '✓' : '○'));
		row.appendChild(el('span', 'todo-text', String(todo.text || '')));
		container.appendChild(row);
	}
}

/**
 * Renders the Auto-mode "models used" summary rows appended by `autoSummary`.
 * @param {{ appendChild(node: any): void }} container
 * @param {{ label?: string, provider?: string, model?: string, source?: string }[]} phases
 */
export function appendAutoSummary(container, phases) {
	const box = el('div', 'auto-summary');
	for (const phase of Array.isArray(phases) ? phases : []) {
		const row = el('div', 'auto-summary-row');
		row.appendChild(el('span', 'auto-summary-label', String(phase.label || '')));
		row.appendChild(el('span', 'auto-summary-model', `${phase.provider || ''}:${phase.model || ''}`));
		row.appendChild(el('span', 'auto-summary-source', String(phase.source || '')));
		box.appendChild(row);
	}
	container.appendChild(box);
}
