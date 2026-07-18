# Composer Redesign (Cursor-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat panel's top toolbar + plain input row with a single Cursor-style bordered composer box: chips, textarea with round send button beside it, and a control bar (mode pill, provider, model, ↻ left; attach/enhance/settings right) — presentation-layer only, zero behavior change.

**Architecture:** Three-file change. `getHtml()` in `chatViewProvider.ts` loses the `<header id="toolbar">` and gains a nested `.composer-box` structure with inline SVG icons; `media/main.js` swaps the three-button mode switch for a `<select id="modeSelect">` (native select = free keyboard/screen-reader support, per-option `disabled` handles Agent gating) and stops mutating icon-button `textContent` (which would destroy SVG children); `media/main.css` gains the box/bar/pill styles and drops the dead toolbar styles. Every webview↔host message keeps its exact shape.

**Tech Stack:** TypeScript template literal (extension host), vanilla JS webview with `@ts-check` (`media/main.js`), plain CSS with `--vscode-*` theme variables.

**Reference spec:** `docs/superpowers/specs/2026-07-02-composer-redesign-design.md` (approved mockup: `.superpowers/brainstorm/1590-1782982358/content/composer-final-v2.html`)

---

## Verification convention

No automated test suite in this extension (repo convention). Every task ends with:

```bash
npm run gulp compile-extensions
```

from repo root `C:\Users\dell\Downloads\Srikanth\Github\openvs`. Expected: 0 errors (this also validates `main.js` via `@ts-check`). ~1-1.5 min. Never stack changes on a broken compile.

**Intermediate-state note:** Task 1 (HTML) commits before Task 2 (JS) adapts to it, so the webview is runtime-broken between those two commits (JS still references removed `#modeSwitch`). Each commit still compiles; runtime coherence returns at Task 2 and styling at Task 3. This matches this repo's established task-by-task convention.

**Dirty-tree note:** if a target file carries pre-existing uncommitted hunks, only make the specified edits; `git add <file>` sweeping pre-existing hunks into the commit is accepted practice here. If a target block doesn't match the plan, STOP and escalate (NEEDS_CONTEXT) instead of guessing.

---

### Task 1: HTML template — remove toolbar, build the composer box

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:774-817` (the `<body>` section of `getHtml()`)

- [ ] **Step 1: Replace the body markup**

In `getHtml()`, replace:

```html
<body>
	<div id="app">
		<header id="toolbar">
			<div class="mode-switch" id="modeSwitch">
				<button data-mode="ask" class="mode active">Ask</button>
				<button data-mode="edit" class="mode">Edit</button>
				<button data-mode="agent" class="mode">Agent</button>
			</div>
			<span class="spacer"></span>
			<select id="providerSelect" title="Provider"></select>
			<select id="modelSelect" title="Model"></select>
			<span id="autoSummary" class="auto-summary hidden" title="Auto routing — configure in ⚙ Providers"></span>
			<button id="refreshModels" class="icon-button" title="Refresh models from provider">↻</button>
			<button id="settingsButton" class="icon-button" title="Providers & settings">⚙</button>
		</header>

		<section id="settingsPanel" class="hidden">
```

with:

```html
<body>
	<div id="app">
		<section id="settingsPanel" class="hidden">
```

and replace:

```html
		<main id="messages"></main>

		<div id="skillChip" class="context-chip hidden"></div>
		<div id="contextChip" class="context-chip hidden"></div>
		<div id="imageChips" class="image-chips hidden"></div>

		<footer id="composer">
			<button id="attachButton" class="icon-button" title="Attach active file / selection">📎</button>
			<textarea id="input" rows="1" placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"></textarea>
			<button id="enhanceButton" class="icon-button" title="Enhance prompt with AI">✨</button>
			<button id="sendButton" title="Send">Send</button>
			<button id="stopButton" class="hidden" title="Stop">Stop</button>
		</footer>
	</div>
```

with:

```html
		<main id="messages"></main>

		<footer id="composer">
			<div class="composer-box">
				<div id="skillChip" class="context-chip hidden"></div>
				<div id="contextChip" class="context-chip hidden"></div>
				<div id="imageChips" class="image-chips hidden"></div>
				<div class="composer-input-row">
					<textarea id="input" rows="1" placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"></textarea>
					<button id="sendButton" class="send-button" title="Send">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2l12 6-12 6 3-6-3-6z"/></svg>
					</button>
					<button id="stopButton" class="send-button hidden" title="Stop">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>
					</button>
				</div>
				<div class="composer-bar">
					<select id="modeSelect" class="mode-pill" title="Chat mode">
						<option value="ask">Ask</option>
						<option value="edit">Edit</option>
						<option value="agent">Agent</option>
					</select>
					<select id="providerSelect" title="Provider"></select>
					<select id="modelSelect" title="Model"></select>
					<span id="autoSummary" class="auto-summary hidden" title="Auto routing — configure in ⚙ Providers"></span>
					<button id="refreshModels" class="icon-button" title="Refresh models from provider">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 2.5v4h-4l1.62-1.62A4.98 4.98 0 0 0 3 8a5 5 0 0 0 9.9 1h1.02A6 6 0 1 1 11.83 4.17L13.5 2.5z"/></svg>
					</button>
					<span class="spacer"></span>
					<button id="attachButton" class="icon-button" title="Attach active file / selection">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10.57 2.27a2.75 2.75 0 0 1 3.89 3.89l-6.72 6.72a4.25 4.25 0 0 1-6.01-6.01l6.01-6.01.71.71-6.01 6.01a3.25 3.25 0 1 0 4.6 4.6l6.72-6.72a1.75 1.75 0 1 0-2.48-2.48L4.92 9.34a.75.75 0 0 0 1.06 1.06l5.66-5.66.71.71-5.66 5.66a1.75 1.75 0 0 1-2.48-2.48l6.36-6.36z"/></svg>
					</button>
					<button id="enhanceButton" class="icon-button" title="Enhance prompt with AI">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1l1.5 4L14 6.5 9.5 8 8 12 6.5 8 2 6.5 6.5 5 8 1zm5 9l.75 2 2 .75-2 .75L13 15.5l-.75-2-2-.75 2-.75L13 10z"/></svg>
					</button>
					<button id="settingsButton" class="icon-button" title="Providers & settings">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.1 1l.35 1.79c.47.16.91.4 1.31.69l1.72-.6 1.1 1.9-1.37 1.19a5.6 5.6 0 0 1 0 1.56l1.37 1.19-1.1 1.9-1.72-.6c-.4.29-.84.53-1.31.69L9.1 15H6.9l-.35-1.79a5.5 5.5 0 0 1-1.31-.69l-1.72.6-1.1-1.9 1.37-1.19a5.6 5.6 0 0 1 0-1.56L2.42 7.28l1.1-1.9 1.72.6c.4-.29.84-.53 1.31-.69L6.9 1h2.2zM8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5z"/></svg>
					</button>
				</div>
			</div>
		</footer>
	</div>
```

(Note the settings panel `<section>` now sits directly under `#app` before `#messages` — it just loses the toolbar above it, its own markup is untouched.)

- [ ] **Step 2: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors. (Webview is runtime-broken until Task 2 — expected intermediate state.)

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "openvs-chat: composer-box markup with inline SVG icons"
```

---

### Task 2: main.js — adapt to modeSelect and SVG buttons

**Files:**
- Modify: `extensions/openvs-chat/media/main.js` (element refs ~line 39, `updateModeAvailability` ~392, `setMode` ~518, `enhance`/`endEnhance` ~552-564, mode event binding ~732)

- [ ] **Step 1: Swap the element ref**

Replace:

```js
		modeSwitch: $('modeSwitch'),
```

with:

```js
		modeSelect: /** @type {HTMLSelectElement} */ ($('modeSelect')),
```

- [ ] **Step 2: Adapt `setMode` to a select**

Replace:

```js
	function setMode(next) {
		mode = next;
		for (const btn of els.modeSwitch.querySelectorAll('.mode')) {
			btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
		}
		els.input.placeholder = mode === 'edit'
			? 'Describe the change to the active file…'
			: mode === 'agent'
				? 'Give the agent a task (it can read/edit files and run commands)…'
				: 'Ask anything… (Enter to send, Shift+Enter for newline)';
		saveState();
	}
```

with:

```js
	function setMode(next) {
		mode = next;
		els.modeSelect.value = mode;
		els.input.placeholder = mode === 'edit'
			? 'Describe the change to the active file…'
			: mode === 'agent'
				? 'Give the agent a task (it can read/edit files and run commands)…'
				: 'Ask anything… (Enter to send, Shift+Enter for newline)';
		saveState();
	}
```

- [ ] **Step 3: Adapt `updateModeAvailability` to option-level disabling**

Replace:

```js
	function updateModeAvailability() {
		const agentBtn = els.modeSwitch.querySelector('[data-mode="agent"]');
		if (!agentBtn) { return; }
		// Auto always routes Agent to a tool-capable implementation model, so it's always available.
		if (isAuto()) {
			agentBtn.toggleAttribute('disabled', false);
			agentBtn.title = 'Auto runs plan → implement → review across your configured models.';
			return;
		}
		const p = currentProvider();
		const model = els.modelSelect.value || (p && p.model) || '';
		const supported = !p || modelSupportsTools(p, model);
		agentBtn.toggleAttribute('disabled', !supported);
		agentBtn.title = supported ? '' : `Model "${model}" does not support Agent mode (tool calling). Choose a tool-capable model.`;
		if (!supported && mode === 'agent') { setMode('ask'); }
	}
```

with:

```js
	function updateModeAvailability() {
		const agentOpt = /** @type {HTMLOptionElement | null} */ (els.modeSelect.querySelector('option[value="agent"]'));
		if (!agentOpt) { return; }
		// Auto always routes Agent to a tool-capable implementation model, so it's always available.
		if (isAuto()) {
			agentOpt.disabled = false;
			els.modeSelect.title = 'Auto runs plan → implement → review across your configured models.';
			return;
		}
		const p = currentProvider();
		const model = els.modelSelect.value || (p && p.model) || '';
		const supported = !p || modelSupportsTools(p, model);
		agentOpt.disabled = !supported;
		els.modeSelect.title = supported ? 'Chat mode' : `Model "${model}" does not support Agent mode (tool calling). Choose a tool-capable model.`;
		if (!supported && mode === 'agent') { setMode('ask'); }
	}
```

- [ ] **Step 4: Stop mutating the enhance button's textContent (would destroy the SVG)**

Replace:

```js
	function enhance() {
		const text = els.input.value.trim();
		if (!text || streaming || enhancing) { return; }
		enhancing = true;
		els.enhanceButton.disabled = true;
		els.enhanceButton.textContent = '⏳';
		vscode.postMessage({ type: 'enhancePrompt', text, provider: selectedProvider, model: els.modelSelect.value });
	}
	function endEnhance() {
		enhancing = false;
		els.enhanceButton.disabled = false;
		els.enhanceButton.textContent = '✨';
	}
```

with:

```js
	function enhance() {
		const text = els.input.value.trim();
		if (!text || streaming || enhancing) { return; }
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
```

- [ ] **Step 5: Replace the mode-switch click binding with a select change binding**

Replace:

```js
	els.modeSwitch.addEventListener('click', (e) => {
		const btn = /** @type {HTMLElement} */ (e.target);
		const m = btn.getAttribute && btn.getAttribute('data-mode');
		if (m && !btn.hasAttribute('disabled')) { setMode(m); }
	});
```

with:

```js
	els.modeSelect.addEventListener('change', () => setMode(els.modeSelect.value));
```

- [ ] **Step 6: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors. Also grep to confirm no stale references remain:
`grep -n "modeSwitch" extensions/openvs-chat/media/main.js` → no matches.

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/media/main.js
git commit -m "openvs-chat: drive mode from a select, keep SVG buttons intact"
```

---

### Task 3: main.css — composer-box styles, drop toolbar styles

**Files:**
- Modify: `extensions/openvs-chat/media/main.css` (remove `#toolbar` + `.mode-switch` blocks ~lines 25-54; restyle `#composer`/`#input`/selects; append new classes)

- [ ] **Step 1: Remove the dead toolbar and mode-switch styles**

Delete these blocks entirely:

```css
#toolbar {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 6px;
	border-bottom: 1px solid var(--vscode-panel-border, transparent);
	flex-wrap: wrap;
}
```

```css
.mode-switch {
	display: inline-flex;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #888));
	border-radius: 6px;
	overflow: hidden;
}
.mode-switch .mode {
	background: transparent;
	color: var(--vscode-foreground);
	border: none;
	padding: 3px 9px;
	cursor: pointer;
	font-size: 0.85em;
}
.mode-switch .mode.active {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
.mode-switch .mode[disabled] { opacity: 0.4; cursor: not-allowed; }
```

(Keep `.spacer` — the composer bar reuses it.)

- [ ] **Step 2: Restyle the selects for the bar**

Replace:

```css
#modelSelect {
	max-width: 38%;
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, transparent);
	border-radius: 4px;
	padding: 3px 4px;
}

#providerSelect {
	flex: 0 0 auto;
	max-width: 45%;
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, transparent);
	border-radius: 4px;
	padding: 3px 4px;
}
```

with:

```css
#modelSelect, #providerSelect {
	flex: 0 1 auto;
	min-width: 0;
	max-width: 34%;
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border, transparent);
	border-radius: 4px;
	padding: 2px 3px;
	font-size: 0.85em;
}
```

- [ ] **Step 3: Replace the old composer/input styles**

Replace:

```css
#composer {
	display: flex;
	align-items: flex-end;
	gap: 6px;
	padding: 8px;
	border-top: 1px solid var(--vscode-panel-border, transparent);
}

#input {
	flex: 1 1 auto;
	resize: none;
	max-height: 200px;
	min-height: 28px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	border-radius: 4px;
	padding: 6px 8px;
	font-family: inherit;
	font-size: inherit;
	line-height: 1.4;
}

#sendButton, #stopButton {
	flex: 0 0 auto;
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	border-radius: 4px;
	padding: 6px 14px;
	cursor: pointer;
	height: 30px;
}
#sendButton:hover, #stopButton:hover {
	background: var(--vscode-button-hoverBackground);
}
#stopButton {
	background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
}
```

with:

```css
#composer {
	padding: 8px;
}

.composer-box {
	display: flex;
	flex-direction: column;
	gap: 4px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #3c3c3c));
	border-radius: 8px;
	background: var(--vscode-input-background);
	padding: 6px 8px;
}
.composer-box:focus-within {
	border-color: var(--vscode-focusBorder, #007fd4);
}

.composer-input-row {
	display: flex;
	align-items: flex-end;
	gap: 6px;
}

#input {
	flex: 1 1 auto;
	resize: none;
	max-height: 200px;
	min-height: 28px;
	background: transparent;
	color: var(--vscode-input-foreground);
	border: none;
	outline: none;
	padding: 4px 2px;
	font-family: inherit;
	font-size: inherit;
	line-height: 1.4;
}

.send-button {
	flex: 0 0 auto;
	width: 26px;
	height: 26px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	border-radius: 50%;
	cursor: pointer;
	margin-bottom: 3px;
}
.send-button:hover {
	background: var(--vscode-button-hoverBackground);
}
#stopButton {
	background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
	color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
}

.composer-bar {
	display: flex;
	align-items: center;
	gap: 5px;
	flex-wrap: wrap;
}

.mode-pill {
	flex: 0 0 auto;
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	border-radius: 10px;
	padding: 2px 8px;
	font-size: 0.85em;
	cursor: pointer;
}

.icon-button svg { display: block; }

.icon-button.busy {
	opacity: 0.5;
	animation: composer-busy-spin 1.2s linear infinite;
}
@keyframes composer-busy-spin {
	from { transform: rotate(0deg); }
	to { transform: rotate(360deg); }
}
```

- [ ] **Step 4: Chips sit inside the box now — tighten their margins**

Replace:

```css
.context-chip {
	margin: 0 10px 6px; padding: 4px 8px; font-size: 0.85em;
```

with:

```css
.context-chip {
	margin: 0 0 4px; padding: 4px 8px; font-size: 0.85em;
```

and replace:

```css
.image-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 0 10px 6px;
	align-self: flex-start;
}
```

with:

```css
.image-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 0 0 4px;
	align-self: flex-start;
}
```

- [ ] **Step 5: Auto-summary fits the bar**

Find the existing `.auto-summary` rule (search `auto-summary` in the file) and, whatever its current properties, replace the whole rule with:

```css
.auto-summary {
	flex: 1 1 auto;
	min-width: 0;
	font-size: 0.8em;
	color: var(--vscode-descriptionForeground);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors. Also confirm no dead selectors remain:
`grep -n "mode-switch\|#toolbar" extensions/openvs-chat/media/main.css` → no matches.

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/media/main.css
git commit -m "openvs-chat: composer-box styling, drop toolbar styles"
```

---

### Task 4: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full compile check**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors.

- [ ] **Step 2: Layout matches the approved mockup** (Extension Development Host: `F5` or `--extensionDevelopmentPath=extensions/openvs-chat`)

1. No top toolbar. One bordered box at the bottom: textarea with round ➤ send at its right; below it a bar with mode pill, provider dropdown, model dropdown, ↻ (left) and 📎 ✨ ⚙ SVG icons (right).
2. Box border highlights with the theme focus color when the textarea has focus.

- [ ] **Step 3: Mode behavior**

1. Mode pill switches Ask / Edit / Agent; placeholder text changes per mode.
2. Pick a provider/model combo that is NOT tool-capable (e.g. OpenAI `gpt-3.5-turbo-instruct` typed manually, or any non-matching id): Agent option in the pill is disabled with the explanatory tooltip on the select; if Agent was active, mode falls back to Ask.
3. Select 🤖 Auto in the provider dropdown: model dropdown + ↻ hide, routing summary text appears in the bar, Agent option re-enables.

- [ ] **Step 4: Streaming + actions**

1. Send a message: send button swaps to the square stop button; textarea and ✨ disable; stop works; on completion send returns.
2. ✨ enhance: button dims/spins while running, restores after.
3. 📎 attach, ⚙ settings (opens/closes existing panel), ↻ refresh models — all work unchanged.
4. Paste an image: chip renders INSIDE the box above the text; ✕ removes it; skill/context chips same.
5. Enter sends, Shift+Enter newlines, `/help` slash command still works.

- [ ] **Step 5: Themes + narrow widths**

1. Toggle light/dark theme: all composer colors follow (no hardcoded-looking artifacts).
2. Drag the sidebar narrow: bar wraps gracefully, nothing overflows horizontally.

- [ ] **Step 6: Record results**

Any failure is a bug against this plan — fix before declaring done.
