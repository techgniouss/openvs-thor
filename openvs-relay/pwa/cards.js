// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Approval / ask_user card rendering for the PWA — a port of
// `extensions/openvs-chat/media/prompts.js`'s shape (same reply fields: `approved`/`always`/
// `feedback` for an approval, `answer` for a question) and the same no-`innerHTML` discipline,
// so a future contract check can compare the two the way `test-prompt-cards.mjs` does for the
// real extension. Deliberately simpler than `prompts.js`: no multi-select accumulation UI, no
// preview syntax highlighting — a phone screen answering "allow / deny / type an answer" is the
// whole job here.
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

/** @typedef {{ label: string, description?: string }} AskOption */
/**
 * @typedef {{ id: string, type: string, sessionId?: string, title?: string, detail?: string,
 *   preview?: string, previewLanguage?: string, question?: string, options?: AskOption[] }} PromptRequest
 */

/**
 * Creates the prompt-card controller. Mirrors `prompts.js`'s `create(deps)` shape.
 * @param {{ container: { appendChild(node: any): void }, post: (message: any) => void }} deps
 */
export function create(deps) {
	/** @type {Map<string, { request: PromptRequest, card: any }>} */
	const open = new Map();

	/**
	 * @param {string} id
	 * @param {string} summary
	 */
	function retire(id, summary) {
		const entry = open.get(id);
		if (!entry) { return false; }
		open.delete(id);
		const { card } = entry;
		card.classList.remove('prompt-open');
		card.classList.add('prompt-answered');
		card.replaceChildren();
		card.appendChild(el('div', 'prompt-resolved', summary));
		return true;
	}

	/**
	 * @param {string} id
	 * @param {Record<string, unknown>} response
	 * @param {string} summary
	 */
	function answer(id, response, summary) {
		if (!retire(id, summary)) { return; }
		deps.post({ type: 'promptResponse', promptId: id, response });
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
			card.appendChild(el('pre', 'prompt-preview', request.preview));
		}
		const actions = el('div', 'prompt-actions');
		for (const [act, label] of /** @type {['allow'|'always'|'deny', string][]} */ ([
			['allow', 'Allow'],
			['always', 'Allow for run'],
			['deny', 'Deny'],
		])) {
			const button = el('button', `prompt-btn prompt-${act}`, label);
			button.addEventListener('click', () => answer(
				request.id,
				{ approved: act !== 'deny', always: act === 'always', feedback: '' },
				act === 'deny' ? '✕ Denied' : '✓ Allowed',
			));
			actions.appendChild(button);
		}
		card.appendChild(actions);
		return card;
	}

	/** @param {PromptRequest} request */
	function renderAsk(request) {
		const card = shell(request, 'prompt-ask');
		card.appendChild(el('div', 'prompt-title', `🙋 ${request.question || 'The agent has a question'}`));
		if (request.detail) {
			card.appendChild(el('div', 'prompt-detail', request.detail));
		}
		const options = Array.isArray(request.options) ? request.options : [];
		if (options.length) {
			const list = el('div', 'prompt-options');
			for (const option of options) {
				const label = String((option && option.label) || '');
				if (!label) { continue; }
				const button = el('button', 'prompt-option', label);
				button.addEventListener('click', () => answer(request.id, { answer: label }, `🙋 ${label}`));
				list.appendChild(button);
			}
			card.appendChild(list);
		}
		const answerBox = /** @type {HTMLInputElement} */ (el('input', 'prompt-answer'));
		answerBox.setAttribute('type', 'text');
		answerBox.setAttribute('placeholder', 'Type your answer…');
		const send = el('button', 'prompt-btn prompt-primary', 'Send');
		const submit = () => {
			const value = String(answerBox.value || '').trim();
			if (!value) { return; }
			answer(request.id, { answer: value }, `🙋 ${value}`);
		};
		send.addEventListener('click', submit);
		answerBox.addEventListener('keydown', e => {
			if (e.key === 'Enter') { submit(); }
		});
		const actions = el('div', 'prompt-actions');
		actions.appendChild(answerBox);
		actions.appendChild(send);
		card.appendChild(actions);
		return card;
	}

	return {
		/** @param {PromptRequest} request */
		render(request) {
			return request.type === 'askRequest' ? renderAsk(request) : renderApproval(request);
		},
		/**
		 * @param {string} id
		 * @param {string} [reason]
		 */
		cancel(id, reason) {
			const summary = reason === 'answered' ? '✓ Answered on another device.' : '✕ Cancelled — the run was stopped.';
			retire(id, summary);
		},
		/** @param {string} id */
		has(id) { return open.has(id); },
		size() { return open.size; },
	};
}
