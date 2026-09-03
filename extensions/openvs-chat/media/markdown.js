/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
/**
 * The transcript's markdown renderer.
 *
 * Split out of main.js for the same reason `prompts.js` was: main.js is one large IIFE that
 * reaches for a live workbench on load, so nothing inside it can be exercised directly, and
 * this is the one part of the webview every single message goes through. It is pure
 * string → HTML with no DOM access at all, which is what lets `scripts/test-markdown.mjs`
 * drive it directly.
 *
 * Two rules hold this together:
 *   * text that came from a model is escaped exactly once, at the point it enters the
 *     output — every construct below either escapes its own text or holds already-escaped
 *     HTML in the token table,
 *   * inline constructs are resolved against a token table rather than against the growing
 *     HTML string, so a later rule can never reach inside an earlier rule's output. That is
 *     what stopped `` `**x**` `` from rendering bold *inside* a code span, and what keeps
 *     the autolinker off the href it just wrote.
 */
(function () {
	'use strict';

	/** Mjolnir's bolt, drawn once and reused by every Thor mark in the UI. */
	const THOR_BOLT_PATH = 'M13.8 1.5 4.2 13.6c-.3.4 0 1 .5 1h4.6l-1.3 7.6c-.1.6.7.9 1.1.4l9.6-12.1c.3-.4 0-1-.5-1h-4.6l1.3-7.6c.1-.6-.7-.9-1.1-.4Z';

	// Reasoning arrives inline in the token stream, fenced by these markers (see
	// src/persona/thinking.ts, which also stamps the duration just inside the closer).
	const THINK_OPEN = '🤔 *Thinking…*\n\n';
	const THINK_CLOSE = '\n\n---\n\n';
	const THINK_DURATION = /\n*\[thought for (\d+)s\]\s*$/;

	/**
	 * Placeholder delimiters for the inline token table. Control characters, so no model
	 * output can spell one: anything a model actually types is escaped before these are
	 * substituted back in, and a NUL cannot survive that escaping as itself.
	 */
	const TOK_OPEN = '\u0000';
	const TOK_CLOSE = '\u0001';
	const TOKEN_RE = /\u0000(\d+)\u0001/g;

	/** A GFM table's delimiter row — what separates a header from a table's body. */
	const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
	/** A horizontal rule: three or more of the same marker, nothing else on the line. */
	const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

	/** @param {string} text */
	function escapeHtml(text) {
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	/**
	 * A link's href, or undefined when the target is not one we are willing to emit.
	 * Only http(s) and mailto: a model can write any string it likes here, and `javascript:`
	 * in an anchor is a click away from script execution.
	 * @param {string} url
	 */
	function safeHref(url) {
		const trimmed = url.trim();
		return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
	}

	/**
	 * Renders one line of inline markdown: code spans, links, bold, italic, strikethrough.
	 *
	 * Every construct that produces HTML parks it in `tokens` and leaves a placeholder
	 * behind, so the rules that run after it see the placeholder rather than the markup.
	 * Without that, emphasis leaked into code spans and the autolinker matched the URL
	 * inside an href it had just written.
	 * @param {string} text
	 */
	function renderInline(text) {
		/** @type {string[]} */
		const tokens = [];
		/** @param {string} html */
		const hold = html => `${TOK_OPEN}${tokens.push(html) - 1}${TOK_CLOSE}`;

		// Code spans come out of the RAW text, before escaping: their content is literal, so
		// nothing inside one may be read as markdown.
		let out = String(text).replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code>${escapeHtml(code)}</code>`));
		out = escapeHtml(out);

		// Explicit links first, so the autolinker below never sees a URL that already has an
		// anchor. An image (`![alt](url)`) is rendered as a link, not an <img>: a transcript
		// that silently fetches a URL a model wrote is an exfiltration channel, and a link
		// the user chooses to open is not.
		out = out.replace(/(!?)\[([^\]\n]*)\]\(\s*([^\s)]+)\s*\)/g, (m, bang, label, url) => {
			const href = safeHref(url);
			if (!href) {
				return m;
			}
			const text_ = label.trim() || href;
			return hold(`<a href="${href}">${bang ? '🖼 ' : ''}${text_}</a>`);
		});
		// Bare URLs. Trailing sentence punctuation is left outside the link — "see https://x.com."
		// should not link the full stop.
		out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g,
			(_m, lead, url) => `${lead}${hold(`<a href="${url}">${url}</a>`)}`);

		out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, s) => hold(`<strong>${s}</strong>`));
		out = out.replace(/__([^_\n]+)__/g, (_m, s) => hold(`<strong>${s}</strong>`));
		out = out.replace(/~~([^~\n]+)~~/g, (_m, s) => hold(`<del>${s}</del>`));
		// Italic runs last and is the fussiest: `*` must not match a bullet or a bare
		// multiplication sign, and `_` must not match inside snake_case identifiers, which
		// are everywhere in the code this assistant talks about.
		out = out.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g,
			(_m, lead, s) => `${lead}${hold(`<em>${s}</em>`)}`);
		out = out.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g,
			(_m, lead, s) => `${lead}${hold(`<em>${s}</em>`)}`);

		// Substitution repeats because a held anchor's label can itself contain a held code
		// span. Bounded by the table's size: every pass resolves at least one token.
		for (let i = 0; i <= tokens.length && TOKEN_RE.test(out); i++) {
			TOKEN_RE.lastIndex = 0;
			out = out.replace(TOKEN_RE, (_m, index) => tokens[Number(index)] ?? '');
		}
		TOKEN_RE.lastIndex = 0;
		return out;
	}

	/**
	 * Renders a GFM pipe table starting at `start`, or undefined when the lines there are
	 * not one. Models reach for a table whenever they compare options, and every one of
	 * them used to land in the transcript as raw `|---|---|` rubble.
	 * @param {string[]} lines
	 * @param {number} start
	 */
	function renderTable(lines, start) {
		if (start + 1 >= lines.length || !lines[start].includes('|') || !TABLE_DELIM.test(lines[start + 1])) {
			return undefined;
		}
		/** @param {string} row */
		const cells = row => {
			const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
			return trimmed.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
		};
		const header = cells(lines[start]);
		// Alignment is per column and comes from where the colons sit in the delimiter row.
		const align = cells(lines[start + 1]).map(spec => {
			const left = spec.startsWith(':');
			const right = spec.endsWith(':');
			return right ? (left ? 'center' : 'right') : (left ? 'left' : '');
		});
		/** @param {string[]} row @param {string} tag */
		const rowHtml = (row, tag) => '<tr>' + row.map((cell, i) => {
			const style = align[i] ? ` style="text-align:${align[i]}"` : '';
			return `<${tag}${style}>${renderInline(cell)}</${tag}>`;
		}).join('') + '</tr>';

		let end = start + 2;
		const body = [];
		for (; end < lines.length; end++) {
			const line = lines[end];
			if (!line.trim() || !line.includes('|')) {
				break;
			}
			const row = cells(line);
			// Ragged rows are normal from a model. Pad or trim to the header's width so the
			// table stays rectangular instead of dropping cells off the end.
			while (row.length < header.length) { row.push(''); }
			body.push(rowHtml(row.slice(0, header.length), 'td'));
		}
		const html = `<table><thead>${rowHtml(header, 'th')}</thead>`
			+ (body.length ? `<tbody>${body.join('')}</tbody>` : '') + '</table>';
		return { html, end };
	}

	/**
	 * Renders a non-code segment: headings, lists (nested), tables, blockquotes, rules and
	 * paragraphs.
	 *
	 * Line breaks are preserved literally (`<br />`) rather than folded into paragraphs,
	 * which is what the transcript has always done — a chat answer reads the way the model
	 * laid it out. Block constructs deliberately emit no `<br />` of their own: their own
	 * margins do that spacing, and a stray break either side of a table left a visible gap.
	 * @param {string} text
	 */
	function renderBlocks(text) {
		const lines = String(text).split('\n');
		let html = '';
		/**
		 * Open list elements, outermost first: the indent that opened each, its tag, and
		 * whether its current `<li>` is still open. A nested list belongs *inside* the item
		 * it hangs off, so the parent's item stays open across it — closing it first and
		 * emitting the sublist as a sibling is invalid markup that only happens to indent.
		 */
		const stack = /** @type {{ indent: number, tag: 'ul' | 'ol', liOpen: boolean }[]} */ ([]);
		/** Closes every list nested deeper than `toIndent` (all of them by default). */
		const closeLists = (toIndent = -1) => {
			while (stack.length && stack[stack.length - 1].indent > toIndent) {
				const top = /** @type {{ indent: number, tag: 'ul' | 'ol', liOpen: boolean }} */ (stack.pop());
				html += `${top.liOpen ? '</li>' : ''}</${top.tag}>`;
			}
		};
		/** Blockquote depth currently open. */
		let quoted = false;
		const closeQuote = () => { if (quoted) { html += '</blockquote>'; quoted = false; } };

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			const table = renderTable(lines, i);
			if (table) {
				closeLists(); closeQuote();
				html += table.html;
				i = table.end - 1;
				continue;
			}

			const quote = /^\s*>\s?(.*)$/.exec(line);
			if (quote) {
				closeLists();
				if (!quoted) { html += '<blockquote>'; quoted = true; }
				html += quote[1].trim() ? renderInline(quote[1]) + '<br />' : '<br />';
				continue;
			}
			closeQuote();

			if (HR.test(line) && !stack.length) {
				closeLists();
				html += '<hr />';
				continue;
			}

			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			if (heading) {
				closeLists();
				html += `<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`;
				continue;
			}

			const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
			const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
			if (bullet || numbered) {
				const m = /** @type {RegExpExecArray} */ (bullet ?? numbered);
				const indent = m[1].replace(/\t/g, '    ').length;
				const tag = bullet ? 'ul' : 'ol';
				const content = bullet ? m[2] : m[3];
				// A shallower indent closes back to that level; a deeper one opens a nested
				// list inside the item that is still open above it.
				closeLists(indent);
				let top = stack[stack.length - 1];
				if (!top || top.indent < indent) {
					// `start` keeps a list that begins at 3. from being silently renumbered to 1.
					const start = !bullet && m[2] !== '1' ? ` start="${Number(m[2])}"` : '';
					html += `<${tag}${start}>`;
					stack.push({ indent, tag, liOpen: false });
				} else if (top.tag !== tag) {
					// A bullet list where a numbered one was open (or the reverse) is a new list.
					html += `${top.liOpen ? '</li>' : ''}</${top.tag}><${tag}>`;
					stack.pop();
					stack.push({ indent, tag, liOpen: false });
				}
				top = /** @type {{ indent: number, tag: 'ul' | 'ol', liOpen: boolean }} */ (stack[stack.length - 1]);
				if (top.liOpen) {
					html += '</li>';
				}
				// Task list items render as a real (disabled) checkbox — a plain `[x]` in the
				// text is how a checklist looks when nobody implemented it.
				const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
				if (task) {
					const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
					html += `<li class="task"><input type="checkbox" disabled${checked} />${renderInline(task[2])}`;
				} else {
					html += `<li>${renderInline(content)}`;
				}
				top.liOpen = true;
				continue;
			}

			// A plain line while a list is open and indented under it is that item's
			// continuation, not a paragraph that should close the list.
			if (stack.length && /^\s{2,}\S/.test(line)) {
				html += renderInline(line.trim()) + '<br />';
				continue;
			}
			closeLists();
			if (line.trim() === '') {
				html += '<br />';
			} else {
				html += renderInline(line) + '<br />';
			}
		}
		closeLists();
		closeQuote();
		return html;
	}

	/**
	 * Renders prose: fenced code blocks verbatim, everything else through renderBlocks.
	 * An unterminated fence — the normal state of a streaming answer — is rendered as code
	 * to its end, so a block does not flip between prose and code as it arrives.
	 * @param {string} text
	 */
	function renderProse(text) {
		const parts = String(text).split(/```/);
		let html = '';
		for (let i = 0; i < parts.length; i++) {
			if (i % 2 === 1) {
				const block = parts[i];
				const nl = block.indexOf('\n');
				let code = block;
				let language = '';
				if (nl !== -1 && /^[a-zA-Z0-9+#._-]*$/.test(block.slice(0, nl).trim())) {
					language = block.slice(0, nl).trim();
					code = block.slice(nl + 1);
				}
				// The language is kept on the element (rather than dropped as it was) so the
				// Copy/Insert bar and any later highlighting have something to key off.
				const attr = language ? ` class="language-${escapeHtml(language)}" data-language="${escapeHtml(language)}"` : '';
				html += `<pre><code${attr}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
			} else if (parts[i]) {
				// An empty prose segment is not a blank line: it is the gap before a message
				// that opens with a fence, or after one that ends with it, and renderBlocks
				// turns '' into a `<br />` that showed up as a stray gap above every such block.
				html += renderBlocks(parts[i]);
			}
		}
		return html;
	}

	/**
	 * Renders one reasoning block as a collapsed disclosure. A run's thinking is routinely
	 * many times longer than its answer, so inlining it buries the thing the user asked
	 * for; the summary line is all that shows until they open it.
	 * @param {string} inner
	 * @param {number} index
	 */
	function renderThinking(inner, index) {
		const stamp = THINK_DURATION.exec(inner);
		const body = stamp ? inner.slice(0, stamp.index) : inner;
		const label = stamp ? `Thought for ${stamp[1]}s` : 'Thinking…';
		return `<details class="thinking" data-think="${index}">`
			+ `<summary><svg class="thor-glyph bolt still" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">`
			+ `<path fill="currentColor" d="${THOR_BOLT_PATH}"/></svg> ${escapeHtml(label)}</summary>`
			+ `<div class="thinking-body">${renderProse(body)}</div></details>`;
	}

	/**
	 * Renders assistant text, splitting out reasoning blocks first. That split has to come
	 * before the code-fence pass: reasoning frequently contains ``` of its own, which would
	 * otherwise pair with a fence in the answer and swallow the text between them.
	 * @param {string} text
	 */
	function render(text) {
		let rest = String(text);
		let html = '';
		// An empty segment is not blank prose: renderBlocks turns '' into a <br />, so the
		// usual case — reasoning opening the turn, with nothing before it — used to render a
		// stray line break above the block and another below every closed one.
		for (let i = 0; ; i++) {
			const open = rest.indexOf(THINK_OPEN);
			if (open === -1) {
				return html + (rest ? renderProse(rest) : '');
			}
			if (open > 0) { html += renderProse(rest.slice(0, open)); }
			const after = rest.slice(open + THINK_OPEN.length);
			const close = after.indexOf(THINK_CLOSE);
			// No closing marker yet: the block is still streaming (or the stream died in it).
			html += renderThinking(close === -1 ? after : after.slice(0, close), i);
			if (close === -1) {
				return html;
			}
			rest = after.slice(close + THINK_CLOSE.length);
		}
	}

	// @ts-ignore — the webview's own namespace, consumed by main.js and the renderer tests.
	globalThis.OpenVSMarkdown = { render, escapeHtml, THOR_BOLT_PATH };
}());
