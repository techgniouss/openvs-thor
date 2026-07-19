// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

(function () {
	const vscode = acquireVsCodeApi();

	/**
	 * True when this webview is the detached Settings editor tab (see `openSettingsWindow`
	 * in chatViewProvider). The same UI serves both surfaces; this flag hides the chat
	 * chrome and pins the settings panel open so it fills the editor column.
	 */
	const SETTINGS_ONLY = !!(/** @type {any} */ (window).__OPENVS_SETTINGS_ONLY__);

	/** Sentinel provider id for the role-routed Auto pipeline (mirrors chatViewProvider). */
	const AUTO_PROVIDER = '__auto__';
	const ROLE_LABELS = { plan: 'Planning', code: 'Implementation', review: 'Review' };

	/** Agent approval levels (mirrors `openvsChat.guardrails.approval`), most permissive first. */
	const APPROVAL_OPTIONS = [
		{ value: 'yolo', label: '⚡ Full Auto', desc: 'Never asks — the agent edits files and runs commands on its own. Hard guardrails (protected paths, denied commands, workspace confinement) still apply.' },
		{ value: 'auto-edits', label: '🛡 Default', desc: 'Auto-approves file edits inside the workspace; asks before running commands.' },
		{ value: 'auto-readonly', label: '🛡 Reads Free', desc: 'Read-only tools run freely; asks before any file write or command.' },
		{ value: 'always', label: '🛡 Always Ask', desc: 'Asks before every file write and command (safest).' },
	];

	/**
	 * @typedef {{ role: 'user'|'assistant', content: string, images?: {mimeType:string,data:string}[], kind?: 'info'|'error' }} Msg
	 * @typedef {{ id: string, title: string, messages: Msg[], streaming: boolean, pending: string|null, queue: string[], runMode?: string }} Session
	 */
	/** All chat tabs. Each can stream independently; only the active one is rendered. @type {Session[]} */
	let sessions = [];
	let activeSessionId = '';
	/** @type {{mimeType:string,data:string}[]} pending image attachments for the next send */
	let pendingImages = [];
	const MAX_IMAGE_DIM = 1568; // Claude's own internal long-edge cap; a sane default everywhere.
	const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
	const MAX_IMAGES_PER_MESSAGE = 5;
	/** @type {any[]} */
	let providers = [];
	let selectedProvider = '';
	let mode = 'ask';
	/** @type {{ roles: any[], reviewEnabled: boolean }} */
	let autoConfig = { roles: [], reviewEnabled: true };
	/** Current agent approval level (synced from `openvsChat.guardrails.approval`). */
	let approval = 'auto-edits';
	/** @type {{ label: string, content: string } | null} */
	let currentContext = null;
	/** The DOM bubble of the active session's in-flight assistant turn (model of record is `session.pending`). */
	/** @type {HTMLElement | null} */
	let activeAssistantBody = null;
	/** @type {Map<string, { wrap: HTMLElement, out: HTMLElement }>} running tool blocks (active session only), keyed by call id */
	const toolEls = new Map();
	let toolSeq = 0;

	function newSessionId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
	/** The active session (always exists after init). */
	function cur() { return sessions.find(s => s.id === activeSessionId) || sessions[0]; }
	function sessionFor(msg) { return sessions.find(s => s.id === msg.sessionId) || cur(); }

	/** Known todo statuses; anything else from the host falls back to 'pending'. */
	const TODO_STATUSES = ['pending', 'in_progress', 'completed'];

	/** Renders the agent's task checklist for the active session (hidden when empty). */
	function renderTodos() {
		let panel = document.getElementById('todoPanel');
		if (!panel) {
			panel = document.createElement('div');
			panel.id = 'todoPanel';
			panel.className = 'todo-panel hidden';
			els.messages.parentElement.insertBefore(panel, els.messages);
		}
		const items = (cur() && cur().todos) || [];
		if (!items.length) {
			panel.classList.add('hidden');
			panel.innerHTML = '';
			return;
		}
		const icon = s => s === 'completed' ? '●' : s === 'in_progress' ? '◐' : '○';
		panel.innerHTML = '<div class="todo-title">Tasks</div>' + items.map(t => {
			const status = TODO_STATUSES.includes(t.status) ? t.status : 'pending';
			return `<div class="todo-item todo-${status}"><span class="todo-icon">${icon(status)}</span>${escapeHtml(t.content)}</div>`;
		}).join('');
		panel.classList.remove('hidden');
	}

	const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
	const els = {
		modeSelect: /** @type {HTMLSelectElement} */ ($('modeSelect')),
		approvalSelect: /** @type {HTMLSelectElement} */ ($('approvalSelect')),
		approvalList: $('approvalList'),
		providerSelect: /** @type {HTMLSelectElement} */ ($('providerSelect')),
		modelSelect: /** @type {HTMLSelectElement} */ ($('modelSelect')),
		autoSummary: $('autoSummary'),
		refreshModels: $('refreshModels'),
		settingsButton: $('settingsButton'),
		settingsPanel: $('settingsPanel'),
		closeSettings: $('closeSettings'),
		providerList: $('providerList'),
		autoRoutingList: $('autoRoutingList'),
		enableReview: /** @type {HTMLInputElement} */ ($('enableReview')),
		messages: $('messages'),
		contextChip: $('contextChip'),
		imageChips: $('imageChips'),
		attachButton: $('attachButton'),
		input: /** @type {HTMLTextAreaElement} */ ($('input')),
		enhanceButton: /** @type {HTMLButtonElement} */ ($('enhanceButton')),
		sendButton: /** @type {HTMLButtonElement} */ ($('sendButton')),
		stopButton: /** @type {HTMLButtonElement} */ ($('stopButton')),
		skillChip: $('skillChip'),
		queueChips: $('queueChips'),
		skillList: $('skillList'),
		newSkill: $('newSkill'),
		mcpList: $('mcpList'),
		mcpAdd: $('mcpAdd'),
		mcpReconnectBtn: $('mcpReconnectBtn'),
		mcpOpenConfig: $('mcpOpenConfig'),
		historyButton: $('historyButton'),
		historyPanel: $('historyPanel'),
		closeHistory: $('closeHistory'),
		historyList: $('historyList'),
	};
	/** @type {{id:string,name:string,description:string}[]} */
	let skillsList = [];
	/** Ids of all currently active skills (multiple can be active at once). */
	let activeSkills = [];
	let enhancing = false;

	/**
	 * Closed conversations, newest first: `{ id, title, messages, savedAt }`. Persisted
	 * in webview state (survives reloads and restarts) and shown in the History panel
	 * and the empty-state "Recent chats" list.
	 * @type {{id:string,title:string,messages:Msg[],savedAt:number}[]}
	 */
	let history = [];
	const HISTORY_LIMIT = 50;

	const persisted = vscode.getState();
	if (persisted) {
		if (Array.isArray(persisted.history)) {
			history = persisted.history;
		}
		// 'edit' was replaced by 'plan' as the middle mode; migrate stale persisted state.
		mode = persisted.mode === 'edit' ? 'plan' : (persisted.mode || 'ask');
		selectedProvider = persisted.selectedProvider || '';
		if (Array.isArray(persisted.sessions) && persisted.sessions.length) {
			sessions = persisted.sessions.map(s => ({
				id: s.id || newSessionId(),
				title: s.title || '',
				messages: Array.isArray(s.messages) ? s.messages : [],
				streaming: false,
				pending: null,
				queue: Array.isArray(s.queue) ? s.queue : [],
			}));
			activeSessionId = sessions.some(s => s.id === persisted.activeSessionId)
				? persisted.activeSessionId
				: sessions[0].id;
		} else if (Array.isArray(persisted.messages) && persisted.messages.length) {
			// Migrate the single-conversation state from before chat tabs existed.
			const s = { id: newSessionId(), title: '', messages: persisted.messages, streaming: false, pending: null, queue: [] };
			sessions = [s];
			activeSessionId = s.id;
		}
	}
	if (!sessions.length) {
		const s = { id: newSessionId(), title: '', messages: [], streaming: false, pending: null, queue: [] };
		sessions = [s];
		activeSessionId = s.id;
	}
	function saveState() {
		vscode.setState({
			sessions: sessions.map(s => ({ id: s.id, title: s.title, messages: s.messages, queue: s.queue })),
			activeSessionId,
			mode,
			selectedProvider,
			history,
		});
	}

	// ---- Markdown ---------------------------------------------------------------

	function escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}
	function renderInline(text) {
		let chunk = escapeHtml(text);
		chunk = chunk.replace(/`([^`]+)`/g, '<code>$1</code>');
		chunk = chunk.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		chunk = chunk.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
		return chunk;
	}
	/** Renders a non-code segment with headings, bullet/numbered lists and paragraphs. */
	function renderBlocks(text) {
		const lines = String(text).split('\n');
		let html = '';
		let list = null; // 'ul' | 'ol'
		const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
		for (const line of lines) {
			const heading = /^(#{1,3})\s+(.*)$/.exec(line);
			const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
			const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
			if (heading) {
				closeList();
				const level = heading[1].length;
				html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
			} else if (bullet) {
				if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
				html += `<li>${renderInline(bullet[1])}</li>`;
			} else if (numbered) {
				if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
				html += `<li>${renderInline(numbered[1])}</li>`;
			} else if (line.trim() === '') {
				closeList(); html += '<br />';
			} else {
				closeList(); html += renderInline(line) + '<br />';
			}
		}
		closeList();
		return html;
	}
	function renderMarkdown(text) {
		const parts = String(text).split(/```/);
		let html = '';
		for (let i = 0; i < parts.length; i++) {
			if (i % 2 === 1) {
				const block = parts[i];
				const nl = block.indexOf('\n');
				let code = block;
				if (nl !== -1 && /^[a-zA-Z0-9+#._-]*$/.test(block.slice(0, nl).trim())) {
					code = block.slice(nl + 1);
				}
				html += `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
			} else {
				html += renderBlocks(parts[i]);
			}
		}
		return html;
	}
	/** Adds Copy / Insert action buttons above each finalized code block. */
	function enhanceCodeBlocks(container) {
		for (const pre of container.querySelectorAll('pre')) {
			if (pre.dataset.enhanced) { continue; }
			pre.dataset.enhanced = '1';
			const code = pre.querySelector('code');
			if (!code) { continue; }
			const bar = document.createElement('div');
			bar.className = 'code-actions';
			const copyBtn = document.createElement('button');
			copyBtn.textContent = 'Copy';
			const insertBtn = document.createElement('button');
			insertBtn.textContent = 'Insert';
			bar.appendChild(copyBtn);
			bar.appendChild(insertBtn);
			copyBtn.addEventListener('click', () => {
				const text = code.textContent || '';
				try {
					navigator.clipboard?.writeText(text);
					copyBtn.textContent = 'Copied';
					setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
				} catch { /* clipboard may be unavailable */ }
			});
			insertBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'insertAtCursor', content: code.textContent || '' });
			});
			pre.parentNode?.insertBefore(bar, pre);
		}
	}

	// ---- Messages ---------------------------------------------------------------

	/** Quick-start suggestions shown on the empty chat; clicking one primes the composer. */
	const EMPTY_SUGGESTIONS = [
		{ icon: '💡', label: 'Explain my open file', mode: 'ask', prompt: 'Explain what the file I have open does, and how its pieces fit together.' },
		{ icon: '🧭', label: 'Plan a feature', mode: 'plan', prompt: 'Plan how to add ' },
		{ icon: '🤖', label: 'Let the agent fix something', mode: 'agent', prompt: 'Find and fix ' },
		{ icon: '⚡', label: 'See all commands', mode: '', prompt: '/help' },
	];

	function renderAll() {
		const s = cur();
		els.messages.innerHTML = '';
		activeAssistantBody = null;
		toolEls.clear();
		renderTodos();
		const isEmpty = s.messages.length === 0 && s.pending == null;
		els.messages.classList.toggle('is-empty', isEmpty);
		if (isEmpty) {
			const empty = document.createElement('div');
			empty.className = 'empty';
			empty.innerHTML = `
				<div class="empty-orb">
					<svg viewBox="0 0 24 24" width="52" height="52" fill="none" aria-hidden="true">
						<path d="M6.5 3.75h11A3.75 3.75 0 0 1 21.25 7.5v6a3.75 3.75 0 0 1-3.75 3.75h-4.1l-3.72 2.98c-.44.35-1.08.04-1.08-.52v-2.46H6.5a3.75 3.75 0 0 1-3.75-3.75v-6A3.75 3.75 0 0 1 6.5 3.75Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
						<path class="spark" fill="currentColor" d="M12 6.7c.3 2.05 1.75 3.5 3.8 3.8-2.05.3-3.5 1.75-3.8 3.8-.3-2.05-1.75-3.5-3.8-3.8 2.05-.3 3.5-1.75 3.8-3.8Z"/>
					</svg>
				</div>
				<div class="empty-title">OpenVS Thor</div>
				<div class="empty-sub">Ask about your code, plan a change, or hand the whole task to the agent — powered by the provider and model you choose.</div>
				<div class="empty-chips"></div>
				<div class="empty-footnote">Add a provider key or sign in with the ⚙ button.</div>`;
			const chips = /** @type {HTMLElement} */ (empty.querySelector('.empty-chips'));
			for (const s of EMPTY_SUGGESTIONS) {
				const chip = document.createElement('button');
				chip.className = 'empty-chip';
				chip.innerHTML = `<span class="chip-icon">${s.icon}</span>${escapeHtml(s.label)}`;
				chip.addEventListener('click', () => {
					if (s.mode) { setMode(s.mode); }
					els.input.value = s.prompt;
					autoSize();
					els.input.focus();
					els.input.setSelectionRange(s.prompt.length, s.prompt.length);
				});
				chips.appendChild(chip);
			}
			// Previous conversations, right on the landing screen: click to reopen.
			if (history.length) {
				const recent = document.createElement('div');
				recent.className = 'empty-recent';
				const title = document.createElement('div');
				title.className = 'empty-recent-title';
				title.textContent = 'Recent chats';
				recent.appendChild(title);
				for (const h of history.slice(0, 6)) {
					const item = document.createElement('button');
					item.className = 'empty-recent-item';
					item.title = 'Reopen this conversation';
					item.innerHTML = `<span class="recent-name">${escapeHtml(h.title || 'Untitled chat')}</span><span class="recent-time">${escapeHtml(relTime(h.savedAt))}</span>`;
					item.addEventListener('click', () => restoreChat(h.id));
					recent.appendChild(item);
				}
				if (history.length > 6) {
					const more = document.createElement('button');
					more.className = 'empty-recent-more';
					more.textContent = `All ${history.length} chats…`;
					more.addEventListener('click', () => openHistoryPanel());
					recent.appendChild(more);
				}
				const footnote = empty.querySelector('.empty-footnote');
				empty.insertBefore(recent, footnote);
			}
			els.messages.appendChild(empty);
			return;
		}
		for (const m of s.messages) {
			const body = appendMessageEl(m.role, m.content, m.images);
			if (m.kind) { body.parentElement?.classList.add(m.kind); }
		}
		// Re-attach the in-flight assistant bubble when switching back to a streaming tab.
		if (s.pending != null) {
			activeAssistantBody = appendMessageEl('assistant', s.pending);
			activeAssistantBody.parentElement?.classList.add('streaming');
			if (s.pending === '') {
				startWorking(activeAssistantBody, s);
			}
		}
		scrollToBottom();
	}
	function appendMessageEl(role, content, images) {
		// The first real message replaces the empty-state hero.
		els.messages.querySelector('.empty')?.remove();
		els.messages.classList.remove('is-empty');
		const wrap = document.createElement('div');
		wrap.className = `message ${role}`;
		const roleEl = document.createElement('div');
		roleEl.className = 'role';
		roleEl.textContent = role === 'user' ? 'You' : 'Assistant';
		const body = document.createElement('div');
		body.className = 'body';
		body.innerHTML = renderMarkdown(content);
		if (images && images.length) {
			const gallery = document.createElement('div');
			gallery.className = 'message-images';
			for (const img of images) {
				const el = document.createElement('img');
				el.src = `data:${img.mimeType};base64,${img.data}`;
				gallery.appendChild(el);
			}
			body.insertBefore(gallery, body.firstChild);
		}
		enhanceCodeBlocks(body);
		wrap.appendChild(roleEl);
		wrap.appendChild(body);
		els.messages.appendChild(wrap);
		return body;
	}
	function appendToolEl(name, args) {
		const wrap = document.createElement('div');
		wrap.className = 'tool running';
		const head = document.createElement('div');
		head.className = 'tool-head';
		head.textContent = `🔧 ${name}(${summarizeArgs(args)})`;
		const out = document.createElement('pre');
		out.className = 'tool-out';
		out.textContent = '…';
		wrap.appendChild(head);
		wrap.appendChild(out);
		els.messages.appendChild(wrap);
		scrollToBottom();
		return { wrap, out };
	}
	function summarizeArgs(args) {
		try {
			const s = JSON.stringify(args);
			return s.length > 80 ? s.slice(0, 77) + '…' : s;
		} catch { return ''; }
	}
	function scrollToBottom() { els.messages.scrollTop = els.messages.scrollHeight; }

	/** Renders a notice bubble in the active session (no host round-trip). */
	function showNotice(message, isError) {
		addNotice(cur(), message, isError);
	}

	/**
	 * Records an info/error notice in a session's transcript (marked `kind` so it is
	 * never sent back to the model) and renders it when that session is on screen.
	 */
	function addNotice(s, text, isError) {
		const content = (isError ? '⚠️ ' : 'ℹ️ ') + text;
		s.messages.push({ role: 'assistant', content, kind: isError ? 'error' : 'info' });
		if (s.id === activeSessionId) {
			const body = appendMessageEl('assistant', content);
			body.parentElement?.classList.add(isError ? 'error' : 'info');
			scrollToBottom();
		}
		saveState();
	}

	// ---- Chat tabs ---------------------------------------------------------------

	const tabsEl = $('tabs');

	function createSession(activate = true) {
		const s = { id: newSessionId(), title: '', messages: [], streaming: false, pending: null, queue: [], todos: [] };
		sessions.push(s);
		if (activate) {
			activeSessionId = s.id;
			renderAll();
			updateComposer();
			els.input.focus();
		}
		renderTabs();
		saveState();
		return s;
	}

	function switchSession(id) {
		if (id === activeSessionId || !sessions.some(s => s.id === id)) { return; }
		activeSessionId = id;
		renderTabs();
		renderAll();
		updateComposer();
		saveState();
	}

	/** Human-friendly relative timestamp for history entries. */
	function relTime(ts) {
		if (!ts) { return ''; }
		const min = Math.floor((Date.now() - ts) / 60000);
		if (min < 1) { return 'just now'; }
		if (min < 60) { return `${min}m ago`; }
		const hr = Math.floor(min / 60);
		if (hr < 24) { return `${hr}h ago`; }
		const day = Math.floor(hr / 24);
		if (day < 7) { return `${day}d ago`; }
		return new Date(ts).toLocaleDateString();
	}

	/**
	 * Saves a session's conversation into history (skips empty / notice-only chats).
	 * Image attachments are dropped from the archived copy: base64 payloads would bloat
	 * the persisted state (which is re-serialized on every save) by megabytes per chat.
	 */
	function archiveSession(s) {
		if (!s.messages.some(m => !m.kind)) { return; }
		history = history.filter(h => h.id !== s.id);
		history.unshift({
			id: s.id,
			title: s.title || (s.messages.find(m => m.role === 'user' && !m.kind)?.content || 'Untitled chat').slice(0, 28),
			messages: s.messages.map(m => m.images?.length
				? { role: m.role, content: `🖼 (image attachment not kept in history)\n${m.content}`, kind: m.kind }
				: m),
			savedAt: Date.now(),
		});
		if (history.length > HISTORY_LIMIT) { history.length = HISTORY_LIMIT; }
		syncHistory();
	}

	/**
	 * Mirrors history to the extension host (workspace state) so saved conversations
	 * reliably survive window reloads and full editor restarts.
	 */
	function syncHistory() {
		vscode.postMessage({ type: 'saveHistory', history });
	}

	/** Merges the host's persisted history with local state (newest copy of each chat wins). */
	function mergeHistory(incoming) {
		const byId = new Map();
		for (const h of [...incoming, ...history]) {
			if (!h || !h.id) { continue; }
			const prev = byId.get(h.id);
			if (!prev || (h.savedAt || 0) > (prev.savedAt || 0)) { byId.set(h.id, h); }
		}
		history = [...byId.values()].sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, HISTORY_LIMIT);
		saveState();
		syncHistory();
	}

	/** Reopens a saved conversation from history as a live tab. */
	function restoreChat(id) {
		const index = history.findIndex(h => h.id === id);
		if (index === -1) { return; }
		const item = history.splice(index, 1)[0];
		syncHistory();
		const s = { id: item.id, title: item.title, messages: item.messages, streaming: false, pending: null, queue: [], todos: [] };
		sessions.push(s);
		activeSessionId = s.id;
		els.historyPanel.classList.add('hidden');
		renderTabs(); renderAll(); updateComposer(); saveState();
		els.input.focus();
	}

	function closeSession(id) {
		const index = sessions.findIndex(s => s.id === id);
		if (index === -1) { return; }
		// Stop any run still streaming in that tab before dropping it.
		if (sessions[index].streaming) {
			vscode.postMessage({ type: 'stop', sessionId: id });
		}
		// Closing never loses a conversation: it moves to History (🕘) instead.
		archiveSession(sessions[index]);
		sessions.splice(index, 1);
		if (!sessions.length) {
			createSession();
			return;
		}
		if (activeSessionId === id) {
			activeSessionId = sessions[Math.min(index, sessions.length - 1)].id;
			renderAll();
			updateComposer();
		}
		renderTabs();
		saveState();
	}

	function renderTabs() {
		if (!tabsEl) { return; }
		tabsEl.innerHTML = '';
		for (const s of sessions) {
			const tab = document.createElement('div');
			tab.className = 'chat-tab' + (s.id === activeSessionId ? ' active' : '') + (s.streaming ? ' busy' : '');
			tab.title = s.title || 'New chat';
			tab.innerHTML = `<span class="tab-dot"></span><span class="tab-title">${escapeHtml(s.title || 'New chat')}</span>`
				+ '<a class="tab-close" href="#" title="Close chat (saved to History)">✕</a>';
			tab.addEventListener('click', () => switchSession(s.id));
			tab.querySelector('.tab-close')?.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				closeSession(s.id);
			});
			tabsEl.appendChild(tab);
		}
		const add = document.createElement('button');
		add.className = 'tab-add';
		add.title = 'New chat (runs in parallel)';
		add.textContent = '+';
		add.addEventListener('click', () => createSession());
		tabsEl.appendChild(add);
	}

	/**
	 * Reads a pasted image File, downscales it to at most MAX_IMAGE_DIM on its long edge,
	 * re-encodes as JPEG, and resolves a base64 payload ready to attach to a message.
	 * Rejects if the result is still over MAX_IMAGE_BYTES.
	 * @param {File} file
	 * @returns {Promise<{mimeType: string, data: string}>}
	 */
	function resizeImage(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(reader.error || new Error('Failed to read image.'));
			reader.onload = () => {
				const img = new Image();
				img.onerror = () => reject(new Error('Failed to decode image.'));
				img.onload = () => {
					let width = img.naturalWidth;
					let height = img.naturalHeight;
					const longEdge = Math.max(width, height);
					if (longEdge > MAX_IMAGE_DIM) {
						const scale = MAX_IMAGE_DIM / longEdge;
						width = Math.round(width * scale);
						height = Math.round(height * scale);
					}
					const canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext('2d');
					if (!ctx) { reject(new Error('Canvas unavailable.')); return; }
					ctx.drawImage(img, 0, 0, width, height);
					const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
					const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
					const approxBytes = base64.length * 0.75;
					if (approxBytes > MAX_IMAGE_BYTES) {
						reject(new Error('Image is too large even after resizing (over 5MB). Try a smaller image.'));
						return;
					}
					resolve({ mimeType: 'image/jpeg', data: base64 });
				};
				img.src = /** @type {string} */ (reader.result);
			};
			reader.readAsDataURL(file);
		});
	}

	/** Renders the pending-attachment chips above the composer. */
	function renderImageChips() {
		els.imageChips.innerHTML = '';
		if (!pendingImages.length) {
			els.imageChips.classList.add('hidden');
			return;
		}
		els.imageChips.classList.remove('hidden');
		pendingImages.forEach((img, index) => {
			const chip = document.createElement('span');
			chip.className = 'image-chip';
			const thumb = document.createElement('img');
			thumb.src = `data:${img.mimeType};base64,${img.data}`;
			const remove = document.createElement('a');
			remove.href = '#';
			remove.textContent = '✕';
			remove.addEventListener('click', (e) => {
				e.preventDefault();
				pendingImages.splice(index, 1);
				renderImageChips();
			});
			chip.appendChild(thumb);
			chip.appendChild(remove);
			els.imageChips.appendChild(chip);
		});
	}

	// ---- Providers / models -----------------------------------------------------

	function currentProvider() { return providers.find(p => p.id === selectedProvider); }

	/**
	 * Mirrors entrySupportsTools() in src/providers/types.ts — keep them in sync.
	 * Prefers the provider catalog's own capability report (fetched model metadata)
	 * over the heuristic patterns.
	 */
	function modelSupportsTools(provider, model) {
		if (!provider || !provider.supportsTools) { return false; }
		const entry = (fetchedModels[provider.id] || []).find(e => e.id === model);
		if (entry && typeof entry.toolCapable === 'boolean') { return entry.toolCapable; }
		const patterns = provider.toolModelPatterns || [];
		if (!patterns.length) { return true; }
		return patterns.some(p => {
			try { return new RegExp(p, 'i').test(model || ''); } catch { return false; }
		});
	}

	/** Mirrors modelSupportsVision() in src/providers/types.ts — keep them in sync. */
	function modelSupportsVision(provider, model) {
		if (!provider) { return false; }
		const patterns = provider.visionModelPatterns || [];
		if (!patterns.length) { return true; }
		return patterns.some(p => {
			try { return new RegExp(p, 'i').test(model || ''); } catch { return false; }
		});
	}

	function isAuto() { return selectedProvider === AUTO_PROVIDER; }

	function renderProviderSelect() {
		els.providerSelect.innerHTML = '';
		const autoOpt = document.createElement('option');
		autoOpt.value = AUTO_PROVIDER;
		autoOpt.textContent = '🤖 Auto';
		els.providerSelect.appendChild(autoOpt);
		for (const p of providers) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.label + (p.requiresApiKey && !p.hasApiKey ? ' ⚠' : '');
			els.providerSelect.appendChild(opt);
		}
		if (selectedProvider) { els.providerSelect.value = selectedProvider; }
		applyProviderUiMode();
		renderModelSelect();
		updateModeAvailability();
	}

	/** Short, readable model name for the toolbar summary (drops any path prefix). */
	function shortModel(model) {
		if (!model) { return '—'; }
		const slash = model.lastIndexOf('/');
		return slash === -1 ? model : model.slice(slash + 1);
	}

	/** Toggles the model picker vs the Auto routing summary based on the selection. */
	function applyProviderUiMode() {
		const auto = isAuto();
		els.modelSelect.classList.toggle('hidden', auto);
		els.refreshModels.classList.toggle('hidden', auto);
		els.autoSummary.classList.toggle('hidden', !auto);
		if (auto) { renderAutoSummary(); }
	}

	function renderAutoSummary() {
		const byRole = {};
		for (const r of autoConfig.roles || []) { byRole[r.role] = r; }
		const parts = ['plan', 'code', 'review'].map(role => {
			const r = byRole[role];
			if (role === 'review' && !autoConfig.reviewEnabled) { return 'Review: off'; }
			if (!r) { return `${ROLE_LABELS[role]}: —`; }
			const warn = r.ready ? '' : ' ⚠';
			return `${ROLE_LABELS[role]}: ${shortModel(r.model)}${warn}`;
		});
		els.autoSummary.textContent = parts.join('  ·  ');
	}

	/**
	 * Live model lists fetched from each provider's API, keyed by provider id. Each
	 * entry is `{ id, free?, toolCapable? }` (see ModelEntry in src/providers/types.ts).
	 */
	const fetchedModels = {};

	/** Accepts entries or bare id strings (older host builds) and normalizes to entries. */
	function normalizeModelEntries(models) {
		return (models || [])
			.map(m => (typeof m === 'string' ? { id: m } : m))
			.filter(m => m && typeof m.id === 'string' && m.id);
	}

	function renderModelSelect() {
		const p = currentProvider();
		if (!p) { return; }
		const live = fetchedModels[p.id] || [];
		// Once a live list has been fetched it is authoritative: show it (plus the
		// configured model) instead of mixing in possibly-stale suggested ids. The
		// suggested models are only the fallback while nothing has been fetched.
		const entries = [];
		const seen = new Set();
		const add = e => { if (e && e.id && !seen.has(e.id)) { seen.add(e.id); entries.push(e); } };
		if (live.length) {
			if (p.model) { add(live.find(e => e.id === p.model) || { id: p.model }); }
			for (const e of live) { add(e); }
		} else {
			if (p.model) { add({ id: p.model }); }
			for (const m of p.suggestedModels || []) { add({ id: m }); }
		}
		els.modelSelect.innerHTML = '';
		for (const e of entries) {
			const opt = document.createElement('option');
			// 🔧 = tool-capable (works in Agent mode); "free" = costs nothing on this provider.
			opt.value = e.id;
			opt.textContent = e.id
				+ (modelSupportsTools(p, e.id) ? '  🔧' : '')
				+ (e.free ? '  · free' : '');
			els.modelSelect.appendChild(opt);
		}
		els.modelSelect.value = p.model;
		els.modelSelect.title = live.length
			? `${live.length} models fetched from the provider · 🔧 = supports Agent mode · "free" = no cost`
			: 'Models marked 🔧 support Agent mode (tool calling)';
	}

	function updateModeAvailability() {
		const agentOpt = /** @type {HTMLOptionElement | null} */ (els.modeSelect.querySelector('option[value="agent"]'));
		if (!agentOpt) { return; }
		// Agent is always selectable: picking it auto-switches to a tool-capable model
		// (see ensureAgentModel) instead of greying the option out.
		agentOpt.disabled = false;
		if (isAuto()) {
			els.modeSelect.title = 'Auto runs plan → implement → review across your configured models.';
			return;
		}
		const p = currentProvider();
		const model = els.modelSelect.value || (p && p.model) || '';
		els.modeSelect.title = (!p || modelSupportsTools(p, model))
			? 'Chat mode'
			: `Model "${model}" doesn't support tool calling — selecting Agent switches to a 🔧 model automatically.`;
	}

	/**
	 * Called when the user picks Agent mode: if the current model can't call tools,
	 * switch to the first tool-capable model in the dropdown (so Agent always remains
	 * selectable) and tell the user what happened.
	 */
	function ensureAgentModel() {
		const p = currentProvider();
		if (!p) { return; }
		const model = els.modelSelect.value || p.model || '';
		if (modelSupportsTools(p, model)) { return; }
		const alt = [...els.modelSelect.options].map(o => o.value).find(m => modelSupportsTools(p, m));
		if (alt) {
			els.modelSelect.value = alt;
			vscode.postMessage({ type: 'setModel', provider: selectedProvider, model: alt });
			showNotice(`"${model}" can't run Agent mode (no tool calling) — switched the model to "${alt}".`, false);
		} else {
			showNotice(`No listed ${p.label} model reports tool-calling support, so Agent runs may fail. Try another provider (e.g. NVIDIA or OpenRouter) or type a tool-capable model id.`, true);
		}
	}

	function renderSettings() {
		els.providerList.innerHTML = '';
		for (const p of providers) {
			const card = document.createElement('div');
			card.className = 'provider-card';
			const status = p.authKind === 'oauth'
				? '<span class="ok">● signed in</span>'
				: p.hasApiKey
					? `<span class="ok">● key set${p.hasEnvKey ? ' (env)' : ''}</span>`
					: (p.requiresApiKey ? '<span class="warn">● no key</span>' : '<span>no key needed</span>');
			const signInLabel = p.id === 'anthropic' ? 'Sign in with Claude'
				: p.id === 'openai' ? 'Sign in with ChatGPT'
					: p.id === 'openrouter' ? 'Sign in with OpenRouter'
						: 'Sign in';
			const signInTitle = p.id === 'anthropic'
				? 'Log in with your Claude (claude.ai) account — works with a Claude subscription, no API key needed'
				: p.id === 'openai'
					? 'Log in with your ChatGPT (openai.com) account — works with a ChatGPT subscription, no API key needed'
					: p.id === 'openrouter'
						? 'One-click login at openrouter.ai (Google/GitHub/email) — an API key is created for you automatically'
						: (p.authUrl ? 'Sign in with your configured web login' : 'Opens the provider’s sign-in page in a browser, then paste the key back here');
			card.innerHTML = `
				<div class="provider-title"><strong>${escapeHtml(p.label)}</strong> ${status}
					${p.supportsTools ? '<span class="tag">agent</span>' : ''}</div>
				<div class="provider-row">
					<input type="password" class="key-input" placeholder="${p.requiresApiKey ? 'Paste API key…' : 'Paste API key… (optional)'}" />
					<button class="save-key">Save</button>
				</div>
				<div class="provider-actions">
					<button class="sign-in" title="${signInTitle}">${signInLabel}</button>
					${p.apiKeyUrl ? '<a class="get-key" href="#">Get API key</a>' : ''}
					${p.hasApiKey ? '<a class="test-key" href="#">Test connection</a>' : ''}
					${(p.hasApiKey && !p.hasEnvKey) ? `<a class="clear-key" href="#">${p.authKind === 'oauth' ? 'Sign out' : 'Clear key'}</a>` : ''}
					${p.hasEnvKey ? '<span class="muted" title="Set via environment variable; unset it (and restart) to remove.">from environment</span>' : ''}
				</div>`;
			const keyInput = /** @type {HTMLInputElement} */ (card.querySelector('.key-input'));
			card.querySelector('.save-key')?.addEventListener('click', () => {
				vscode.postMessage({ type: 'saveKey', provider: p.id, key: keyInput.value });
				keyInput.value = '';
			});
			card.querySelector('.get-key')?.addEventListener('click', (e) => {
				e.preventDefault(); vscode.postMessage({ type: 'openExternal', url: p.apiKeyUrl });
			});
			card.querySelector('.sign-in')?.addEventListener('click', (e) => {
				e.preventDefault(); vscode.postMessage({ type: 'signIn', provider: p.id });
			});
			card.querySelector('.test-key')?.addEventListener('click', (e) => {
				e.preventDefault(); vscode.postMessage({ type: 'testKey', provider: p.id });
			});
			card.querySelector('.clear-key')?.addEventListener('click', (e) => {
				e.preventDefault(); vscode.postMessage({ type: 'clearKey', provider: p.id });
			});
			els.providerList.appendChild(card);
		}
		renderAutoRouting();
		renderApprovalList();
		renderSkillList();
		vscode.postMessage({ type: 'listMcp' });
	}

	/** Renders the skills section in the settings panel. */
	function renderSkillList() {
		if (!els.skillList) { return; }
		els.skillList.innerHTML = '';
		for (const skill of skillsList) {
			const active = activeSkills.includes(skill.id);
			const row = document.createElement('div');
			row.className = 'skill-row' + (active ? ' active' : '');
			row.innerHTML = `
				<div class="skill-info">
					<strong>${escapeHtml(skill.name)}</strong> <code>/skill ${escapeHtml(skill.id)}</code>
					<div class="skill-desc">${escapeHtml(skill.description || '')}</div>
				</div>
				<button class="skill-toggle">${active ? 'Deactivate' : 'Activate'}</button>`;
			row.querySelector('.skill-toggle')?.addEventListener('click', () => {
				vscode.postMessage({ type: 'toggleSkill', text: skill.id });
			});
			els.skillList.appendChild(row);
		}
	}

	/** Renders MCP server status lines in the settings panel. */
	function renderMcpList(status, toolCount) {
		if (!els.mcpList) { return; }
		els.mcpList.innerHTML = '';
		const summary = document.createElement('div');
		summary.className = 'mcp-summary';
		summary.textContent = toolCount > 0
			? `${toolCount} MCP tool${toolCount === 1 ? '' : 's'} available to the agent.`
			: 'No MCP tools available yet.';
		els.mcpList.appendChild(summary);
		for (const line of status || []) {
			const row = document.createElement('div');
			row.className = 'mcp-row' + (line.includes('failed') || line.includes('skipped') ? ' warn' : '');
			row.textContent = line;
			els.mcpList.appendChild(row);
		}
	}

	/** Renders the Agent-permissions cards in the settings panel (radio-style, one active). */
	function renderApprovalList() {
		if (!els.approvalList) { return; }
		els.approvalList.innerHTML = '';
		for (const opt of APPROVAL_OPTIONS) {
			const card = document.createElement('div');
			card.className = 'approval-card' + (approval === opt.value ? ' active' : '');
			card.innerHTML = `
				<div class="approval-head"><strong>${escapeHtml(opt.label)}</strong>
					${approval === opt.value ? '<span class="tag">active</span>' : ''}</div>
				<div class="approval-desc">${escapeHtml(opt.desc)}</div>`;
			card.addEventListener('click', () => {
				setApproval(opt.value);
				renderApprovalList();
			});
			els.approvalList.appendChild(card);
		}
	}

	/** Applies an approval level locally and persists it via the host. */
	function setApproval(value) {
		approval = value;
		if (els.approvalSelect) { els.approvalSelect.value = value; }
		vscode.postMessage({ type: 'setApproval', approval: value });
	}

	function renderAutoRouting() {
		els.autoRoutingList.innerHTML = '';
		for (const r of autoConfig.roles || []) {
			const pinned = r.source === 'configured';
			const row = document.createElement('div');
			row.className = 'role-row' + (r.ready ? '' : ' not-ready');
			const provOpts = ['<option value="">Auto-select</option>']
				.concat(providers.map(p =>
					`<option value="${p.id}"${pinned && p.id === r.providerId ? ' selected' : ''}>${escapeHtml(p.label)}</option>`))
				.join('');
			const listId = `auto-models-${r.role}`;
			const sourceText = pinned
				? 'pinned'
				: `auto → ${escapeHtml(shortModel(r.model) || '—')}${r.ready ? '' : ' ⚠'}`;
			row.innerHTML = `
				<div class="role-head"><strong>${escapeHtml(r.roleLabel)}</strong>
					<span class="role-source">${sourceText}</span></div>
				<div class="role-controls">
					<select class="role-provider">${provOpts}</select>
					<input class="role-model" type="text" list="${listId}"
						placeholder="${pinned ? 'model id' : 'model id (optional)'}"
						value="${pinned ? escapeHtml(r.model) : ''}" />
					<datalist id="${listId}"></datalist>
				</div>
				${r.problem ? `<div class="role-problem">⚠ ${escapeHtml(r.problem)}</div>` : ''}`;
			const provSel = /** @type {HTMLSelectElement} */ (row.querySelector('.role-provider'));
			const modelInput = /** @type {HTMLInputElement} */ (row.querySelector('.role-model'));
			const datalistEl = /** @type {HTMLElement} */ (row.querySelector('datalist'));
			const fillDatalist = (providerId) => {
				datalistEl.innerHTML = '';
				const p = providers.find(x => x.id === providerId);
				for (const m of (p && p.suggestedModels) || []) {
					const o = document.createElement('option'); o.value = m; datalistEl.appendChild(o);
				}
			};
			fillDatalist(provSel.value);
			provSel.addEventListener('change', () => {
				fillDatalist(provSel.value);
				if (!provSel.value) {
					modelInput.value = '';
					vscode.postMessage({ type: 'setRole', role: r.role, provider: '', model: '' });
					return;
				}
				if (!modelInput.value.trim()) {
					const p = providers.find(x => x.id === provSel.value);
					modelInput.value = (p && p.suggestedModels && p.suggestedModels[0]) || '';
				}
				if (modelInput.value.trim()) {
					vscode.postMessage({ type: 'setRole', role: r.role, provider: provSel.value, model: modelInput.value.trim() });
				}
			});
			modelInput.addEventListener('change', () => {
				if (provSel.value && modelInput.value.trim()) {
					vscode.postMessage({ type: 'setRole', role: r.role, provider: provSel.value, model: modelInput.value.trim() });
				} else if (!provSel.value) {
					vscode.postMessage({ type: 'setRole', role: r.role, provider: '', model: '' });
				}
			});
			els.autoRoutingList.appendChild(row);
		}
		if (els.enableReview) { els.enableReview.checked = !!autoConfig.reviewEnabled; }
	}

	// ---- History panel ----------------------------------------------------------

	function openHistoryPanel() {
		els.settingsPanel.classList.add('hidden');
		els.historyPanel.classList.remove('hidden');
		renderHistoryPanel();
	}

	function renderHistoryPanel() {
		els.historyList.innerHTML = '';
		if (!history.length) {
			const p = document.createElement('p');
			p.className = 'hint';
			p.textContent = 'No saved chats yet — close a chat tab (✕) and its conversation lands here.';
			els.historyList.appendChild(p);
			return;
		}
		for (const h of history) {
			const count = h.messages.filter(m => !m.kind).length;
			const row = document.createElement('div');
			row.className = 'history-row';
			row.title = 'Reopen this conversation';
			row.innerHTML = `
				<div class="history-info">
					<strong>${escapeHtml(h.title || 'Untitled chat')}</strong>
					<div class="history-meta">${escapeHtml(relTime(h.savedAt))} · ${count} message${count === 1 ? '' : 's'}</div>
				</div>
				<button class="history-delete" title="Delete this conversation permanently">✕</button>`;
			row.addEventListener('click', () => restoreChat(h.id));
			row.querySelector('.history-delete')?.addEventListener('click', (e) => {
				e.stopPropagation();
				history = history.filter(x => x.id !== h.id);
				saveState();
				syncHistory();
				renderHistoryPanel();
			});
			els.historyList.appendChild(row);
		}
	}

	// ---- Modes ------------------------------------------------------------------

	function placeholderFor() {
		const s = cur();
		if (s && s.streaming) {
			return s.runMode === 'agent'
				? 'Agent is running — type here to steer it live (Enter to send)…'
				: 'Streaming — type here to queue your next message (Enter to add)…';
		}
		return mode === 'plan'
			? 'Describe the requirement to plan (no changes are made)…'
			: mode === 'agent'
				? 'Give the agent a task (it can read/write/edit files and run commands)…'
				: 'Ask about your open files… (Enter to send, Shift+Enter for newline)';
	}

	function setMode(next) {
		mode = next;
		els.modeSelect.value = mode;
		// The permissions pill only matters in Agent mode; keep the bar clean otherwise.
		els.approvalSelect?.classList.toggle('hidden', mode !== 'agent');
		els.input.placeholder = placeholderFor();
		saveState();
	}

	// ---- Context ----------------------------------------------------------------

	function renderContext() {
		if (!currentContext) { els.contextChip.classList.add('hidden'); return; }
		els.contextChip.classList.remove('hidden');
		els.contextChip.innerHTML = `📎 ${escapeHtml(currentContext.label)} <a href="#" id="removeCtx">✕</a>`;
		els.contextChip.querySelector('#removeCtx')?.addEventListener('click', (e) => {
			e.preventDefault(); currentContext = null; renderContext();
		});
	}

	function renderSkillChip() {
		const active = skillsList.filter(s => activeSkills.includes(s.id));
		if (!active.length) { els.skillChip.classList.add('hidden'); els.skillChip.innerHTML = ''; return; }
		els.skillChip.classList.remove('hidden');
		els.skillChip.innerHTML = active.map(skill =>
			`<span class="skill-chip-item">🎓 ${escapeHtml(skill.name)} <a href="#" data-skill="${escapeHtml(skill.id)}" title="Deactivate this skill">✕</a></span>`
		).join('');
		for (const link of els.skillChip.querySelectorAll('a[data-skill]')) {
			link.addEventListener('click', (e) => {
				e.preventDefault();
				vscode.postMessage({ type: 'toggleSkill', text: link.getAttribute('data-skill') });
			});
		}
	}

	function enhance() {
		const text = els.input.value.trim();
		if (!text || cur().streaming || enhancing) { return; }
		enhancing = true;
		els.enhanceButton.disabled = true;
		els.enhanceButton.classList.add('busy');
		vscode.postMessage({ type: 'enhancePrompt', text, provider: selectedProvider, model: els.modelSelect.value });
	}
	function endEnhance() {
		enhancing = false;
		els.enhanceButton.disabled = false;
		els.enhanceButton.classList.remove('busy');
	}

	// ---- Send / streaming -------------------------------------------------------

	/**
	 * Reflects the ACTIVE session's state in the composer; other tabs stream on their
	 * own. The input stays enabled during a run: typed messages queue up (Ask/Plan)
	 * or steer the live agent run.
	 */
	function updateComposer() {
		const on = !!cur().streaming;
		els.sendButton.classList.toggle('hidden', on);
		els.stopButton.classList.toggle('hidden', !on);
		els.enhanceButton.disabled = on || enhancing;
		els.input.placeholder = placeholderFor();
		renderQueueChips();
	}

	/** Renders the active session's queued messages as removable chips above the input. */
	function renderQueueChips() {
		if (!els.queueChips) { return; }
		const s = cur();
		els.queueChips.innerHTML = '';
		if (!s.queue.length) {
			els.queueChips.classList.add('hidden');
			return;
		}
		els.queueChips.classList.remove('hidden');
		s.queue.forEach((text, index) => {
			const chip = document.createElement('span');
			chip.className = 'queue-chip';
			chip.title = text;
			chip.innerHTML = `⏳ ${escapeHtml(text.length > 40 ? text.slice(0, 39) + '…' : text)} <a href="#">✕</a>`;
			chip.querySelector('a')?.addEventListener('click', (e) => {
				e.preventDefault();
				s.queue.splice(index, 1);
				renderQueueChips();
				saveState();
			});
			els.queueChips.appendChild(chip);
		});
	}

	/** Injects a steering message into the session's live agent run. */
	function steer(s, text) {
		s.messages.push({ role: 'user', content: text });
		if (s.id === activeSessionId) {
			const body = appendMessageEl('user', text);
			body.parentElement?.classList.add('steering');
			scrollToBottom();
		}
		saveState();
		vscode.postMessage({ type: 'steer', sessionId: s.id, text });
	}

	// ---- Working indicator ------------------------------------------------------
	// Claude-style "…doing something" feedback: an empty streaming bubble immediately
	// shows a whimsical cycling verb + elapsed time, so a queued or slow model never
	// looks like the chat went idle. The first real token replaces it.

	const WORKING_WORDS = [
		'Thinking', 'Pondering', 'Mooshing', 'Percolating', 'Noodling', 'Brewing',
		'Cogitating', 'Ruminating', 'Marinating', 'Conjuring', 'Untangling', 'Scheming',
		'Musing', 'Simmering', 'Whirring', 'Crunching', 'Focusing', 'Reticulating splines',
		'Herding tokens', 'Warming neurons', 'Consulting the manuals', 'Wrangling bits',
	];
	let workingTimer = 0;
	let lastWorkingWord = '';

	function pickWorkingWord() {
		let word = lastWorkingWord;
		while (word === lastWorkingWord) {
			word = WORKING_WORDS[Math.floor(Math.random() * WORKING_WORDS.length)];
		}
		lastWorkingWord = word;
		return word;
	}

	function stopWorking() {
		clearInterval(workingTimer);
		workingTimer = 0;
	}

	/** Attaches the animated working indicator to an (empty) streaming bubble. */
	function startWorking(body, s) {
		stopWorking();
		const started = Date.now();
		const el = document.createElement('span');
		el.className = 'working';
		el.innerHTML = '<span class="working-word"></span><span class="working-meta"></span>';
		body.appendChild(el);
		const wordEl = /** @type {HTMLElement} */ (el.querySelector('.working-word'));
		const metaEl = /** @type {HTMLElement} */ (el.querySelector('.working-meta'));
		let word = pickWorkingWord();
		let hintShown = false;
		const render = () => {
			const secs = Math.floor((Date.now() - started) / 1000);
			wordEl.textContent = `${word}…`;
			metaEl.textContent = secs >= 8 ? ` ${secs}s` : '';
			// Long silence is almost always the provider-side free-tier queue: say so once.
			if (secs >= 25 && !hintShown) {
				hintShown = true;
				const hint = document.createElement('span');
				hint.className = 'working-hint';
				hint.textContent = 'Still queued at the provider — free-tier models can take a minute or two when busy. Consistently slow? Try a smaller model or another provider.';
				el.appendChild(hint);
			}
		};
		render();
		let ticks = 0;
		workingTimer = setInterval(() => {
			// Bubble gone (tab switched / content arrived) — self-dispose.
			if (!el.isConnected || (s.pending ?? '') !== '') {
				stopWorking();
				return;
			}
			ticks++;
			if (ticks % 3 === 0) { word = pickWorkingWord(); }
			render();
		}, 1000);
	}

	/** Starts an in-flight assistant turn on a session (DOM bubble only when visible). */
	function openStream(s) {
		s.pending = '';
		if (s.id === activeSessionId) {
			activeAssistantBody = appendMessageEl('assistant', '');
			activeAssistantBody.parentElement?.classList.add('streaming');
			startWorking(activeAssistantBody, s);
		}
	}

	/**
	 * Normalizes finished assistant text before it is stored and re-sent as history:
	 * strips trailing spaces, collapses 3+ blank lines to one, and trims the ends. Content
	 * inside fenced ``` code blocks is left byte-for-byte untouched so code/indentation
	 * survives. Cuts wasted characters (and thus tokens) without changing meaning.
	 */
	function tidyResponse(text) {
		if (!text) { return text; }
		const parts = text.split(/(```[\s\S]*?```)/g);
		const cleaned = parts.map((part, i) => {
			if (i % 2 === 1) { return part; } // odd chunks are fenced code blocks — keep as-is
			return part
				.replace(/[ \t]+$/gm, '')      // trailing whitespace per line
				.replace(/\n{3,}/g, '\n\n');   // no runs of blank lines
		}).join('');
		return cleaned.trim();
	}

	/** Commits a session's in-flight assistant turn into its transcript. */
	function commitPending(s) {
		// Only the visible tab owns the working indicator; a background tab finishing
		// must not cancel the one running for the active tab.
		if (s.id === activeSessionId) {
			stopWorking();
		}
		if (s.pending) {
			s.messages.push({ role: 'assistant', content: tidyResponse(s.pending) });
		}
		if (s.id === activeSessionId && activeAssistantBody) {
			const wrap = activeAssistantBody.parentElement;
			wrap?.classList.remove('streaming');
			if (s.pending) {
				enhanceCodeBlocks(activeAssistantBody);
			} else {
				wrap?.remove();
			}
			activeAssistantBody = null;
		}
		s.pending = null;
		saveState();
	}

	function sendText(text, opts, target) {
		const s = target || cur();
		if ((!text && !pendingImages.length) || s.streaming) { return; }
		// Inline code actions run in the internal 'edit' mode without changing the
		// user's selected mode — they pass it as an override instead.
		const sendMode = (opts && opts.mode) || mode;
		const images = pendingImages.length ? pendingImages.slice() : undefined;
		s.messages.push({ role: 'user', content: text, images });
		if (!s.title && text) {
			s.title = text.length > 28 ? text.slice(0, 27) + '…' : text;
		}
		if (s.id === activeSessionId) {
			appendMessageEl('user', text, images);
		}
		pendingImages = [];
		renderImageChips();
		// Remember how this run was started so mid-run input knows whether to steer or queue.
		s.runMode = (sendMode === 'agent' && !isAuto()) ? 'agent' : sendMode;

		// In Auto mode the per-phase header creates its own bubble; otherwise pre-create one
		// for non-agent streaming. (openStream only touches the DOM for the visible tab.)
		if (sendMode !== 'agent' && !isAuto()) {
			openStream(s);
		}
		s.streaming = true;
		renderTabs();
		updateComposer();
		saveState();
		scrollToBottom();
		vscode.postMessage({
			type: 'send',
			sessionId: s.id,
			mode: sendMode,
			provider: selectedProvider,
			model: els.modelSelect.value,
			context: currentContext || undefined,
			messages: s.messages.filter(m => !m.kind && !(m.role === 'assistant' && m.content === '')),
			inline: !!(opts && opts.inline),
		});
	}

	function send() {
		const s = cur();
		const text = els.input.value.trim();
		if (!text && !pendingImages.length) { return; }
		if (text.startsWith('/') && handleSlash(text)) { els.input.value = ''; autoSize(); return; }
		if (s.streaming) {
			// Mid-run input: steer a live agent run, queue for anything else.
			if (!text) { return; }
			if (s.runMode === 'agent') {
				steer(s, text);
			} else {
				s.queue.push(text);
				renderQueueChips();
				saveState();
			}
			els.input.value = ''; autoSize();
			return;
		}
		if (pendingImages.length && !isAuto() && !modelSupportsVision(currentProvider(), els.modelSelect.value)) {
			showNotice(`The model "${els.modelSelect.value}" doesn't support image input. Remove the attachment or pick a vision-capable model.`, true);
			return;
		}
		els.input.value = ''; autoSize();
		sendText(text);
	}

	/** Clears the active chat tab (other tabs are untouched); the conversation is kept in History. */
	function clearChat() {
		const s = cur();
		if (s.streaming) {
			vscode.postMessage({ type: 'stop', sessionId: s.id });
			s.streaming = false;
		}
		archiveSession(s);
		// Fresh id so the archived copy stays its own history entry — otherwise the
		// next archive of this tab (same id) would overwrite the pre-clear conversation.
		s.id = newSessionId();
		activeSessionId = s.id;
		s.messages = [];
		s.title = '';
		s.pending = null;
		s.todos = [];
		currentContext = null;
		pendingImages = [];
		saveState();
		renderTabs(); renderAll(); renderContext(); renderImageChips(); updateComposer();
		els.input.focus();
	}

	const SLASH_INLINE = ['explain', 'fix', 'doc', 'optimize', 'tests'];
	/** Handles a leading slash command. Returns true if it consumed the input. */
	function handleSlash(text) {
		const m = /^\/(\w+)\s*([\s\S]*)$/.exec(text);
		if (!m) { return false; }
		const cmd = m[1].toLowerCase();
		const rest = m[2].trim();
		if (cmd === 'help') { showHelp(); return true; }
		if (cmd === 'clear') { clearChat(); return true; }
		if (cmd === 'history') { openHistoryPanel(); return true; }
		if (cmd === 'ask' || cmd === 'plan' || cmd === 'agent' || cmd === 'edit') {
			// '/edit' is a legacy alias for the mode that Plan replaced.
			setMode(cmd === 'edit' ? 'plan' : cmd);
			if (rest) { sendText(rest); }
			return true;
		}
		if (cmd === 'auto') {
			selectedProvider = AUTO_PROVIDER;
			els.providerSelect.value = AUTO_PROVIDER;
			saveState(); applyProviderUiMode(); renderModelSelect(); updateModeAvailability();
			vscode.postMessage({ type: 'setProvider', provider: AUTO_PROVIDER });
			setMode('agent');
			if (rest) { sendText(rest); }
			return true;
		}
		if (SLASH_INLINE.includes(cmd)) {
			vscode.postMessage({ type: 'slashInline', command: cmd, text: rest });
			return true;
		}
		if (cmd === 'enhance') { els.input.value = rest; enhance(); return true; }
		if (cmd === 'skills') { showSkills(); return true; }
		if (cmd === 'skill') {
			const id = rest.toLowerCase();
			if (id === 'new' || id === 'create') {
				vscode.postMessage({ type: 'createSkill' });
				return true;
			}
			vscode.postMessage({ type: 'setSkill', text: (id === 'off' || id === 'none') ? '' : id });
			return true;
		}
		if (cmd === 'mcp') {
			if (rest === 'add') { vscode.postMessage({ type: 'mcpAdd' }); return true; }
			if (rest === 'reconnect') { vscode.postMessage({ type: 'mcpReconnect' }); return true; }
			els.settingsPanel.classList.remove('hidden');
			renderSettings();
			return true;
		}
		return false; // unknown — treat as a normal message
	}

	function showSkills() {
		const lines = ['**Skills** — activate with `/skill <id>`; several can be active at once (`/skill off` clears all)'];
		for (const s of skillsList) {
			const mark = activeSkills.includes(s.id) ? ' ✓ active' : '';
			lines.push(`\`${s.id}\` — ${s.name}${s.description ? ': ' + s.description : ''}${mark}`);
		}
		appendMessageEl('assistant', lines.join('\n')).parentElement?.classList.add('info');
		scrollToBottom();
	}

	function showHelp() {
		const help = [
			'**Slash commands**',
			'`/ask` `/plan` `/agent` — switch mode (optionally with a message)',
			'`/auto` — use Auto (role-routed plan → implement → review)',
			'`/explain` `/fix` `/doc` `/optimize` `/tests` — act on the current editor selection',
			'`/enhance` — rewrite your draft into a sharper prompt',
			'`/skills` — list skills   ·   `/skill <id>` — activate (stackable; `/skill off` clears all, `/skill new` creates)',
			'`/mcp` — MCP server status   ·   `/mcp add` — register a server   ·   `/mcp reconnect`',
			'`/history` — reopen a previous conversation (also the 🕘 button; closed tabs are saved there)',
			'`/clear` — clear this chat tab (saved to History)   ·   `/help` — show this help',
			'',
			'**While a run is streaming**: keep typing! In Agent mode, Enter **steers** the live run; otherwise your message is **queued** and sent when the run finishes. The **+** tab button opens parallel chats.',
		].join('\n');
		appendMessageEl('assistant', help).parentElement?.classList.add('info');
		scrollToBottom();
	}

	function appendPhaseHeader(label, provider, model, source) {
		const el = document.createElement('div');
		el.className = 'auto-phase';
		el.innerHTML =
			`<span class="phase-name">${escapeHtml(label || '')}</span>` +
			`<span class="phase-model">${escapeHtml(provider || '')} · ${escapeHtml(model || '')}</span>` +
			`<span class="phase-tag">${source === 'configured' ? 'pinned' : 'auto'}</span>`;
		els.messages.appendChild(el);
		scrollToBottom();
	}

	function autoSize() {
		els.input.style.height = 'auto';
		els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
	}

	// ---- Events -----------------------------------------------------------------

	els.modeSelect.addEventListener('change', () => {
		if (els.modeSelect.value === 'agent' && !isAuto()) { ensureAgentModel(); }
		setMode(els.modeSelect.value);
	});
	els.approvalSelect?.addEventListener('change', () => setApproval(els.approvalSelect.value));
	els.providerSelect.addEventListener('change', () => {
		selectedProvider = els.providerSelect.value;
		saveState();
		applyProviderUiMode();
		renderModelSelect(); updateModeAvailability();
		// Already in Agent mode? Keep the invariant: the selected model must do tools.
		if (mode === 'agent' && !isAuto()) { ensureAgentModel(); }
		vscode.postMessage({ type: 'setProvider', provider: selectedProvider });
		// Ask for the live model list the first time this provider is selected.
		if (!isAuto() && !fetchedModels[selectedProvider]) {
			vscode.postMessage({ type: 'listModels', provider: selectedProvider });
		}
	});
	els.enableReview?.addEventListener('change', () => {
		vscode.postMessage({ type: 'setReviewEnabled', reviewEnabled: els.enableReview.checked });
	});
	els.modelSelect.addEventListener('change', () => {
		updateModeAvailability();
		vscode.postMessage({ type: 'setModel', provider: selectedProvider, model: els.modelSelect.value });
	});
	els.refreshModels.addEventListener('click', () => {
		vscode.postMessage({ type: 'listModels', provider: selectedProvider });
	});
	els.settingsButton.addEventListener('click', () => {
		// From the sidebar chat, ⚙ opens Settings in its own editor tab (a proper, roomy
		// window) rather than the cramped in-sidebar overlay.
		vscode.postMessage({ type: 'requestOpenSettings' });
	});
	els.closeSettings.addEventListener('click', () => {
		if (SETTINGS_ONLY) { vscode.postMessage({ type: 'closeSettingsWindow' }); }
		else { els.settingsPanel.classList.add('hidden'); }
	});
	els.historyButton?.addEventListener('click', () => {
		if (els.historyPanel.classList.contains('hidden')) { openHistoryPanel(); }
		else { els.historyPanel.classList.add('hidden'); }
	});
	els.closeHistory?.addEventListener('click', () => els.historyPanel.classList.add('hidden'));
	els.newSkill?.addEventListener('click', () => vscode.postMessage({ type: 'createSkill' }));
	els.mcpAdd?.addEventListener('click', () => vscode.postMessage({ type: 'mcpAdd' }));
	els.mcpReconnectBtn?.addEventListener('click', () => {
		if (els.mcpList) { els.mcpList.textContent = 'Reconnecting…'; }
		vscode.postMessage({ type: 'mcpReconnect' });
	});
	els.mcpOpenConfig?.addEventListener('click', () => vscode.postMessage({ type: 'mcpOpenConfig' }));
	els.attachButton.addEventListener('click', () => vscode.postMessage({ type: 'attachContext' }));
	els.input.addEventListener('paste', (e) => {
		const items = e.clipboardData ? [...e.clipboardData.items] : [];
		const imageItems = items.filter(it => it.type.startsWith('image/'));
		if (!imageItems.length) { return; }
		e.preventDefault();
		const availableSlots = Math.max(0, MAX_IMAGES_PER_MESSAGE - pendingImages.length);
		if (imageItems.length > availableSlots) {
			showNotice(`You can attach at most ${MAX_IMAGES_PER_MESSAGE} images per message.`, true);
		}
		for (const item of imageItems.slice(0, availableSlots)) {
			const file = item.getAsFile();
			if (!file) { continue; }
			resizeImage(file).then(resized => {
				pendingImages.push(resized);
				renderImageChips();
			}).catch(err => {
				showNotice(err instanceof Error ? err.message : String(err), true);
			});
		}
	});
	els.enhanceButton.addEventListener('click', enhance);
	els.sendButton.addEventListener('click', send);
	els.stopButton.addEventListener('click', () => vscode.postMessage({ type: 'stop', sessionId: activeSessionId }));
	els.input.addEventListener('input', autoSize);
	els.input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
	});

	// ---- Clipboard & editing shortcuts --------------------------------------------
	// Keystrokes inside the webview are also forwarded to the workbench for keybinding
	// dispatch, and on some setups that swallows the native clipboard shortcuts before
	// Chromium's default editing behaviour runs. Implement copy / cut / paste /
	// select-all / undo / redo here so they always work in the chat box and key fields.

	/** The focused editable element (chat box or a settings input), if any. */
	function editableTarget() {
		const el = document.activeElement;
		if (el instanceof HTMLTextAreaElement) { return el; }
		if (el instanceof HTMLInputElement && ['text', 'password', 'search', 'url'].includes(el.type)) { return el; }
		return null;
	}

	/**
	 * Inserts text at the element's cursor, replacing any selection.
	 * @param {HTMLTextAreaElement | HTMLInputElement} el
	 * @param {string} text
	 */
	function insertText(el, text) {
		el.setRangeText(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, 'end');
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}

	/**
	 * Pastes clipboard content into the element. For the chat box a rich read is
	 * attempted first so copied screenshots become image attachments (mirroring the
	 * `paste` event handler above, which doesn't fire when we handle the keystroke).
	 * @param {HTMLTextAreaElement | HTMLInputElement} el
	 */
	async function pasteFromClipboard(el) {
		try {
			let text = '';
			if (el === els.input && navigator.clipboard?.read) {
				const items = await navigator.clipboard.read();
				for (const item of items) {
					const imageType = item.types.find(t => t.startsWith('image/'));
					if (imageType) {
						if (pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
							showNotice(`You can attach at most ${MAX_IMAGES_PER_MESSAGE} images per message.`, true);
							continue;
						}
						const blob = await item.getType(imageType);
						const resized = await resizeImage(new File([blob], 'pasted', { type: imageType }));
						pendingImages.push(resized);
						renderImageChips();
						continue;
					}
					if (item.types.includes('text/plain')) {
						text += await (await item.getType('text/plain')).text();
					}
				}
			} else {
				text = await navigator.clipboard.readText();
			}
			if (text) { insertText(el, text); }
		} catch {
			// Rich read can be refused where plain text is still allowed — retry.
			try {
				const text = await navigator.clipboard.readText();
				if (text) { insertText(el, text); }
			} catch (err) {
				showNotice('Could not read the clipboard: ' + (err instanceof Error ? err.message : String(err)), true);
			}
		}
	}

	document.addEventListener('keydown', (e) => {
		// Escape closes the settings / history panels from anywhere in the view.
		if (e.key === 'Escape' && !els.settingsPanel.classList.contains('hidden')) {
			e.preventDefault();
			els.settingsPanel.classList.add('hidden');
			els.input.focus();
			return;
		}
		if (e.key === 'Escape' && els.historyPanel && !els.historyPanel.classList.contains('hidden')) {
			e.preventDefault();
			els.historyPanel.classList.add('hidden');
			els.input.focus();
			return;
		}
		const mod = e.ctrlKey || e.metaKey;
		if (!mod || e.altKey) { return; }
		const key = e.key.toLowerCase();
		const el = editableTarget();
		if (key === 'a' && el) {
			e.preventDefault();
			el.select();
		} else if (key === 'c' && !e.shiftKey) {
			// Works for editable fields and for selected transcript text alike. No
			// preventDefault: if the default copy also runs it writes the same text.
			const selected = el
				? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
				: String(window.getSelection() ?? '');
			if (selected) { navigator.clipboard?.writeText(selected); }
		} else if (key === 'x' && !e.shiftKey && el) {
			e.preventDefault();
			const start = el.selectionStart ?? 0;
			const end = el.selectionEnd ?? 0;
			if (start !== end) {
				navigator.clipboard?.writeText(el.value.slice(start, end));
				el.setRangeText('', start, end, 'start');
				el.dispatchEvent(new Event('input', { bubbles: true }));
			}
		} else if (key === 'v' && !e.shiftKey && el) {
			e.preventDefault();
			void pasteFromClipboard(el);
		} else if (key === 'z' && el) {
			e.preventDefault();
			document.execCommand(e.shiftKey ? 'redo' : 'undo');
		} else if (key === 'y' && el) {
			e.preventDefault();
			document.execCommand('redo');
		}
	});

	/**
	 * Chat-stream messages the host broadcasts to every webview. The detached Settings tab
	 * shares no live conversation, so it must ignore these — otherwise they would mutate a
	 * phantom session and race the sidebar over persisted history.
	 */
	const CHAT_ONLY_MESSAGES = [
		'token', 'agentStepStart', 'agentStepEnd', 'toolStart', 'toolEnd',
		'done', 'newChat', 'inline', 'autoPhase', 'editProposal',
	];

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (SETTINGS_ONLY && CHAT_ONLY_MESSAGES.includes(msg.type)) { return; }
		switch (msg.type) {
			case 'config': {
				providers = msg.providers || [];
				if (msg.auto) { autoConfig = msg.auto; }
				if (msg.approval) {
					approval = msg.approval;
					if (els.approvalSelect) { els.approvalSelect.value = approval; }
				}
				// Keep a valid selection: honour the persisted choice (incl. Auto) when it still exists.
				const valid = selectedProvider === AUTO_PROVIDER || providers.some(p => p.id === selectedProvider);
				if (!valid) {
					selectedProvider = msg.selectedProvider || (providers[0] && providers[0].id) || '';
				}
				renderProviderSelect();
				if (!els.settingsPanel.classList.contains('hidden')) { renderSettings(); }
				break;
			}
			case 'selectProvider':
				if (msg.provider === AUTO_PROVIDER || providers.some(p => p.id === msg.provider)) {
					selectedProvider = msg.provider;
					els.providerSelect.value = selectedProvider;
					saveState();
					applyProviderUiMode();
					renderModelSelect(); updateModeAvailability();
				}
				break;
			case 'openSettings':
				els.settingsPanel.classList.remove('hidden'); renderSettings();
				break;
			case 'models':
				fetchedModels[msg.provider] = normalizeModelEntries(msg.models);
				if (msg.provider === selectedProvider) {
					renderModelSelect(); updateModeAvailability();
					// The live catalog may reveal the current model can't do tools.
					if (mode === 'agent' && !isAuto()) { ensureAgentModel(); }
				}
				break;
			case 'token': {
				const s = sessionFor(msg);
				if (s.pending == null) { openStream(s); }
				s.pending += msg.delta;
				if (s.id === activeSessionId && activeAssistantBody) {
					stopWorking();
					activeAssistantBody.innerHTML = renderMarkdown(s.pending);
					scrollToBottom();
				}
				break;
			}
			case 'autoPhase': {
				// Finalize whatever the previous phase streamed, then open this phase.
				const s = sessionFor(msg);
				commitPending(s);
				if (s.id === activeSessionId) {
					appendPhaseHeader(msg.label, msg.provider, msg.model, msg.source);
				}
				if (msg.streaming) { openStream(s); }
				break;
			}
			case 'agentStepStart': {
				// Open a fresh streaming bubble for the implementer's next step.
				const s = sessionFor(msg);
				commitPending(s);
				openStream(s);
				break;
			}
			case 'agentStepEnd': {
				// Authoritative full text for the step (covers non-streaming providers too).
				const s = sessionFor(msg);
				if (typeof msg.content === 'string' && msg.content) {
					if (s.pending == null) { openStream(s); }
					s.pending = msg.content;
					if (s.id === activeSessionId && activeAssistantBody) {
						activeAssistantBody.innerHTML = renderMarkdown(s.pending);
					}
				}
				commitPending(s);
				scrollToBottom();
				break;
			}
			case 'toolStart': {
				// Commit any open assistant bubble so the tool block renders after it.
				const s = sessionFor(msg);
				commitPending(s);
				// Tool blocks are rendered live only for the visible tab.
				if (s.id === activeSessionId) {
					const el = appendToolEl(msg.name, msg.args);
					toolEls.set(msg.id || ('t' + (toolSeq++)), el);
				}
				break;
			}
			case 'toolEnd': {
				const key = msg.id || [...toolEls.keys()][0];
				const t = toolEls.get(key);
				if (t) {
					t.wrap.classList.remove('running');
					t.wrap.classList.toggle('tool-error', !!msg.isError);
					t.out.textContent = String(msg.result).slice(0, 4000);
					toolEls.delete(key);
					scrollToBottom();
				}
				break;
			}
			case 'editProposal': {
				const bar = document.createElement('div');
				bar.className = 'edit-apply';
				bar.innerHTML = `<span>Proposed changes to <code>${escapeHtml(msg.path || 'file')}</code></span> <button id="applyEditBtn">Apply</button>`;
				els.messages.appendChild(bar);
				bar.querySelector('#applyEditBtn')?.addEventListener('click', () => {
					vscode.postMessage({ type: 'applyEdit', content: msg.content });
					bar.querySelector('button')?.setAttribute('disabled', 'true');
				});
				scrollToBottom();
				break;
			}
			case 'context':
				currentContext = msg.context; renderContext();
				break;
			case 'enhancedPrompt':
				endEnhance();
				els.input.value = msg.text || els.input.value;
				autoSize(); els.input.focus();
				break;
			case 'enhanceError':
				endEnhance();
				appendMessageEl('assistant', 'ℹ️ ' + msg.message).parentElement?.classList.add('info');
				scrollToBottom();
				break;
			case 'skills':
				skillsList = msg.skills || [];
				// The host sends an array; tolerate the legacy single-string form.
				activeSkills = Array.isArray(msg.active) ? msg.active : (msg.active ? [msg.active] : []);
				renderSkillChip();
				if (!els.settingsPanel.classList.contains('hidden')) { renderSkillList(); }
				break;
			case 'history': {
				// Host-persisted archive (survives restarts); merge with what this webview has.
				const emptyBefore = !cur()?.messages.length;
				mergeHistory(Array.isArray(msg.history) ? msg.history : []);
				if (!els.historyPanel.classList.contains('hidden')) { renderHistoryPanel(); }
				if (emptyBefore) { renderAll(); }
				break;
			}
			case 'mcp':
				renderMcpList(msg.status, msg.toolCount || 0);
				break;
			case 'todos': {
				const s = sessionFor(msg);
				s.todos = Array.isArray(msg.items) ? msg.items : [];
				if (s.id === activeSessionId) { renderTodos(); }
				break;
			}
			case 'info':
				addNotice(sessionFor(msg), msg.message, false);
				break;
			case 'error': {
				addNotice(sessionFor(msg), msg.message, true);
				if (msg.needsKey) { els.settingsPanel.classList.remove('hidden'); renderSettings(); }
				break;
			}
			case 'done': {
				const s = sessionFor(msg);
				s.streaming = false;
				commitPending(s);
				renderTabs();
				if (s.id === activeSessionId) { updateComposer(); }
				// A queued follow-up starts as soon as the tab is idle again.
				if (s.queue.length) {
					const next = s.queue.shift();
					saveState();
					if (s.id === activeSessionId) { renderQueueChips(); }
					sendText(next, s.runMode && s.runMode !== 'edit' ? { mode: s.runMode } : undefined, s);
				}
				break;
			}
			case 'inline':
				// Triggered by an editor command / code action. Runs in the requested mode
				// ('edit' for Fix/Doc/Optimize/Edit, 'ask' for Explain) without touching the
				// user's selected chat mode — 'edit' is no longer a selectable option.
				sendText(msg.prompt, { inline: !!msg.inline, mode: msg.mode });
				break;
			case 'newChat':
				// The + button opens a fresh tab; existing chats keep running in parallel.
				createSession();
				break;
		}
	});

	// ---- Init -------------------------------------------------------------------

	setMode(mode);
	renderTabs();
	renderAll();
	renderContext();
	renderImageChips();
	updateComposer();
	autoSize();
	if (SETTINGS_ONLY) {
		// Detached Settings tab: pin the panel open; the incoming config push renders it.
		els.settingsPanel.classList.remove('hidden');
		renderSettings();
	}
	vscode.postMessage({ type: 'ready' });
}());
