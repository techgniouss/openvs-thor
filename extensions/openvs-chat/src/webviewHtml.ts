/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The static markup of the chat webview, lifted out of {@link ChatViewProvider.getHtml}
 * so it can be checked without an extension host.
 *
 * `media/main.js` looks every one of these elements up by id at load time and caches the
 * result in its `els` table; a typo or a deleted element yields `null`, and the failure
 * only surfaces later as an unrelated TypeError deep inside a render path.
 * `scripts/test-webview.mjs` asserts that this markup and that lookup list still agree,
 * which is only possible while both sides read from here.
 */
export const CHAT_APP_HTML = `
	<div id="app">
		<div id="tabs"></div>
		<section id="settingsPanel" class="hidden">
			<div class="settings-header panel-header">
				<h2>Settings</h2>
				<button id="closeSettings" class="panel-close" title="Close settings (Esc)">✕ Close</button>
			</div>
			<div class="settings-header"><h2>Providers</h2></div>
			<div id="providerList"></div>
			<p class="hint">Keys are stored in the OS secret store. Anthropic and OpenAI support signing in with your <strong>Claude</strong> or <strong>ChatGPT</strong> subscription account, and <strong>OpenRouter</strong> offers a one-click browser sign-in that creates a key for you — no pasting needed. You can also set <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, <code>NVIDIA_API_KEY</code>, <code>OPENROUTER_API_KEY</code>, <code>MOONSHOT_API_KEY</code> or <code>DASHSCOPE_API_KEY</code>, or configure a web sign-in URL via <code>openvsChat.&lt;provider&gt;.authUrl</code>.</p>

			<div class="settings-header"><h2>General</h2></div>
			<p class="hint">Custom instructions sent with every conversation, and the reply length cap requested from the model. A backend's own per-request allowance may cap replies further regardless of this setting.</p>
			<div class="general-settings">
				<label class="field-label" for="systemPromptInput">System prompt</label>
				<textarea id="systemPromptInput" rows="3" class="settings-textarea"
					placeholder="You are a helpful AI coding assistant…"></textarea>
				<div class="settings-row"><button id="saveSystemPrompt" class="mini-button">Save</button></div>
				<label class="field-label" for="maxTokensInput">Max reply tokens</label>
				<div class="settings-row">
					<input id="maxTokensInput" type="number" min="1" step="1" class="settings-number" />
					<button id="saveMaxTokens" class="mini-button">Save</button>
				</div>
				<label class="field-label" for="rulesInput">Rules</label>
				<p class="hint">Always-on steering combined with any rule files found in the workspace (<code>AGENTS.md</code>, <code>.openvs/rules.md</code>, …) — soft guidance the model can weigh, unlike the hard guardrails below.</p>
				<textarea id="rulesInput" rows="3" class="settings-textarea"
					placeholder="e.g. Always write tests first. Prefer named exports."></textarea>
				<div class="settings-row"><button id="saveRules" class="mini-button">Save</button></div>
				<label class="field-label" for="maxStepsInput">Max agent steps</label>
				<div class="settings-row">
					<input id="maxStepsInput" type="number" min="1" step="1" class="settings-number" />
					<button id="saveMaxSteps" class="mini-button">Save</button>
				</div>
				<label class="field-label" for="maxRunMinutesInput">Max agent run time (minutes)</label>
				<div class="settings-row">
					<input id="maxRunMinutesInput" type="number" min="1" step="1" class="settings-number" />
					<button id="saveMaxRunMinutes" class="mini-button">Save</button>
				</div>
			</div>

			<div class="settings-header"><h2>Agent permissions</h2></div>
			<p class="hint">Controls when Agent mode pauses for your approval. <strong>Always Ask</strong> confirms every write and command; <strong>Default</strong> auto-approves file edits but asks before running commands; <strong>Full Auto</strong> never asks (the hard guardrails — protected paths, denied commands, workspace confinement — still apply). Reading, listing and searching never ask.</p>
			<div id="approvalList"></div>

			<div class="settings-header"><h2>Skills</h2>
				<button id="newSkill" class="mini-button" title="Create a new skill file in this workspace (.openvs/skills)">＋ New Skill</button>
			</div>
			<p class="hint">Skills are named instruction packs that steer every message while active. Activate as many as you like — they combine. Create your own — it opens as a Markdown file you can edit any time.</p>
			<div id="skillList"></div>

			<div class="settings-header"><h2>MCP servers</h2>
				<span class="header-actions">
					<button id="mcpAdd" class="mini-button" title="Register a new MCP server">＋ Add Server</button>
					<button id="mcpReconnectBtn" class="mini-button" title="Restart all MCP connections">Reconnect</button>
					<button id="mcpOpenConfig" class="mini-button" title="Open .openvs/mcp.json">Open Config</button>
				</span>
			</div>
			<p class="hint">MCP (Model Context Protocol) servers add extra tools the agent can call (databases, browsers, APIs…). Tools appear to the agent as <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.</p>
			<div id="mcpList" class="hint">Loading…</div>

			<div class="settings-header"><h2>Auto routing</h2></div>
			<p class="hint">When the provider is set to <strong>🤖 Auto</strong>, each phase runs on its own model: <strong>Ask</strong> and <strong>Plan</strong> use the planning model, inline edits use the implementation model, and <strong>Agent</strong> runs the full <em>plan → implement → review</em> pipeline. Leave a role on <em>Auto-select</em> to pick the best model from the keys you've configured.</p>
			<div id="autoRoutingList"></div>
			<label class="review-toggle"><input type="checkbox" id="enableReview" /> Run a review pass after Agent runs</label>
			<label class="review-toggle" title="Splits the plan into steps and runs a sub-agent per step instead of one continuous Agent run.">
				<input type="checkbox" id="enableDecompose" /> Decompose Agent runs into per-step sub-agents</label>
		</section>

		<section id="historyPanel" class="hidden">
			<div class="settings-header panel-header">
				<h2>Chat History</h2>
				<button id="closeHistory" class="panel-close" title="Close history (Esc)">✕ Close</button>
			</div>
			<p class="hint">Closed chats are saved here automatically. Click one to reopen it in a tab.</p>
			<div id="historyList"></div>
		</section>

		<main id="messages"></main>

		<footer id="composer">
			<div class="composer-box">
				<div id="skillChip" class="context-chip hidden"></div>
				<div id="contextChip" class="context-chip hidden"></div>
				<div id="queueChips" class="queue-chips hidden"></div>
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
						<option value="plan">Plan</option>
						<option value="agent">Agent</option>
					</select>
					<select id="approvalSelect" class="approval-pill hidden" title="Agent permissions — when the agent must ask before acting">
						<option value="always">🛡 Always Ask</option>
						<option value="auto-edits">🛡 Default</option>
						<option value="yolo">⚡ Full Auto</option>
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
					<button id="historyButton" class="icon-button" title="Chat history">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm0 1.3a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 8 2.8zm.65 1.7v3.23l2.55 1.53-.67 1.11L7.35 8.6V4.5h1.3z"/></svg>
					</button>
					<button id="settingsButton" class="icon-button" title="Providers & settings">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.1 1l.35 1.79c.47.16.91.4 1.31.69l1.72-.6 1.1 1.9-1.37 1.19a5.6 5.6 0 0 1 0 1.56l1.37 1.19-1.1 1.9-1.72-.6c-.4.29-.84.53-1.31.69L9.1 15H6.9l-.35-1.79a5.5 5.5 0 0 1-1.31-.69l-1.72.6-1.1-1.9 1.37-1.19a5.6 5.6 0 0 1 0-1.56L2.42 7.28l1.1-1.9 1.72.6c.4-.29.84-.53 1.31-.69L6.9 1h2.2zM8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5z"/></svg>
					</button>
				</div>
			</div>
		</footer>
	</div>
`;
