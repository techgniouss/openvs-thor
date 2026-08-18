/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
/**
 * The agent's two blocking channels to the user, rendered as cards in the transcript:
 * approval requests (`write`/`command`/`mcp`) and `ask_user` questions.
 *
 * Split out of main.js and given its dependencies as arguments so it can be driven by
 * `scripts/test-prompt-cards.mjs` against a small DOM stand-in — main.js is one large
 * IIFE that reaches for a live workbench on load, so nothing inside it can be exercised
 * directly. These cards are the one part of the webview where a silent failure doesn't
 * just look wrong, it strands an agent run waiting for an answer.
 *
 * Two deliberate constraints keep that testable and safe:
 *   * every node is built with createElement/textContent — no innerHTML, so no escaping
 *     to get wrong on text that comes from a model,
 *   * child nodes are kept as direct references — no querySelector, so the stand-in
 *     needs no selector engine to be faithful.
 */
(function () {
	'use strict';

	/** @typedef {{ label: string, description?: string }} AskOption */
	/**
	 * A prompt the host is waiting on. `chosen` is scratch state for a multi-select,
	 * stored here rather than in a closure so a card survives being re-rendered when the
	 * user switches chat tabs and back.
	 * @typedef {{ id: string, type: string, sessionId?: string, title?: string, detail?: string,
	 *   preview?: string, previewLanguage?: string, question?: string, options?: AskOption[],
	 *   multiSelect?: boolean, chosen?: string[] }} PromptRequest
	 */

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
	 * A single-line text input. Separate from {@link el} so `.value` is typed.
	 * @param {string} className
	 * @param {string} placeholder
	 * @returns {HTMLInputElement}
	 */
	function textInput(className, placeholder) {
		const node = /** @type {HTMLInputElement} */ (el('input', className));
		node.setAttribute('type', 'text');
		node.setAttribute('placeholder', placeholder);
		return node;
	}

	/**
	 * Creates the prompt-card controller.
	 *
	 * @param {{
	 *   container: { appendChild(node: any): void },
	 *   post: (message: any) => void,
	 *   scroll?: () => void,
	 *   activeSessionId?: () => string,
	 * }} deps
	 */
	function create(deps) {
		const scroll = deps.scroll || (() => { });
		/**
		 * Unanswered requests, keyed by prompt id, each with the node currently showing it.
		 * Holding the request (not just the node) is what lets a card be redrawn after the
		 * transcript is rebuilt; holding the node is what lets it be retired without a
		 * DOM query.
		 * @type {Map<string, { request: PromptRequest, card: any }>}
		 */
		const open = new Map();

		/**
		 * Retires a card in place, leaving a one-line record of the outcome.
		 * @param {string} id
		 * @param {string} summary
		 * @param {string} stateClass
		 */
		function retire(id, summary, stateClass) {
			const entry = open.get(id);
			if (!entry) { return false; }
			open.delete(id);
			const { card } = entry;
			card.classList.remove('prompt-open');
			card.classList.add(stateClass);
			card.textContent = '';
			card.appendChild(el('div', 'prompt-resolved', summary));
			return true;
		}

		/**
		 * Sends the user's decision to the host and retires the card. Guarded by the
		 * `open` lookup so a double click can't answer the same prompt twice — the host
		 * discards the second reply, but the card would still lie about the outcome.
		 * @param {string} id
		 * @param {Record<string, unknown>} response
		 * @param {string} summary
		 */
		function answer(id, response, summary) {
			if (!retire(id, summary, 'prompt-answered')) { return; }
			deps.post({ type: 'promptResponse', promptId: id, response });
			scroll();
		}

		/** @param {PromptRequest} request */
		function shell(request, className) {
			const card = el('div', `prompt-card prompt-open ${className}`);
			card.setAttribute('data-prompt-id', request.id);
			open.set(request.id, { request, card });
			deps.container.appendChild(card);
			return card;
		}

		/** @param {PromptRequest} request */
		function renderApproval(request) {
			const card = shell(request, 'prompt-approval');
			card.appendChild(el('div', 'prompt-title', request.title || 'Allow this action?'));
			if (request.detail) {
				card.appendChild(el('div', 'prompt-detail', request.detail));
			}
			if (request.preview) {
				const pre = el('pre', `prompt-preview prompt-lang-${request.previewLanguage || 'text'}`, request.preview);
				card.appendChild(pre);
			}
			const actions = el('div', 'prompt-actions');
			const feedback = textInput('prompt-feedback', 'Optional: tell the agent what to do instead…');

			/** @param {'allow'|'always'|'deny'} act */
			const decide = act => answer(
				request.id,
				{ approved: act !== 'deny', always: act === 'always', feedback: String(feedback.value || '').trim() },
				act === 'deny' ? '✕ Denied' : act === 'always' ? '✓ Allowed (and for the rest of this run)' : '✓ Allowed',
			);

			for (const [act, label, extra] of /** @type {[('allow'|'always'|'deny'), string, string][]} */ ([
				['allow', 'Allow', 'prompt-primary'],
				['always', 'Allow for this run', ''],
				['deny', 'Deny', 'prompt-deny'],
			])) {
				const button = el('button', `prompt-btn ${extra}`.trim(), label);
				button.setAttribute('data-act', act);
				button.addEventListener('click', () => decide(act));
				actions.appendChild(button);
			}
			card.appendChild(actions);
			// Enter in the feedback box denies: the text only changes that answer, and
			// giving a reason is precisely why someone types there.
			feedback.addEventListener('keydown', e => {
				if (e.key === 'Enter') { e.preventDefault?.(); decide('deny'); }
			});
			card.appendChild(feedback);
			scroll();
			return card;
		}

		/** @param {PromptRequest} request */
		function renderAsk(request) {
			const card = shell(request, 'prompt-ask');
			const options = Array.isArray(request.options) ? request.options : [];
			const multi = !!request.multiSelect;
			card.appendChild(el('div', 'prompt-title', `🙋 ${request.question || 'The agent has a question'}`));
			if (request.detail) {
				card.appendChild(el('div', 'prompt-detail', request.detail));
			}
			if (multi) {
				card.appendChild(el('div', 'prompt-detail', 'Pick as many as apply, then Send.'));
			}

			const answerBox = textInput('prompt-answer', '…or type your own answer');
			/** @type {Set<string>} */
			const chosen = new Set(Array.isArray(request.chosen) ? request.chosen : []);
			/** @type {{ label: string, button: any }[]} */
			const buttons = [];

			const syncChoices = () => {
				request.chosen = [...chosen];
				answerBox.value = request.chosen.join(', ');
				for (const { label, button } of buttons) {
					button.classList.toggle('prompt-option-on', chosen.has(label));
				}
			};
			/** @param {string} text */
			const submit = text => {
				const value = String(text || '').trim();
				if (!value) { return; }
				answer(request.id, { answer: value }, `🙋 ${value}`);
			};

			const list = el('div', 'prompt-options');
			for (const option of options) {
				const label = String(option && option.label || '');
				if (!label) { continue; }
				const button = el('button', 'prompt-option');
				button.appendChild(el('span', 'prompt-option-label', label));
				if (option.description) {
					button.appendChild(el('span', 'prompt-option-desc', String(option.description)));
				}
				button.addEventListener('click', () => {
					if (!multi) { return submit(label); }
					// Multi-select accumulates into the text box so the answer stays
					// editable before it is sent.
					if (chosen.has(label)) { chosen.delete(label); } else { chosen.add(label); }
					syncChoices();
				});
				buttons.push({ label, button });
				list.appendChild(button);
			}
			card.appendChild(list);

			const actions = el('div', 'prompt-actions');
			actions.appendChild(answerBox);
			const send = el('button', 'prompt-btn prompt-primary', 'Send');
			send.setAttribute('data-act', 'send');
			send.addEventListener('click', () => submit(answerBox.value));
			actions.appendChild(send);
			card.appendChild(actions);
			answerBox.addEventListener('keydown', e => {
				if (e.key === 'Enter') { e.preventDefault?.(); submit(answerBox.value); }
			});
			if (chosen.size) { syncChoices(); }
			scroll();
			return card;
		}

		return {
			/**
			 * Draws the card for a request and starts waiting on it.
			 * @param {PromptRequest} request
			 */
			render(request) {
				return request.type === 'askRequest' ? renderAsk(request) : renderApproval(request);
			},
			/**
			 * Records a request without drawing it — used when it belongs to a chat tab
			 * that isn't on screen, so {@link reattach} can draw it later.
			 * @param {PromptRequest} request
			 */
			track(request) {
				if (!open.has(request.id)) {
					open.set(request.id, { request, card: undefined });
				}
			},
			/**
			 * Redraws every unanswered card belonging to `sessionId`. Called after the
			 * transcript is rebuilt, which throws away the previous nodes.
			 * @param {string} sessionId
			 */
			reattach(sessionId) {
				for (const { request } of [...open.values()]) {
					if (request.sessionId === sessionId) {
						open.delete(request.id);
						this.render(request);
					}
				}
			},
			/**
			 * The prompt can no longer be answered here. `reason` distinguishes why: a run
			 * that was stopped (the default, and every reason but the one below) vs. a reply
			 * that arrived from another sink first — first-answer-wins, so this one lost the
			 * race rather than being cancelled outright.
			 * @param {string} id
			 * @param {string} [reason]
			 */
			cancel(id, reason) {
				const summary = reason === 'answered'
					? '✓ Answered on another device.'
					: '✕ Cancelled — the run was stopped.';
				retire(id, summary, 'prompt-answered');
			},
			/** @param {string} id */
			has(id) { return open.has(id); },
			/** How many prompts are still waiting; used by the tests. */
			size() { return open.size; },
		};
	}

	// @ts-ignore — the webview's own namespace, consumed by main.js and the card tests.
	globalThis.OpenVSPrompts = { create };
}());
