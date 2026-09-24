// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Renders one session's transcript into the DOM. Two rules shape everything here:
//
//  1. DOM construction only — `createElement`/`textContent`, never `innerHTML`. The PWA is a
//     public page holding a device token that can drive an Agent run on the developer's
//     machine, and this renders untrusted model output; a markdown renderer that assembles an
//     HTML string is one escaping bug away from handing that token to whatever a model was
//     tricked into printing. Every bold span, list item and table cell here is a real element
//     with its own `textContent`. Links are the one attribute taken from model text, and only
//     for `http(s):`/`mailto:` targets.
//  2. Incremental by default. A streamed reply arrives as dozens of `token` frames a second;
//     rebuilding the whole transcript for each one (what this file used to do) made a long
//     chat stutter and threw away anything appended between rebuilds — tool rows, notices,
//     approval cards. `render` is for a genuinely new view (tab switch, fresh transcript);
//     streaming touches only the pending row via `renderPending`, and finished entries are
//     added with `appendEntry`.
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
 * A transcript entry as the host sends it (`session/types.ts`'s `TranscriptEntry`, with
 * `images` already reduced to `imageCount` by the remote sink), plus the PWA's own live tool
 * rows (`live: true`), which stand in for a tool call until the authoritative transcript
 * replaces them.
 * @typedef {{
 *   role?: string, content?: string, text?: string, kind?: string, imageCount?: number,
 *   toolCalls?: { id: string, name: string, args?: Record<string, unknown> }[], toolCallId?: string,
 *   phases?: { label?: string, provider?: string, model?: string, source?: string }[],
 *   live?: boolean, name?: string, args?: Record<string, unknown>, status?: string, result?: string,
 * }} TranscriptMessage
 */

// ---- Inline markdown ----------------------------------------------------------------------

/**
 * Inline tokens, first match wins at each position: code, link, bold, strikethrough, italic,
 * bare URL. Code comes first so nothing reaches inside a code span; a link before emphasis so
 * `[**x**](url)` stays one link.
 */
const INLINE_RE = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*|\b_[^_\n]+_\b)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Only these link targets are ever put into an `href` — `javascript:`, `data:` and relative URLs render as plain text. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

/**
 * @param {string} href
 * @param {string} label
 */
function link(href, label) {
	if (!SAFE_HREF.test(href)) { return document.createTextNode(label); }
	const a = el('a', 'md-link');
	a.href = href;
	a.target = '_blank';
	a.rel = 'noopener noreferrer';
	// No links inside a link — a label that is itself a URL would otherwise link forever.
	renderInline(a, label, false);
	return a;
}

/**
 * @param {{ appendChild(node: any): void }} container
 * @param {string} text
 * @param {boolean} [links] false inside a link's own label
 */
function renderInline(container, text, links = true) {
	let last = 0;
	for (const match of text.matchAll(INLINE_RE)) {
		const index = match.index ?? 0;
		if (index > last) { container.appendChild(document.createTextNode(text.slice(last, index))); }
		const [whole, code, mdLink, bold, strike, italic, url] = match;
		if (code) {
			container.appendChild(el('code', undefined, code.slice(1, -1)));
		} else if (mdLink) {
			const split = mdLink.indexOf('](');
			const label = mdLink.slice(1, split);
			container.appendChild(links ? link(mdLink.slice(split + 2, -1), label) : document.createTextNode(label));
		} else if (bold) {
			const strong = el('strong');
			renderInline(strong, bold.slice(2, -2), links);
			container.appendChild(strong);
		} else if (strike) {
			const del = el('del');
			renderInline(del, strike.slice(2, -2), links);
			container.appendChild(del);
		} else if (italic) {
			const em = el('em');
			renderInline(em, italic.slice(1, -1), links);
			container.appendChild(em);
		} else if (url) {
			container.appendChild(links ? link(url, url) : document.createTextNode(url));
		}
		last = index + whole.length;
	}
	if (last < text.length) { container.appendChild(document.createTextNode(text.slice(last))); }
}

// ---- Block markdown -----------------------------------------------------------------------

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** @param {string} line */
function isTableRow(line) {
	return line.includes('|') && line.trim().length > 1;
}

/** @param {string} line */
function tableCells(line) {
	return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

/**
 * Starts a new block when a line matches one of the constructs a paragraph must stop at.
 * @param {string[]} lines
 * @param {number} i
 */
function startsBlock(lines, i) {
	const line = lines[i];
	return FENCE_OPEN.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
		|| LIST_ITEM.test(line) || (isTableRow(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]));
}

/**
 * Renders a run of list lines (already collected) as nested `<ul>`/`<ol>`, nesting by
 * indentation. Task-list items (`- [ ]`, `- [x]`) get a real, disabled checkbox.
 * @param {any} container
 * @param {string[]} lines
 */
function renderList(container, lines) {
	/** @type {{ indent: number, list: any, item: any }[]} */
	const stack = [];
	for (const line of lines) {
		const match = LIST_ITEM.exec(line);
		if (!match) {
			// A continuation line of the item above it.
			const top = stack[stack.length - 1];
			if (top && top.item) {
				top.item.appendChild(document.createTextNode('\n'));
				renderInline(top.item, line.trim());
			}
			continue;
		}
		const indent = match[1].replace(/\t/g, '    ').length;
		const ordered = /\d/.test(match[2]);
		while (stack.length && indent < stack[stack.length - 1].indent) { stack.pop(); }
		let top = stack[stack.length - 1];
		if (!top || indent > top.indent) {
			const list = el(ordered ? 'ol' : 'ul', 'md-list');
			if (ordered) {
				const start = parseInt(match[2], 10);
				if (start > 1) { list.start = start; }
			}
			(top && top.item ? top.item : container).appendChild(list);
			top = { indent, list, item: null };
			stack.push(top);
		}
		const item = el('li');
		let text = match[3];
		const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
		if (task) {
			const box = /** @type {HTMLInputElement} */ (el('input', 'md-task'));
			box.type = 'checkbox';
			box.checked = task[1] !== ' ';
			box.disabled = true;
			item.appendChild(box);
			text = task[2];
		}
		renderInline(item, text);
		top.list.appendChild(item);
		top.item = item;
	}
}

/**
 * Renders markdown `text` into `container` as block elements: paragraphs, headings, fenced
 * code, lists, blockquotes, tables and rules. A fence that hasn't closed yet (mid-stream)
 * renders as code up to the end of the text, so a streaming code block reads as code from its
 * first line instead of flashing as prose until the closing fence arrives.
 * @param {any} container
 * @param {string} text
 */
export function renderBody(container, text) {
	const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) { i++; continue; }

		const fence = FENCE_OPEN.exec(line);
		if (fence) {
			const marker = fence[1];
			const body = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(marker)) { body.push(lines[i]); i++; }
			i++; // the closing fence, if there was one
			const pre = el('pre', 'md-code');
			if (fence[2]) { pre.appendChild(el('span', 'md-code-lang', fence[2])); }
			pre.appendChild(el('code', undefined, body.join('\n')));
			container.appendChild(pre);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			// h1/h2 from a model are section labels inside one message, not page titles.
			const node = el(`h${Math.min(6, heading[1].length + 2)}`, 'md-heading');
			renderInline(node, heading[2]);
			container.appendChild(node);
			i++;
			continue;
		}

		if (RULE.test(line)) {
			container.appendChild(el('hr', 'md-rule'));
			i++;
			continue;
		}

		if (QUOTE.test(line)) {
			const quoted = [];
			while (i < lines.length && QUOTE.test(lines[i])) {
				quoted.push(/** @type {RegExpExecArray} */ (QUOTE.exec(lines[i]))[1]);
				i++;
			}
			const quote = el('blockquote', 'md-quote');
			renderBody(quote, quoted.join('\n'));
			container.appendChild(quote);
			continue;
		}

		if (LIST_ITEM.test(line)) {
			const items = [];
			while (i < lines.length && lines[i].trim() && (LIST_ITEM.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
				items.push(lines[i]);
				i++;
			}
			renderList(container, items);
			continue;
		}

		if (isTableRow(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
			const wrap = el('div', 'md-table-wrap');
			const table = el('table', 'md-table');
			const head = el('tr');
			for (const cell of tableCells(line)) {
				const th = el('th');
				renderInline(th, cell);
				head.appendChild(th);
			}
			table.appendChild(head);
			i += 2;
			while (i < lines.length && isTableRow(lines[i])) {
				const row = el('tr');
				for (const cell of tableCells(lines[i])) {
					const td = el('td');
					renderInline(td, cell);
					row.appendChild(td);
				}
				table.appendChild(row);
				i++;
			}
			wrap.appendChild(table);
			container.appendChild(wrap);
			continue;
		}

		const paragraph = [];
		while (i < lines.length && lines[i].trim() && !(paragraph.length && startsBlock(lines, i))) {
			paragraph.push(lines[i]);
			i++;
		}
		const p = el('p', 'md-p');
		renderInline(p, paragraph.join('\n'));
		container.appendChild(p);
	}
}

// ---- Tool calls -----------------------------------------------------------------------------

/** Argument keys worth showing next to a tool's name, most telling first. */
const ARG_HINT_KEYS = ['path', 'file', 'filePath', 'command', 'url', 'query', 'pattern', 'glob', 'task', 'question', 'name'];

/**
 * A short "what is it touching" hint for a tool row: the first telling argument, clipped.
 * @param {Record<string, unknown> | undefined} args
 */
export function argHint(args) {
	if (!args || typeof args !== 'object') { return ''; }
	for (const key of ARG_HINT_KEYS) {
		const value = args[key];
		if (typeof value === 'string' && value.trim()) {
			const flat = value.trim().replace(/\s+/g, ' ');
			return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
		}
	}
	if (Array.isArray(args.edits)) { return `${args.edits.length} edit${args.edits.length === 1 ? '' : 's'}`; }
	return '';
}

/** @param {string} result */
function resultSummary(result) {
	const lines = result ? result.split('\n').length : 0;
	return lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'no output';
}

/** Tool output shown per row, at most — the rest is a scroll the phone doesn't need. */
const RESULT_PREVIEW_CHARS = 4000;

/**
 * One tool call as a compact row: status mark, name, argument hint, and the result folded
 * into a `<details>` that stays shut unless the call failed.
 * @param {{ name?: string, args?: Record<string, unknown>, status?: string, result?: string }} call
 */
function toolRow(call) {
	const row = el('div', 'tool');
	fillToolRow(row, call);
	return row;
}

/**
 * @param {any} row
 * @param {{ name?: string, args?: Record<string, unknown>, status?: string, result?: string }} call
 */
function fillToolRow(row, call) {
	const status = call.status || 'done';
	row.className = `tool tool-${status}`;
	row.replaceChildren();
	const head = el('div', 'tool-head');
	head.appendChild(el('span', 'tool-mark'));
	head.appendChild(el('span', 'tool-name', call.name || 'tool'));
	const hint = argHint(call.args);
	if (hint) { head.appendChild(el('span', 'tool-arg', hint)); }
	const label = status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : status === 'error' ? 'failed' : '';
	if (label) { head.appendChild(el('span', 'tool-state', label)); }
	if (typeof call.result === 'string' && status !== 'running') {
		const details = el('details', 'tool-details');
		details.open = status === 'error';
		const summary = el('summary');
		summary.appendChild(head);
		summary.appendChild(el('span', 'tool-size', resultSummary(call.result)));
		details.appendChild(summary);
		const clipped = call.result.length > RESULT_PREVIEW_CHARS ? `${call.result.slice(0, RESULT_PREVIEW_CHARS)}\n…` : call.result;
		details.appendChild(el('pre', 'tool-output', clipped));
		row.appendChild(details);
	} else {
		row.appendChild(head);
	}
}

/**
 * Re-renders a live tool row in place once its call finishes.
 * @param {any} row
 * @param {TranscriptMessage} entry
 */
export function updateToolRow(row, entry) {
	fillToolRow(row, entry);
}

// ---- Entries --------------------------------------------------------------------------------

/**
 * @param {TranscriptMessage} message
 * @param {Map<string, TranscriptMessage>} [results] tool results by `toolCallId`, folded into their call's row
 */
function renderMessage(message, results) {
	if (message.live) {
		return toolRow(message);
	}
	if (message.kind === 'info' || message.kind === 'error' || message.kind === 'notice') {
		return el('div', `notice notice-${message.kind === 'error' ? 'error' : 'info'}`, String(message.content ?? message.text ?? ''));
	}
	if (message.kind === 'auto') {
		return autoSummaryBox(message.phases);
	}
	if (message.role === 'tool') {
		// A result whose call was not in view (windowed off the top) — still worth a row.
		return toolRow({ name: 'result', status: 'done', result: String(message.content ?? '') });
	}
	const role = message.role === 'user' ? 'user' : 'assistant';
	const row = el('div', `msg msg-${role}`);
	const body = el('div', 'msg-body');
	const content = String(message.content ?? message.text ?? '');
	if (content) { renderBody(body, content); }
	if (message.imageCount) {
		body.appendChild(el('div', 'msg-attach', `${message.imageCount} image${message.imageCount === 1 ? '' : 's'} attached`));
	}
	if (content || message.imageCount) { row.appendChild(body); }
	if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
		const calls = el('div', 'tool-group');
		for (const call of message.toolCalls) {
			const result = results && results.get(call.id);
			calls.appendChild(toolRow({
				name: call.name, args: call.args,
				status: result && /^(error|failed)\b/i.test(String(result.content ?? '')) ? 'error' : 'done',
				result: result ? String(result.content ?? '') : undefined,
			}));
		}
		row.appendChild(calls);
	}
	return row;
}

/**
 * Appends one finished entry below everything already rendered, keeping the pending/working
 * row (if any) last.
 * @param {any} container
 * @param {TranscriptMessage} message
 * @returns {any} the appended row
 */
export function appendEntry(container, message) {
	const row = renderMessage(message);
	const pending = pendingRows.get(container);
	if (pending && pending.parentNode === container) {
		container.insertBefore(row, pending);
	} else {
		container.appendChild(row);
	}
	return row;
}

/**
 * Rebuilds `container` from a session's messages plus any in-flight streamed text. Tool
 * results are folded into the row of the call that produced them. When older messages exist
 * than the window shown (`session.from > 0`) and `options.onLoadEarlier` is given, a control at
 * the top asks for them.
 * @param {any} container
 * @param {{ messages?: TranscriptMessage[], pending?: string | null, streaming?: boolean, from?: number }} session
 * @param {{ onLoadEarlier?: () => void }} [options]
 */
export function render(container, session, options = {}) {
	if (typeof container.replaceChildren === 'function') {
		container.replaceChildren();
	}
	pendingRows.delete(container);
	if (session.from && options.onLoadEarlier) {
		const more = el('button', 'load-earlier', 'Show earlier messages');
		more.type = 'button';
		const onLoadEarlier = options.onLoadEarlier;
		more.addEventListener('click', () => {
			more.disabled = true;
			more.textContent = 'Loading…';
			onLoadEarlier();
		});
		container.appendChild(more);
	}
	const messages = Array.isArray(session.messages) ? session.messages : [];
	/** @type {Map<string, TranscriptMessage>} */
	const results = new Map();
	const calledIds = new Set();
	for (const message of messages) {
		if (message.role === 'tool' && message.toolCallId) { results.set(message.toolCallId, message); }
		if (Array.isArray(message.toolCalls)) {
			for (const call of message.toolCalls) { calledIds.add(call.id); }
		}
	}
	for (const message of messages) {
		if (message.role === 'tool' && message.toolCallId && calledIds.has(message.toolCallId)) { continue; }
		container.appendChild(renderMessage(message, results));
	}
	renderPending(container, session);
}

// ---- Streaming ------------------------------------------------------------------------------

/** The pending (streaming or "working") row per container — kept by reference, never looked up by selector. */
const pendingRows = new WeakMap();

/**
 * Brings the live tail in line with `session`: the streaming reply as it arrives, a "Working"
 * row while a run is going with nothing to show yet, nothing once it's idle. Cheap enough to
 * call once per animation frame — it only ever rebuilds the one row.
 * @param {any} container
 * @param {{ pending?: string | null, streaming?: boolean, messages?: TranscriptMessage[] }} session
 */
export function renderPending(container, session) {
	let row = pendingRows.get(container);
	const text = typeof session.pending === 'string' ? session.pending : '';
	const messages = Array.isArray(session.messages) ? session.messages : [];
	const toolRunning = messages.some(m => m.live && m.status === 'running');
	if (!session.streaming || (!text && toolRunning)) {
		if (row && row.parentNode) { row.parentNode.removeChild(row); }
		pendingRows.delete(container);
		return;
	}
	if (!row) {
		row = el('div');
		pendingRows.set(container, row);
	}
	row.replaceChildren();
	if (text) {
		row.className = 'msg msg-assistant msg-pending';
		const body = el('div', 'msg-body');
		renderBody(body, text);
		row.appendChild(body);
	} else {
		row.className = 'working';
		const dots = el('span', 'working-dots');
		dots.appendChild(el('span'));
		dots.appendChild(el('span'));
		dots.appendChild(el('span'));
		row.appendChild(dots);
		row.appendChild(el('span', 'working-label', 'Working'));
	}
	if (row.parentNode !== container || container.lastChild !== row) {
		container.appendChild(row);
	}
}

// ---- Side panels ----------------------------------------------------------------------------

/**
 * Appends a one-line notice. Prefer pushing a `{ kind: 'info' | 'error' }` entry into the
 * session so it survives the next full render; this is for notices with no session to own them.
 * @param {any} container
 * @param {string} className
 * @param {string} text
 */
export function appendNotice(container, className, text) {
	const row = el('div', `notice ${className}`, text);
	const pending = pendingRows.get(container);
	if (pending && pending.parentNode === container) {
		container.insertBefore(row, pending);
	} else {
		container.appendChild(row);
	}
	return row;
}

/**
 * Renders the agent's checklist as a collapsible strip: progress and the item in hand when
 * shut, the whole list when open. Accepts the host's `{ content, status }` items (and the
 * older `{ text, done }` shape).
 * @param {any} container
 * @param {{ content?: string, status?: string, text?: string, done?: boolean }[]} todos
 */
export function renderTodos(container, todos) {
	const items = (Array.isArray(todos) ? todos : []).map(t => ({
		text: String(t.content ?? t.text ?? ''),
		status: t.status || (t.done ? 'completed' : 'pending'),
	})).filter(t => t.text);
	const wasOpen = container.firstChild && container.firstChild.open;
	if (typeof container.replaceChildren === 'function') {
		container.replaceChildren();
	}
	container.hidden = !items.length;
	if (!items.length) { return; }
	const done = items.filter(t => t.status === 'completed').length;
	const current = items.find(t => t.status === 'in_progress') || items.find(t => t.status !== 'completed');
	const details = el('details', 'todo-panel');
	details.open = !!wasOpen;
	const summary = el('summary', 'todo-summary');
	summary.appendChild(el('span', 'todo-count', `${done}/${items.length}`));
	summary.appendChild(el('span', 'todo-current', current ? current.text : 'All tasks done'));
	details.appendChild(summary);
	const list = el('div', 'todo-list');
	for (const item of items) {
		const row = el('div', `todo todo-${item.status}`);
		row.appendChild(el('span', 'todo-mark'));
		row.appendChild(el('span', 'todo-text', item.text));
		list.appendChild(row);
	}
	details.appendChild(list);
	container.appendChild(details);
}

/**
 * @param {{ label?: string, provider?: string, model?: string, source?: string }[] | undefined} phases
 */
function autoSummaryBox(phases) {
	const box = el('div', 'auto-summary');
	box.appendChild(el('div', 'auto-summary-title', 'Models used'));
	for (const phase of Array.isArray(phases) ? phases : []) {
		const row = el('div', 'auto-summary-row');
		row.appendChild(el('span', 'auto-summary-label', String(phase.label || '')));
		row.appendChild(el('span', 'auto-summary-model', String(phase.model || phase.provider || '')));
		row.appendChild(el('span', 'auto-summary-source', phase.source === 'configured' ? 'pinned' : 'auto'));
		box.appendChild(row);
	}
	return box;
}

/**
 * Appends the Auto-mode "models used" summary.
 * @param {any} container
 * @param {{ label?: string, provider?: string, model?: string, source?: string }[]} phases
 */
export function appendAutoSummary(container, phases) {
	return appendEntry(container, { role: 'assistant', kind: 'auto', phases });
}
