/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentRunner } from './agent/agentRunner';
import { ToolApprover } from './agent/tools';
import { AutoOrchestrator } from './auto/orchestrator';
import { AUTO_ROLES, AutoRole, RoleRouter } from './auto/router';
import { WebAuthManager } from './auth';
import { McpManager } from './mcp/manager';
import { supportsNativeSignIn } from './oauth';
import { ProviderRegistry } from './providers/registry';
import { ChatMessage, ChatProvider, ModelEntry, entrySupportsTools, modelSupportsVision, streamChatWithContinuation } from './providers/types';
import { RulesProvider } from './rules';
import { SkillRegistry } from './skills';

/**
 * The chat modes. 'ask' (read-only Q&A over the open editors), 'plan' (plan the requirement,
 * no changes) and 'agent' (full tool loop) are user-selectable; 'edit' survives only as the
 * internal mode behind the inline Fix/Doc/Optimize/Edit code actions.
 */
type ChatMode = 'ask' | 'plan' | 'edit' | 'agent';
export type InlineKind = 'explain' | 'fix' | 'doc' | 'optimize' | 'tests' | 'edit';

/** Sentinel provider id selecting the role-routed "Auto" pipeline instead of one provider. */
const AUTO_PROVIDER = '__auto__';
const INLINE_KINDS: InlineKind[] = ['explain', 'fix', 'doc', 'optimize', 'tests', 'edit'];
const ENHANCE_SYSTEM = 'You are a prompt engineer. Rewrite the user\'s message into a clear, specific, self-contained prompt for an AI coding assistant. Preserve intent and concrete details; add structure and obvious missing specifics, but do not invent requirements. Return ONLY the improved prompt — no preamble, code fences, or commentary.';

interface AttachedContext {
	readonly label: string;
	readonly content: string;
}

interface WebviewToHost {
	type: string;
	provider?: string;
	model?: string;
	mode?: ChatMode;
	messages?: ChatMessage[];
	context?: AttachedContext;
	key?: string;
	url?: string;
	content?: string;
	role?: string;
	reviewEnabled?: boolean;
	inline?: boolean;
	command?: string;
	text?: string;
	approval?: string;
	/** Which chat tab this message belongs to; enables parallel conversations. */
	sessionId?: string;
	/** Archived conversations mirrored from the webview for cross-restart persistence. */
	history?: HistoryEntry[];
}

/** An archived conversation shown in the History panel; persisted in workspace state. */
interface HistoryEntry {
	id: string;
	title: string;
	messages: ChatMessage[];
	savedAt: number;
}

/** A function that posts to the webview with a session id pre-bound. */
type SessionPost = (message: Record<string, unknown> & { type: string }) => void;

/** The valid values of `openvsChat.guardrails.approval`, mirrored in the webview picker. */
const APPROVAL_LEVELS = ['always', 'auto-readonly', 'auto-edits', 'yolo'];

/**
 * Backs the AI Chat webview view. Renders the UI and drives the three modes
 * (Ask / Plan / Agent), provider configuration, model listing, and context.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, ToolApprover {
	public static readonly viewType = 'openvsChat.view';

	private view?: vscode.WebviewView;
	/** The detached Settings editor tab, when open (see {@link openSettingsWindow}). */
	private settingsPanel?: vscode.WebviewPanel;
	/** One in-flight request per chat tab, so parallel conversations don't cancel each other. */
	private readonly activeRequests = new Map<string, AbortController>();
	/** Steering messages typed while an agent run is in flight, per chat tab. */
	private readonly steerQueues = new Map<string, string[]>();
	private editTarget?: vscode.Uri;
	private editRange?: vscode.Range;
	private inlineEditActive = false;
	private readonly router: RoleRouter;
	private readonly rules = new RulesProvider();
	private readonly skills: SkillRegistry;
	private static readonly ACTIVE_SKILL_KEY = 'openvsChat.activeSkill';
	private static readonly HISTORY_KEY = 'openvsChat.chatHistory';
	/**
	 * Shared brevity directive appended to the chat modes so replies stay dense — this both
	 * improves readability and trims response tokens (fewer tokens re-sent as history).
	 */
	private static readonly CONCISE = 'Be concise: lead with the answer, skip preamble and filler, and do not restate the question. Prefer tight prose or short lists over padding.';

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly registry: ProviderRegistry,
		private readonly auth: WebAuthManager,
		private readonly mcp: McpManager,
	) {
		this.router = new RoleRouter(registry);
		this.skills = new SkillRegistry(context.extensionUri);
	}

	/** The base system prompt: project rules + the configured system prompt + all active skills. */
	private async baseSystem(): Promise<string> {
		let base = await this.rules.composeSystem(this.registry.getSystemPrompt());
		for (const skillId of this.activeSkillIds()) {
			const skill = await this.skills.get(skillId);
			if (skill?.instructions) {
				base = `${base}\n\n## Active skill: ${skill.name}\n${skill.instructions}`;
			}
		}
		return base;
	}

	/** Currently active skill ids, migrating the legacy single-string value to an array. */
	activeSkillIds(): string[] {
		const raw = this.context.workspaceState.get<string | string[]>(ChatViewProvider.ACTIVE_SKILL_KEY);
		if (typeof raw === 'string') {
			return raw ? [raw] : [];
		}
		return Array.isArray(raw) ? raw : [];
	}

	/** Replaces the active skill set (unknown ids are dropped); persisted per workspace. */
	async setActiveSkills(ids: string[]): Promise<void> {
		const valid: string[] = [];
		for (const id of ids) {
			if (await this.skills.get(id)) {
				valid.push(id);
			} else {
				this.post({ type: 'info', message: `Unknown skill: ${id}` });
			}
		}
		await this.context.workspaceState.update(ChatViewProvider.ACTIVE_SKILL_KEY, valid.length ? valid : undefined);
		await this.postSkills();
	}

	/** Activates a skill on top of the current set (empty id clears all). */
	async setActiveSkill(id: string): Promise<void> {
		if (!id) {
			await this.context.workspaceState.update(ChatViewProvider.ACTIVE_SKILL_KEY, undefined);
			this.post({ type: 'info', message: 'All skills deactivated.' });
			await this.postSkills();
			return;
		}
		const skill = await this.skills.get(id);
		if (!skill) {
			this.post({ type: 'info', message: `Unknown skill: ${id}` });
			return;
		}
		const active = this.activeSkillIds();
		if (!active.includes(id)) {
			await this.context.workspaceState.update(ChatViewProvider.ACTIVE_SKILL_KEY, [...active, id]);
		}
		this.post({ type: 'info', message: `Skill activated: ${skill.name}` });
		await this.postSkills();
	}

	/** Toggles one skill on/off without touching the others. */
	async toggleSkill(id: string): Promise<void> {
		const skill = await this.skills.get(id);
		if (!skill) {
			this.post({ type: 'info', message: `Unknown skill: ${id}` });
			return;
		}
		const active = this.activeSkillIds();
		const next = active.includes(id) ? active.filter(s => s !== id) : [...active, id];
		await this.context.workspaceState.update(ChatViewProvider.ACTIVE_SKILL_KEY, next.length ? next : undefined);
		this.post({ type: 'info', message: active.includes(id) ? `Skill deactivated: ${skill.name}` : `Skill activated: ${skill.name}` });
		await this.postSkills();
	}

	private async postSkills(): Promise<void> {
		const skills = await this.skills.list();
		this.post({
			type: 'skills',
			skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description })),
			active: this.activeSkillIds(),
		});
	}

	/** Pushes the archived conversations persisted in workspace state to the webview. */
	private postHistory(): void {
		const history = this.context.workspaceState.get<HistoryEntry[]>(ChatViewProvider.HISTORY_KEY) ?? [];
		this.post({ type: 'history', history });
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.webview.onDidReceiveMessage(
			(m: WebviewToHost) => this.handleMessage(m), undefined, this.context.subscriptions);

		const sub = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openvsChat')) {
				void this.postConfig();
			}
		});
		webviewView.onDidDispose(() => sub.dispose());
	}

	newChat(): void {
		this.post({ type: 'newChat' });
	}

	selectProvider(id: string): void {
		this.post({ type: 'selectProvider', provider: id });
	}

	openSettings(): void {
		this.openSettingsWindow();
	}

	/**
	 * Runs an inline-editor action on the active selection (or whole file): Explain/Tests
	 * answer in Ask mode; Fix/Doc/Optimize/Edit return a replacement that Apply writes back
	 * to exactly the selected range.
	 */
	async runInline(kind: InlineKind, instruction?: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open a file and select some code first.');
			return;
		}
		const sel = editor.selection;
		const range = sel.isEmpty
			? new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length))
			: new vscode.Range(sel.start, sel.end);
		const code = editor.document.getText(range);
		const lang = editor.document.languageId;
		const fence = '```';
		const block = `${fence}${lang}\n${code}\n${fence}`;

		const isEdit = kind === 'fix' || kind === 'doc' || kind === 'optimize' || kind === 'edit';
		const mode: ChatMode = isEdit ? 'edit' : 'ask';
		if (isEdit) {
			this.editTarget = editor.document.uri;
			this.editRange = range;
			this.inlineEditActive = true;
		}

		const prompts: Record<InlineKind, string> = {
			explain: `Explain what this ${lang} code does, concisely:\n\n${block}`,
			tests: `Write unit tests for this ${lang} code:\n\n${block}`,
			fix: `Fix any bugs in this ${lang} code and return only the corrected code:\n\n${block}`,
			doc: `Add clear doc comments to this ${lang} code and return the documented code:\n\n${block}`,
			optimize: `Improve this ${lang} code for clarity and performance without changing its behavior, and return only the improved code:\n\n${block}`,
			edit: `${instruction ?? 'Edit'} — apply this to the following ${lang} code and return only the updated code:\n\n${block}`,
		};

		await vscode.commands.executeCommand('openvsChat.view.focus');
		this.post({ type: 'inline', mode, prompt: prompts[kind], inline: isEdit });
	}

	async refreshConfig(): Promise<void> {
		await this.postConfig();
	}

	/**
	 * Call after a provider's credentials changed outside the webview (command-palette
	 * key entry / sign-in / clear): drops the cached model list so the next config push
	 * re-fetches the live models with the new credential.
	 */
	async credentialsChanged(providerId: string): Promise<void> {
		this.invalidateModelCache(providerId);
		await this.postConfig();
	}

	// --- ToolApprover -----------------------------------------------------------

	async confirm(title: string, detail: string): Promise<boolean> {
		const choice = await vscode.window.showWarningMessage(
			title, { modal: true, detail }, 'Allow', 'Deny');
		return choice === 'Allow';
	}

	// --- Message handling -------------------------------------------------------

	private async handleMessage(message: WebviewToHost): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.postConfig();
				this.postHistory();
				break;
			case 'saveHistory':
				if (Array.isArray(message.history)) {
					await this.context.workspaceState.update(ChatViewProvider.HISTORY_KEY, message.history);
				}
				break;
			case 'send':
				await this.handleSend(message);
				break;
			case 'requestOpenSettings':
				this.openSettingsWindow();
				break;
			case 'closeSettingsWindow':
				this.settingsPanel?.dispose();
				break;
			case 'stop':
				if (message.sessionId) {
					this.activeRequests.get(message.sessionId)?.abort();
				} else {
					for (const controller of this.activeRequests.values()) {
						controller.abort();
					}
				}
				break;
			case 'saveKey':
				if (message.provider && typeof message.key === 'string') {
					if (message.key.trim()) {
						await this.registry.setApiKey(message.provider, message.key.trim());
					} else {
						await this.clearKeyWithEnvNotice(message.provider);
					}
					this.invalidateModelCache(message.provider);
					await this.postConfig();
				}
				break;
			case 'clearKey':
				if (message.provider) {
					await this.clearKeyWithEnvNotice(message.provider);
					this.invalidateModelCache(message.provider);
					await this.postConfig();
				}
				break;
			case 'signIn':
				await this.handleSignIn(message.provider);
				break;
			case 'setProvider':
				// Persist real providers only; the Auto selection lives in webview state.
				if (message.provider && message.provider !== AUTO_PROVIDER && this.registry.getProvider(message.provider)) {
					await vscode.workspace.getConfiguration('openvsChat').update(
						'defaultProvider', message.provider, vscode.ConfigurationTarget.Global);
				}
				break;
			case 'setRole':
				if (message.role && (AUTO_ROLES as string[]).includes(message.role)) {
					await this.router.setConfigured(message.role as AutoRole, message.provider ?? '', message.model ?? '');
					await this.postConfig();
				}
				break;
			case 'setApproval':
				if (message.approval && APPROVAL_LEVELS.includes(message.approval)) {
					await vscode.workspace.getConfiguration('openvsChat').update(
						'guardrails.approval', message.approval, vscode.ConfigurationTarget.Global);
				}
				break;
			case 'setReviewEnabled':
				await vscode.workspace.getConfiguration('openvsChat').update(
					'auto.enableReview', !!message.reviewEnabled, vscode.ConfigurationTarget.Global);
				await this.postConfig();
				break;
			case 'setModel':
				if (message.provider && typeof message.model === 'string') {
					await this.registry.setModel(message.provider, message.model);
				}
				break;
			case 'listModels':
				await this.handleListModels(message.provider);
				break;
			case 'attachContext':
				await this.handleAttachContext();
				break;
			case 'applyEdit':
				await this.handleApplyEdit(message.content ?? '');
				break;
			case 'insertAtCursor':
				await this.handleInsertAtCursor(message.content ?? '');
				break;
			case 'testKey':
				await this.handleTestKey(message.provider);
				break;
			case 'slashInline':
				if (message.command && INLINE_KINDS.includes(message.command as InlineKind)) {
					await this.runInline(message.command as InlineKind, message.text || undefined);
				}
				break;
			case 'enhancePrompt':
				await this.handleEnhancePrompt(message);
				break;
			case 'listSkills':
				await this.postSkills();
				break;
			case 'setSkill':
				await this.setActiveSkill(message.text || '');
				break;
			case 'toggleSkill':
				await this.toggleSkill(message.text || '');
				break;
			case 'createSkill':
				await vscode.commands.executeCommand('openvsChat.createSkill');
				break;
			case 'steer':
				if (message.sessionId && message.text?.trim()) {
					const queue = this.steerQueues.get(message.sessionId) ?? [];
					queue.push(message.text.trim());
					this.steerQueues.set(message.sessionId, queue);
				}
				break;
			case 'listMcp':
				await this.postMcpStatus();
				break;
			case 'mcpAdd':
				await vscode.commands.executeCommand('openvsChat.mcpAdd');
				break;
			case 'mcpReconnect':
				this.mcp.reconnect();
				await this.postMcpStatus();
				break;
			case 'mcpOpenConfig':
				await vscode.commands.executeCommand('openvsChat.mcpOpenConfig');
				break;
			case 'openExternal':
				if (message.url) {
					await vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
			default:
				break;
		}
	}

	private async handleSignIn(providerId?: string): Promise<void> {
		if (!providerId) {
			return;
		}
		try {
			const provider = this.registry.getProvider(providerId);
			if (this.registry.getAuthUrl(providerId) || supportsNativeSignIn(providerId)) {
				// A web auth backend is configured (or the provider has a built-in
				// account login): run the browser round-trip flow.
				const ok = await this.auth.signIn(providerId);
				if (ok) {
					this.invalidateModelCache(providerId);
					vscode.window.showInformationMessage(`Signed in to ${provider?.info.label ?? providerId}.`);
				}
			} else {
				// No auth backend configured: guide the user through the provider's own
				// key page in the browser, then capture the key they paste back.
				const keyUrl = provider?.info.apiKeyUrl;
				if (keyUrl) {
					await vscode.env.openExternal(vscode.Uri.parse(keyUrl));
				}
				const key = await vscode.window.showInputBox({
					title: `Sign in to ${provider?.info.label ?? providerId}`,
					prompt: keyUrl
						? `A browser window opened at ${keyUrl}. Sign in there, create an API key, and paste it here.`
						: 'Paste your API key.',
					password: true,
					ignoreFocusOut: true,
					placeHolder: 'Paste API key…',
				});
				if (key?.trim()) {
					await this.registry.setApiKey(providerId, key.trim());
					this.invalidateModelCache(providerId);
					vscode.window.showInformationMessage(`${provider?.info.label ?? providerId} connected.`);
				}
			}
		} catch (err) {
			vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
		}
		await this.postConfig();
	}

	/** Rewrites the user's draft into a sharper prompt via the model and sends it back to the input. */
	private async handleEnhancePrompt(message: WebviewToHost): Promise<void> {
		const text = (message.text || '').trim();
		if (!text) {
			return;
		}
		let providerId = message.provider && message.provider !== AUTO_PROVIDER
			? message.provider
			: this.registry.getDefaultProviderId();
		let model = message.model && message.provider !== AUTO_PROVIDER ? message.model : '';
		if (message.provider === AUTO_PROVIDER) {
			const a = await this.router.resolveRole('plan');
			if (!a.ready) {
				this.post({ type: 'enhanceError', message: `Can't enhance — ${a.problem}` });
				return;
			}
			providerId = a.providerId;
			model = a.model;
		}
		const provider = this.registry.getProvider(providerId);
		if (!provider) {
			this.post({ type: 'enhanceError', message: `Unknown provider: ${providerId}` });
			return;
		}
		let apiKey: string | undefined;
		try {
			apiKey = await this.registry.getApiKey(providerId);
		} catch (err) {
			this.post({ type: 'enhanceError', message: err instanceof Error ? err.message : String(err) });
			return;
		}
		if (provider.info.requiresApiKey && !apiKey) {
			this.post({ type: 'enhanceError', message: `Add an API key for ${provider.info.label} first.` });
			return;
		}
		const controller = new AbortController();
		let out = '';
		try {
			await provider.streamChat({
				messages: [
					{ role: 'system', content: ENHANCE_SYSTEM },
					{ role: 'user', content: text },
				],
				model: model || this.registry.getModel(providerId),
				apiKey: apiKey ?? '',
				baseUrl: this.registry.getBaseUrl(providerId),
				maxTokens: this.registry.getMaxTokens(),
				signal: controller.signal,
				onToken: delta => { out += delta; },
			});
			this.post({ type: 'enhancedPrompt', text: out.trim() || text });
		} catch (err) {
			this.post({ type: 'enhanceError', message: err instanceof Error ? err.message : String(err) });
		}
	}

	/** Verifies a provider's key works by listing its models, reporting the result inline. */
	private async handleTestKey(providerId?: string): Promise<void> {
		if (!providerId) {
			return;
		}
		const provider = this.registry.getProvider(providerId);
		if (!provider) {
			this.post({ type: 'info', message: `Unknown provider: ${providerId}` });
			return;
		}
		const controller = new AbortController();
		try {
			const models = await this.registry.listModels(providerId, controller.signal);
			this.modelCache.set(providerId, models);
			this.post({ type: 'info', message: `${provider.info.label}: connection OK — ${models.length} models available.` });
			this.post({ type: 'models', provider: providerId, models });
		} catch (err) {
			this.post({ type: 'info', message: `${provider.info.label}: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	/** Inserts a code block at the active editor's cursor (the "Insert" button on code blocks). */
	private async handleInsertAtCursor(content: string): Promise<void> {
		if (!content) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this.post({ type: 'info', message: 'Open a file to insert the snippet into.' });
			return;
		}
		await editor.edit(builder => builder.insert(editor.selection.active, content));
		await vscode.window.showTextDocument(editor.document);
	}

	private async handleListModels(providerId?: string): Promise<void> {
		if (!providerId) {
			return;
		}
		const controller = new AbortController();
		try {
			const models = await this.registry.listModels(providerId, controller.signal);
			this.modelCache.set(providerId, models);
			this.post({ type: 'models', provider: providerId, models });
		} catch (err) {
			this.post({ type: 'info', message: err instanceof Error ? err.message : String(err) });
		}
	}

	private async handleAttachContext(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			this.post({ type: 'info', message: 'Open a file to attach it as context.' });
			return;
		}
		const sel = editor.selection;
		const hasSelection = !sel.isEmpty;
		const text = hasSelection ? editor.document.getText(sel) : editor.document.getText();
		const name = vscode.workspace.asRelativePath(editor.document.uri);
		const label = hasSelection ? `${name} (selection)` : name;
		this.post({
			type: 'context',
			context: { label, content: `File: ${name} (${editor.document.languageId})\n\n${text}` },
		});
	}

	/**
	 * Clears the stored secret for a provider. If an environment variable is also set for
	 * it, that still wins on the next lookup (see {@link ProviderRegistry.getApiKey}), so we
	 * tell the user rather than letting the panel silently keep reporting the key as set.
	 */
	private async clearKeyWithEnvNotice(providerId: string): Promise<void> {
		await this.registry.clearApiKey(providerId);
		if (this.registry.hasEnvKey(providerId)) {
			const provider = this.registry.getProvider(providerId);
			this.post({
				type: 'info',
				message: `${provider?.info.label ?? providerId} is still using the API key from its environment variable. Unset that environment variable (and restart) to fully clear it.`,
			});
		}
	}

	private async handleApplyEdit(content: string): Promise<void> {
		if (!this.editTarget || !content) {
			vscode.window.showWarningMessage('No edit to apply.');
			return;
		}
		try {
			const doc = await vscode.workspace.openTextDocument(this.editTarget);
			const isWholeFileReplace = !this.editRange;
			const originalLength = doc.getText().length;
			// A whole-file replacement that's drastically shorter than the original is the
			// signature of a truncated model response slipping past the fence-balance check
			// (e.g. the model closed the block early with a "// ... rest unchanged" comment).
			if (isWholeFileReplace && originalLength > 200 && content.length < originalLength * 0.4) {
				const choice = await vscode.window.showWarningMessage(
					`The proposed content for ${vscode.workspace.asRelativePath(this.editTarget)} is only ${Math.round(content.length / originalLength * 100)}% of the file's current size. This can mean the model's response was truncated. Apply anyway?`,
					{ modal: true }, 'Apply Anyway');
				if (choice !== 'Apply Anyway') {
					return;
				}
			}
			const edit = new vscode.WorkspaceEdit();
			const range = this.editRange ?? new vscode.Range(doc.positionAt(0), doc.positionAt(originalLength));
			edit.replace(this.editTarget, range, content);
			await vscode.workspace.applyEdit(edit);
			await vscode.window.showTextDocument(doc);
			vscode.window.showInformationMessage(`Applied changes to ${vscode.workspace.asRelativePath(this.editTarget)}.`);
		} catch (err) {
			vscode.window.showErrorMessage(`Could not apply edit: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Binds a session id (chat tab) into every message of a send pipeline. */
	private sessionPost(sessionId: string): SessionPost {
		return m => this.post({ ...m, sessionId });
	}

	private async handleSend(message: WebviewToHost): Promise<void> {
		const mode: ChatMode = message.mode ?? 'ask';
		const sessionId = message.sessionId || 'default';
		const post = this.sessionPost(sessionId);
		const fail = (text: string) => { post({ type: 'error', message: text }); post({ type: 'done' }); };

		if (message.provider === AUTO_PROVIDER) {
			await this.handleAutoSend(mode, message, sessionId);
			return;
		}

		const providerId = message.provider || this.registry.getDefaultProviderId();
		const provider = this.registry.getProvider(providerId);
		if (!provider) {
			fail(`Unknown provider: ${providerId}`);
			return;
		}

		let apiKey: string | undefined;
		try {
			apiKey = await this.registry.getApiKey(providerId);
		} catch (err) {
			// e.g. an expired web sign-in session that could not be refreshed.
			fail(err instanceof Error ? err.message : String(err));
			return;
		}
		if (provider.info.requiresApiKey && !apiKey) {
			post({
				type: 'error',
				message: `No API key for ${provider.info.label}. Open the Providers panel (gear icon) to add a key or sign in.`,
				needsKey: true,
				provider: providerId,
			});
			post({ type: 'done' });
			return;
		}

		const model = (message.model && message.model.trim()) || this.registry.getModel(providerId);

		if (mode === 'agent' && !this.modelToolCapable(providerId, provider, model)) {
			fail(`The model "${model}" doesn't support Agent mode (tool calling). Pick a model marked 🔧 in the dropdown, or use Ask/Plan.`);
			return;
		}

		if ((message.messages ?? []).at(-1)?.images?.length && !modelSupportsVision(provider.info, model)) {
			fail(`The model "${model}" doesn't support image input. Remove the attached image(s) or pick a vision-capable model.`);
			return;
		}

		const params = {
			model,
			apiKey: apiKey ?? '',
			baseUrl: this.registry.getBaseUrl(providerId),
			maxTokens: this.effectiveMaxTokens(mode, !!message.inline),
		};

		// Build the message list with system prompt and any attached/auto context.
		const history: ChatMessage[] = message.messages ?? [];
		const readTools = (mode === 'ask' || mode === 'plan') && !!provider.runAgentStep && this.modelToolCapable(providerId, provider, model);
		const systemPrompt = this.buildSystemPrompt(mode, await this.baseSystem(), !!message.inline, readTools);
		const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
		const context = await this.resolveContext(mode, message.context);
		if (context) {
			messages.push({ role: 'user', content: `Context for the request:\n\n${context.content}` });
		}
		messages.push(...history);

		// A re-send in the same tab supersedes that tab's previous request; other tabs run on.
		this.activeRequests.get(sessionId)?.abort();
		const controller = new AbortController();
		this.activeRequests.set(sessionId, controller);

		try {
			if (mode === 'agent') {
				await this.runAgent(provider, messages, { ...params, signal: controller.signal }, post, sessionId);
			} else if (readTools) {
				// Ask/Plan get the read-only tool loop when the model can call tools: the
				// model reads/lists/searches whatever files it needs to answer or plan,
				// but has no write or command tools, so it cannot change anything.
				await this.runReadOnlyAgent(provider, messages, { ...params, signal: controller.signal }, post);
			} else {
				await this.runStreaming(provider, messages, { ...params, signal: controller.signal }, mode, post);
			}
		} catch (err) {
			if (!(err instanceof DOMException && err.name === 'AbortError') && !controller.signal.aborted) {
				post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			if (this.activeRequests.get(sessionId) === controller) {
				this.activeRequests.delete(sessionId);
			}
			this.steerQueues.delete(sessionId);
			post({ type: 'done' });
		}
	}

	/**
	 * Handles a send when the selected "provider" is Auto. In Agent mode this runs the
	 * full plan → implement → review pipeline across the role-routed models; otherwise
	 * it routes to the single best role model (plan for Ask/Plan, code for inline edits).
	 */
	private async handleAutoSend(mode: ChatMode, message: WebviewToHost, sessionId: string): Promise<void> {
		const history: ChatMessage[] = message.messages ?? [];
		const post = this.sessionPost(sessionId);
		const fail = (text: string) => { post({ type: 'error', message: text }); };

		this.activeRequests.get(sessionId)?.abort();
		const controller = new AbortController();
		this.activeRequests.set(sessionId, controller);

		try {
			const context = await this.resolveContext(mode, message.context);
			const contextText = context?.content;

			if (mode === 'agent') {
				const maxSteps = vscode.workspace.getConfiguration('openvsChat').get<number>('agent.maxSteps') ?? 12;
				await this.mcp.ensureStarted();
				const orchestrator = new AutoOrchestrator(this.registry, this.router, this, maxSteps, this.mcp);
				await orchestrator.run(
					{ history, contextText, baseSystemPrompt: await this.baseSystem(), signal: controller.signal },
					{
						phase: (role, a, streaming) => post({
							type: 'autoPhase', role, label: a.roleLabel,
							provider: a.providerLabel, model: a.model, source: a.source, streaming,
						}),
						token: delta => post({ type: 'token', delta }),
						agentStepStart: () => post({ type: 'agentStepStart' }),
						agentStepEnd: content => post({ type: 'agentStepEnd', content }),
						onToolStart: call => post({ type: 'toolStart', id: call.id, name: call.name, args: call.args }),
						onToolEnd: (call, result, isError) => post({ type: 'toolEnd', id: call.id, name: call.name, result, isError }),
						note: text => post({ type: 'info', message: text }),
					},
				);
			} else {
				// Ask/Plan → planning/reasoning model; inline Edit → implementation model.
				const role: AutoRole = mode === 'edit' ? 'code' : 'plan';
				const a = await this.router.resolveRole(role);
				if (!a.ready) {
					fail(`Auto can't run ${a.roleLabel} — ${a.problem}`);
					return;
				}
				const provider = this.registry.getProvider(a.providerId);
				if (!provider) {
					fail(`Provider "${a.providerId}" is unavailable.`);
					return;
				}
				if (history.at(-1)?.images?.length && !modelSupportsVision(provider.info, a.model)) {
					fail(`The Auto-routed "${a.roleLabel}" model "${a.model}" doesn't support image input. Remove the attached image(s), pin a vision-capable model for this role, or switch off Auto.`);
					return;
				}
				post({
					type: 'autoPhase', role, label: a.roleLabel,
					provider: a.providerLabel, model: a.model, source: a.source, streaming: true,
				});
				const messages: ChatMessage[] = [{ role: 'system', content: this.buildSystemPrompt(mode, await this.baseSystem(), !!message.inline) }];
				if (contextText) {
					messages.push({ role: 'user', content: `Context for the request:\n\n${contextText}` });
				}
				messages.push(...history);
				await this.runStreaming(provider, messages, {
					model: a.model,
					apiKey: (await this.registry.getApiKey(a.providerId)) ?? '',
					baseUrl: this.registry.getBaseUrl(a.providerId),
					maxTokens: this.effectiveMaxTokens(mode, !!message.inline),
					signal: controller.signal,
				}, mode, post);
			}
		} catch (err) {
			if (!(err instanceof DOMException && err.name === 'AbortError') && !controller.signal.aborted) {
				post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			if (this.activeRequests.get(sessionId) === controller) {
				this.activeRequests.delete(sessionId);
			}
			post({ type: 'done' });
		}
	}

	private async runStreaming(
		provider: ChatProvider,
		messages: ChatMessage[],
		params: { model: string; apiKey: string; baseUrl: string; maxTokens: number; signal: AbortSignal },
		mode: ChatMode,
		post: SessionPost,
	): Promise<void> {
		// Streams with transparent auto-continuation: a max-token cutoff is resumed
		// in place (Claude-style) instead of the reply stopping midway.
		const { text: full } = await streamChatWithContinuation(provider, {
			messages,
			...params,
			onToken: delta => post({ type: 'token', delta }),
		});
		if (mode === 'edit') {
			// An odd number of ``` fences means the response was cut off mid code-block
			// (almost always hitting the max-tokens limit on a large file). Surface that
			// instead of silently dropping the edit or, worse, letting a truncated file
			// through to Apply.
			const fenceCount = (full.match(/```/g) ?? []).length;
			if (fenceCount % 2 === 1) {
				post({
					type: 'error',
					message: 'The response was cut off before the code block finished (likely the "openvsChat.maxTokens" limit). No edit was proposed — try a smaller selection or raise Max Tokens in settings.',
				});
			} else {
				const code = extractLastCodeBlock(full);
				if (code && this.editTarget) {
					post({
						type: 'editProposal',
						content: code,
						path: vscode.workspace.asRelativePath(this.editTarget),
					});
					// Apply the edit directly instead of waiting for the user to press Apply -
					// Edit mode's job is to change the file, not to hand back text. The
					// truncation safety check in handleApplyEdit still guards bad replaces.
					await this.handleApplyEdit(code);
				}
			}
		}
	}

	/**
	 * Whether a model can call tools, preferring the fetched catalog metadata (which is
	 * authoritative for providers like OpenRouter that report it) over the heuristic
	 * per-provider patterns.
	 */
	private modelToolCapable(providerId: string, provider: ChatProvider, model: string): boolean {
		return entrySupportsTools(provider.info, this.modelCache.get(providerId), model);
	}

	/**
	 * Runs Ask/Plan with the read-only tool loop: the model can read, list and search
	 * workspace files to ground its answer or plan, but gets no write/command tools.
	 */
	private async runReadOnlyAgent(
		provider: ChatProvider,
		messages: ChatMessage[],
		params: { model: string; apiKey: string; baseUrl: string; maxTokens: number; signal: AbortSignal },
		post: SessionPost,
	): Promise<void> {
		const configured = vscode.workspace.getConfiguration('openvsChat').get<number>('agent.maxSteps') ?? 12;
		const runner = new AgentRunner(provider, this, Math.min(configured, 8), { readOnly: true });
		await runner.run(messages, params, {
			onStepStart: () => post({ type: 'agentStepStart' }),
			onToken: delta => post({ type: 'token', delta }),
			onStepEnd: content => post({ type: 'agentStepEnd', content }),
			onToolStart: call => post({ type: 'toolStart', id: call.id, name: call.name, args: call.args }),
			onToolEnd: (call, result, isError) =>
				post({ type: 'toolEnd', id: call.id, name: call.name, result, isError }),
			onNote: text => post({ type: 'info', message: text }),
		});
	}

	private async runAgent(
		provider: ChatProvider,
		messages: ChatMessage[],
		params: { model: string; apiKey: string; baseUrl: string; maxTokens: number; signal: AbortSignal },
		post: SessionPost,
		sessionId: string,
	): Promise<void> {
		const maxSteps = vscode.workspace.getConfiguration('openvsChat').get<number>('agent.maxSteps') ?? 12;
		await this.mcp.ensureStarted();
		// Tell the model about connected MCP tools so it actually reaches for them.
		const mcpTools = this.mcp.tools();
		if (mcpTools.length && messages[0]?.role === 'system') {
			const names = mcpTools.slice(0, 20).map(t => t.name).join(', ');
			messages = [
				{
					...messages[0],
					content: `${messages[0].content}\n\nYou also have ${mcpTools.length} MCP tools (names start with "mcp__"): ${names}${mcpTools.length > 20 ? ', …' : ''}. Prefer them when they fit better than the generic file/command tools.`,
				},
				...messages.slice(1),
			];
		}
		this.steerQueues.delete(sessionId);
		const runner = new AgentRunner(provider, this, maxSteps, {
			mcp: this.mcp,
			steering: () => {
				const queued = this.steerQueues.get(sessionId) ?? [];
				this.steerQueues.delete(sessionId);
				return queued;
			},
		});
		await runner.run(messages, params, {
			onStepStart: () => post({ type: 'agentStepStart' }),
			onToken: delta => post({ type: 'token', delta }),
			onStepEnd: content => post({ type: 'agentStepEnd', content }),
			onToolStart: call => post({ type: 'toolStart', id: call.id, name: call.name, args: call.args }),
			onToolEnd: (call, result, isError) =>
				post({ type: 'toolEnd', id: call.id, name: call.name, result, isError }),
			onNote: text => post({ type: 'info', message: text }),
		});
	}

	/**
	 * Non-inline Edit mode asks the model to return an entire file in one code block, which
	 * can need far more headroom than a normal chat reply. `maxTokens` is only an upper bound
	 * (it doesn't force the model to use it), so raising it here is free insurance against the
	 * model's response getting cut off mid-file.
	 */
	private effectiveMaxTokens(mode: ChatMode, inline: boolean): number {
		const configured = this.registry.getMaxTokens();
		if (mode === 'edit' && !inline) {
			return Math.max(configured, 8192);
		}
		return configured;
	}

	private buildSystemPrompt(mode: ChatMode, base: string, inline = false, readTools = false): string {
		if (mode === 'edit') {
			if (inline) {
				return `${base}\n\nEDIT mode on a code selection. Return ONLY the revised code in one fenced block — no surrounding file, no commentary outside it.`;
			}
			return `${base}\n\nEDIT mode. The user gives a file; return the COMPLETE updated file in one fenced block, no commentary outside it unless asked.`;
		}
		if (mode === 'agent') {
			return `${base}\n\nAGENT mode: you have tools to read, list, create and edit files and run commands in the workspace. Own the task — plan briefly, then execute: read what you need, write or edit files, run builds/tests to verify. Ask only when truly ambiguous; when done, summarize what changed. ${ChatViewProvider.CONCISE}`;
		}
		if (mode === 'plan') {
			const tools = readTools
				? ' You have READ-ONLY tools (read_file, list_dir, search_files) — use them to ground the plan in the real files before writing it.'
				: '';
			return `${base}\n\nPLAN mode.${tools} Produce a concrete plan for exactly the stated requirement: goal, assumptions, ordered steps naming the files/components each touches, and risks or open questions. Do NOT write full implementations or whole files, and never claim to have made changes — you can only plan. If ambiguous, state the interpretation you planned for. ${ChatViewProvider.CONCISE}`;
		}
		const tools = readTools
			? ' You have READ-ONLY tools (read_file, list_dir, search_files) — use them freely to open, explore, trace and debug any file, not just the ones the user has open.'
			: '';
		return `${base}\n\nASK mode (read-only).${tools} Answer directly, grounded in the actual code when relevant. You cannot modify files or run commands — if a change is needed, describe it and suggest switching to Agent mode. ${ChatViewProvider.CONCISE}`;
	}

	private async resolveContext(mode: ChatMode, attached?: AttachedContext): Promise<AttachedContext | undefined> {
		// Inline edits pre-set editTarget/editRange and embed the code in the prompt, so we
		// keep them and add no extra context. Otherwise reset and fall back to whole-file.
		const inline = this.inlineEditActive;
		this.inlineEditActive = false;
		if (!inline) {
			this.editTarget = undefined;
			this.editRange = undefined;
		}
		if (mode === 'edit') {
			if (inline && this.editTarget) {
				return undefined;
			}
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				this.editTarget = editor.document.uri;
				this.editRange = undefined;
				const name = vscode.workspace.asRelativePath(editor.document.uri);
				return { label: name, content: `File: ${name} (${editor.document.languageId})\n\n${editor.document.getText()}` };
			}
		}
		// Ask answers over what the user is looking at: fall back to the files open in
		// editor tabs when nothing was attached explicitly. Plan intentionally gets only
		// the user's requirement (plus anything they attached) — it plans, it doesn't read.
		if (mode === 'ask' && !attached) {
			return this.openEditorsContext();
		}
		return attached;
	}

	/**
	 * Collects the content of the files open in editor tabs (active editor first) so Ask
	 * mode can answer questions about what's loaded, capped per file and in total so a
	 * wall of tabs can't blow the prompt budget.
	 */
	private async openEditorsContext(): Promise<AttachedContext | undefined> {
		const PER_FILE_CHARS = 8_000;
		const TOTAL_CHARS = 32_000;
		const active = vscode.window.activeTextEditor?.document.uri;
		const seen = new Set<string>();
		const uris: vscode.Uri[] = [];
		if (active) {
			seen.add(active.toString());
			uris.push(active);
		}
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText && !seen.has(tab.input.uri.toString())) {
					seen.add(tab.input.uri.toString());
					uris.push(tab.input.uri);
				}
			}
		}
		const parts: string[] = [];
		let total = 0;
		let included = 0;
		for (const uri of uris) {
			let doc: vscode.TextDocument;
			try {
				doc = await vscode.workspace.openTextDocument(uri);
			} catch {
				continue; // non-text or unreadable tab — skip it
			}
			const name = vscode.workspace.asRelativePath(uri);
			let text = doc.getText();
			if (text.length > PER_FILE_CHARS) {
				text = `${text.slice(0, PER_FILE_CHARS)}\n… [truncated, ${text.length} chars total]`;
			}
			if (total + text.length > TOTAL_CHARS) {
				parts.push(`File: ${name} (${doc.languageId}) — open but omitted for length.`);
				continue;
			}
			total += text.length;
			included++;
			parts.push(`File: ${name} (${doc.languageId})${uri.toString() === active?.toString() ? ' [active editor]' : ''}\n\n${text}`);
		}
		if (!included) {
			return undefined;
		}
		return {
			label: `Open editors (${included} file${included === 1 ? '' : 's'})`,
			content: `These files are currently open in the user's editor:\n\n${parts.join('\n\n---\n\n')}`,
		};
	}

	/** Sends the connected MCP servers' status + tool count to the settings panel. */
	private async postMcpStatus(): Promise<void> {
		await this.mcp.ensureStarted();
		this.post({ type: 'mcp', status: this.mcp.getStatus(), toolCount: this.mcp.tools().length });
	}

	private async postConfig(): Promise<void> {
		const providers = await this.registry.resolveAll();
		const roles = await this.router.resolveAll();
		this.post({
			type: 'config',
			providers,
			selectedProvider: this.registry.getDefaultProviderId(),
			auto: { roles, reviewEnabled: this.router.isReviewEnabled() },
			approval: vscode.workspace.getConfiguration('openvsChat').get<string>('guardrails.approval') || 'auto-edits',
		});
		await this.postSkills();
		this.pushAvailableModels(providers);
	}

	/**
	 * Fetches the live model list for every provider that can be queried (key stored, env
	 * key, or no key required) and streams each result to the webview. Results are cached
	 * per provider so repeated config refreshes don't hammer the APIs; the cache is
	 * invalidated when a key changes (see `invalidateModelCache`).
	 */
	private readonly modelCache = new Map<string, ModelEntry[]>();

	private pushAvailableModels(providers: { id: string; requiresApiKey: boolean; hasApiKey: boolean; hasEnvKey: boolean }[]): void {
		for (const p of providers) {
			if (p.requiresApiKey && !p.hasApiKey && !p.hasEnvKey) {
				// No credentials (any more): reset the webview's live list so it falls
				// back to the suggested models instead of showing a stale fetch.
				this.post({ type: 'models', provider: p.id, models: [] });
				continue;
			}
			const cached = this.modelCache.get(p.id);
			if (cached) {
				this.post({ type: 'models', provider: p.id, models: cached });
				continue;
			}
			const controller = new AbortController();
			void this.registry.listModels(p.id, controller.signal).then(models => {
				if (models.length) {
					this.modelCache.set(p.id, models);
					this.post({ type: 'models', provider: p.id, models });
				}
			}, () => { /* model listing is best-effort; the suggested models remain usable */ });
		}
	}

	private invalidateModelCache(providerId: string): void {
		this.modelCache.delete(providerId);
	}

	private post(message: Record<string, unknown> & { type: string }): void {
		// Broadcast to both surfaces so the sidebar chat and the detached Settings editor
		// tab stay in sync (config/skills/MCP pushes are idempotent; each view renders only
		// the parts it shows).
		void this.view?.webview.postMessage(message);
		void this.settingsPanel?.webview.postMessage(message);
	}

	/**
	 * Opens (or reveals) the Settings editor tab: the same webview UI as the sidebar, but
	 * booted in settings-only mode so it fills a full editor column instead of the cramped
	 * side panel. Reuses all the existing provider/skill/MCP/auto-routing rendering.
	 */
	openSettingsWindow(): void {
		if (this.settingsPanel) {
			this.settingsPanel.reveal(vscode.ViewColumn.Active);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'openvsChatSettings',
			'OpenVS Settings',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
			},
		);
		panel.webview.html = this.getHtml(panel.webview, true);
		panel.webview.onDidReceiveMessage(
			(m: WebviewToHost) => this.handleMessage(m), undefined, this.context.subscriptions);
		panel.onDidDispose(() => { this.settingsPanel = undefined; });
		this.settingsPanel = panel;
	}

	private getHtml(webview: vscode.Webview, settingsOnly = false): string {
		const mediaUri = (file: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
		const nonce = getNonce();
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https: data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`font-src ${webview.cspSource}`,
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${mediaUri('main.css')}" rel="stylesheet" />
	<title>${settingsOnly ? 'OpenVS Settings' : 'OpenVS Thor'}</title>
</head>
<body class="${settingsOnly ? 'settings-window' : ''}">
	<script nonce="${nonce}">window.__OPENVS_SETTINGS_ONLY__ = ${settingsOnly ? 'true' : 'false'};</script>
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

			<div class="settings-header"><h2>Agent permissions</h2></div>
			<p class="hint">Controls when Agent mode pauses for your approval. <strong>Full Auto</strong> never asks (guardrails like protected paths and denied commands still apply); <strong>Default</strong> auto-approves file edits but asks before running commands.</p>
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
						<option value="auto-readonly">🛡 Reads Free</option>
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
	<script nonce="${nonce}" src="${mediaUri('main.js')}"></script>
</body>
</html>`;
	}
}

function extractLastCodeBlock(text: string): string | undefined {
	const matches = [...text.matchAll(/```[a-zA-Z0-9+#._-]*\n([\s\S]*?)```/g)];
	if (!matches.length) {
		return undefined;
	}
	return matches[matches.length - 1][1].replace(/\n$/, '');
}

function getNonce(): string {
	let text = '';
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
