/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentRunner, RunResult } from './agent/agentRunner';
import { COMPACT_MARKER, compactMessages, shouldCompact } from './agent/compaction';
import { trimMessages } from './agent/context';
import { contextBudgetFor, contextWindowFor } from './agent/contextWindow';
import { APPROVAL_POLICIES, parseApprovalPolicy } from './agent/guardrails';
import { ApprovalRequest, ApprovalResult, ToolApprover, UserQuestion } from './agent/tools';
import { AutoOrchestrator } from './auto/orchestrator';
import { AUTO_ROLES, AutoRole, RoleRouter } from './auto/router';
import { WebAuthManager } from './auth';
import { McpManager } from './mcp/manager';
import { supportsNativeSignIn } from './oauth';
import { buildEnvContext } from './persona/envContext';
import { modeDoctrine, personaBase } from './persona/prompts';
import { ThinkingStreamParser, formatThinking, stripHistoryThinking, stripThinking } from './persona/thinking';
import { ProviderRegistry } from './providers/registry';
import { ChatMessage, ChatProvider, ModelEntry, entrySupportsTools, isAbortError, modelSupportsVision, streamChatWithContinuation } from './providers/types';
import { RulesProvider } from './rules';
import { SkillRegistry } from './skills';
import { CHAT_APP_HTML } from './webviewHtml';

/**
 * The chat modes. 'ask' (read-only Q&A over the open editors), 'plan' (plan the requirement,
 * no changes) and 'agent' (full tool loop) are user-selectable; 'edit' survives only as the
 * internal mode behind the inline Fix/Doc/Optimize/Edit code actions.
 */
type ChatMode = 'ask' | 'plan' | 'edit' | 'agent';
export type InlineKind = 'explain' | 'fix' | 'doc' | 'optimize' | 'tests' | 'edit';

/** Sentinel provider id selecting the role-routed "Auto" pipeline instead of one provider. */
const AUTO_PROVIDER = '__auto__';
/**
 * Default agent step budget. Sized for real work — "find the bugs in this extension and
 * fix them" is dozens of reads, edits, builds and re-checks — rather than a quick Q&A.
 * The budget exists only as a runaway backstop; stopping a task that is still making
 * progress is the failure mode users actually hit, so it is set well above real tasks.
 */
const DEFAULT_MAX_STEPS = 100;

/**
 * Step budget for the Ask/Plan read-only tool loop. Lower than Agent mode (it only reads),
 * but high enough to survey a codebase — the old cap of 8 ended investigations mid-search.
 */
const MAX_READ_ONLY_STEPS = 30;

/** A unique id for one send, used to fence out messages from a superseded run. */
function newRunId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True for an abort raised by {@link AbortController}, which is never an error to report. */
// Re-exported from the provider layer so the host and the agent loop agree on what a
// cancellation looks like; a narrower local copy meant Stop could surface as an error.

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
	/** Identifies one run within a tab, so a superseded run's messages can be ignored. */
	runId?: string;
	/** Archived conversations mirrored from the webview for cross-restart persistence. */
	history?: HistoryEntry[];
	/** Correlates a `promptResponse` with the approval/question the host is waiting on. */
	promptId?: string;
	/** The user's reply to that prompt (shape depends on the prompt type). */
	response?: Record<string, unknown>;
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
const APPROVAL_LEVELS: readonly string[] = APPROVAL_POLICIES;

/**
 * Backs the AI Chat webview view. Renders the UI and drives the three modes
 * (Ask / Plan / Agent), provider configuration, model listing, and context.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'openvsChat.view';

	private view?: vscode.WebviewView;
	/** Approval/question round-trips currently awaiting a reply from the webview. */
	private readonly pendingPrompts = new Map<string, (reply: Record<string, unknown>) => void>();
	private promptSeq = 0;
	/** The detached Settings editor tab, when open (see {@link openSettingsWindow}). */
	private settingsPanel?: vscode.WebviewPanel;
	/** One in-flight request per chat tab, so parallel conversations don't cancel each other. */
	private readonly activeRequests = new Map<string, AbortController>();
	/**
	 * Steering messages typed while an agent run is in flight, per chat tab.
	 *
	 * Each carries the run it was typed into. A tab's queue outlives any single run — a
	 * message posted as one run ends arrives after the next has started — so delivering
	 * the whole queue to whoever drains it next handed the user's correction to the wrong
	 * task. An empty `runId` comes from a webview that predates the stamp and is accepted
	 * by whichever run drains it, which is the old behaviour.
	 */
	private readonly steerQueues = new Map<string, Array<{ runId: string; text: string }>>();

	/**
	 * Drains the steering messages belonging to `runId`, discarding any left behind by a
	 * run that has already ended. Returned as plain text for the agent loop.
	 */
	private drainSteering(sessionId: string, runId: string): string[] {
		const queued = this.steerQueues.get(sessionId);
		if (!queued?.length) {
			return [];
		}
		this.steerQueues.delete(sessionId);
		return queued.filter(entry => !entry.runId || entry.runId === runId).map(entry => entry.text);
	}
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
		this.router = new RoleRouter(registry, id => this.modelCache.get(id));
		this.skills = new SkillRegistry(context.extensionUri);
	}

	/** The base system prompt: project rules + the configured system prompt + all active skills. */
	private async baseSystem(): Promise<string> {
		const env = vscode.workspace.getConfiguration('openvsChat').get<boolean>('persona.environment') !== false ? await buildEnvContext() : '';
		let base = await this.rules.composeSystem(personaBase(env, this.registry.getSystemPrompt()));
		const MAX_SKILL_CHARS = 16_000;
		for (const skillId of this.activeSkillIds()) {
			const skill = await this.skills.get(skillId);
			if (skill?.instructions) {
				const instructions = skill.instructions.length > MAX_SKILL_CHARS
					? `${skill.instructions.slice(0, MAX_SKILL_CHARS)}\n\n…[skill truncated to fit the prompt budget]`
					: skill.instructions;
				base = `${base}\n\n## Active skill: ${skill.name}\n${instructions}`;
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
			(m: WebviewToHost) => this.dispatchMessage(m), undefined, this.context.subscriptions);

		const sub = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openvsChat')) {
				void this.postConfig();
			}
		});
		webviewView.onDidDispose(() => {
			sub.dispose();
			// Forgetting the handle matters: `post` to a disposed webview is a silent
			// no-op, so a run parked on an approval would wait on a card that can never
			// be drawn, let alone answered. Dropping it makes promptUser fall back to a
			// native dialog, and settles whatever was already in flight.
			if (this.view === webviewView) {
				this.view = undefined;
			}
			this.flushPrompts();
		});
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

	// --- User prompts (approvals & questions) ------------------------------------

	/**
	 * Posts a prompt into the chat tab that raised it and waits for the user's reply.
	 *
	 * Resolves `undefined` when there is no webview to render into, so the caller can
	 * fall back to a native dialog. Rejects with an AbortError when the run is stopped,
	 * so pressing Stop tears down a run that is parked on a question instead of leaving
	 * it waiting forever.
	 */
	async promptUser(
		message: Record<string, unknown> & { type: string },
		sessionId: string,
		runId: string,
		signal: AbortSignal,
	): Promise<Record<string, unknown> | undefined> {
		if (!this.view) {
			return undefined;
		}
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		// The run is now blocked on this card, so the panel holding it has to be on
		// screen. A hidden view keeps its DOM (retainContextWhenHidden), which means the
		// question would sit there unseen while the task silently stalled.
		if (!this.view.visible) {
			void vscode.commands.executeCommand('openvsChat.view.focus');
		}
		const id = `p${++this.promptSeq}`;
		return new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
			const onAbort = () => {
				if (!this.pendingPrompts.delete(id)) {
					return;
				}
				this.post({ type: 'promptCancel', id, sessionId, runId });
				reject(new DOMException('Aborted', 'AbortError'));
			};
			this.pendingPrompts.set(id, reply => {
				signal.removeEventListener('abort', onAbort);
				resolve(reply);
			});
			signal.addEventListener('abort', onAbort);
			this.post({ ...message, id, sessionId, runId });
		});
	}

	/** Delivers a webview reply to whichever prompt is waiting on it. */
	private resolvePrompt(message: WebviewToHost): void {
		const id = message.promptId;
		if (!id) {
			return;
		}
		const settle = this.pendingPrompts.get(id);
		if (!settle) {
			return; // already aborted or answered twice
		}
		this.pendingPrompts.delete(id);
		settle(message.response ?? {});
	}

	/**
	 * Settles every waiting prompt as unanswered. An empty reply reads as "denied" to an
	 * approval and as "dismissed" to a question — both of which the agent loop handles —
	 * whereas leaving the promise pending strands the run forever.
	 */
	private flushPrompts(): void {
		const waiting = [...this.pendingPrompts.values()];
		this.pendingPrompts.clear();
		for (const settle of waiting) {
			settle({});
		}
	}

	/** Builds the per-run channel the agent uses to reach the user. */
	private approverFor(sessionId: string, runId: string, signal: AbortSignal): ToolApprover {
		return new SessionApprover(this, sessionId, runId, signal);
	}

	// --- Message handling -------------------------------------------------------

	/**
	 * Entry point for webview messages. The listener can't await, so a rejection here
	 * would otherwise vanish and leave the tab stuck mid-run with no explanation.
	 */
	private dispatchMessage(message: WebviewToHost): void {
		void this.handleMessage(message).catch(err => {
			if (isAbortError(err)) {
				return;
			}
			const post = this.sessionPost(message.sessionId || 'default');
			post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			post({ type: 'done' });
		});
	}

	private async handleMessage(message: WebviewToHost): Promise<void> {
		switch (message.type) {
			case 'ready':
				// The webview was (re)created, so every card it was showing is gone. Settle
				// the waiting prompts as unanswered instead of leaving those runs parked on
				// a question no one can ever see, let alone answer.
				this.flushPrompts();
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
			case 'promptResponse':
				this.resolvePrompt(message);
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
					queue.push({ runId: message.runId ?? '', text: message.text.trim() });
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

	/**
	 * Binds a session id (chat tab) and a run id into every message of a send pipeline.
	 * The run id lets the webview ignore stragglers from a superseded run: without it a
	 * cancelled run's trailing `done` would end the run that replaced it, blanking the
	 * bubble and re-enabling Send while the new answer was still streaming.
	 */
	private sessionPost(sessionId: string, runId = ''): SessionPost {
		return m => this.post({ ...m, sessionId, runId });
	}

	private async handleSend(message: WebviewToHost): Promise<void> {
		const mode: ChatMode = message.mode ?? 'ask';
		const sessionId = message.sessionId || 'default';
		// The webview mints the id when it starts the run so it can fence messages from
		// the moment it sends; the fallback covers programmatic sends (inline actions).
		const runId = message.runId || newRunId();
		const post = this.sessionPost(sessionId, runId);
		const fail = (text: string) => { post({ type: 'error', message: text }); post({ type: 'done' }); };

		if (message.provider === AUTO_PROVIDER) {
			await this.handleAutoSend(mode, message, sessionId, runId);
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

		// A re-send in the same tab supersedes that tab's previous request; other tabs run on.
		this.activeRequests.get(sessionId)?.abort();
		const controller = new AbortController();
		this.activeRequests.set(sessionId, controller);

		try {
			// Built inside the try: a failure while assembling the prompt (rules file,
			// environment probe, attached context) must still report an error and a `done`,
			// or the tab stays stuck "streaming" forever.
			const history: ChatMessage[] = this.sanitizeHistory(message.messages ?? []);
			const readTools = (mode === 'ask' || mode === 'plan') && !!provider.runAgentStep && this.modelToolCapable(providerId, provider, model);
			const systemPrompt = this.buildSystemPrompt(mode, await this.baseSystem(), !!message.inline, readTools);
			const assembled: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
			const context = await this.resolveContext(mode, message.context);
			if (context) {
				assembled.push({ role: 'user', content: `Context for the request:\n\n${context.content}` });
			}
			assembled.push(...history);

			// Compact the assembled request, protecting the system prompt, any attached
			// context, and the request itself.
			const keepHead = assembled.length - history.length + 1;
			const messages = await this.compactHistory(
				provider,
				assembled,
				keepHead,
				{ model, apiKey: apiKey ?? '', baseUrl: params.baseUrl, maxTokens: params.maxTokens, signal: controller.signal },
				post,
			);

			if (mode === 'agent') {
				this.reportStop(post, await this.runAgent(provider, messages, { ...params, signal: controller.signal }, post, sessionId, runId, keepHead));
			} else if (readTools) {
				// Ask/Plan get the read-only tool loop when the model can call tools: the
				// model reads/lists/searches whatever files it needs to answer or plan,
				// but has no write or command tools, so it cannot change anything.
				this.reportStop(post, await this.runReadOnlyAgent(provider, messages, { ...params, signal: controller.signal }, post, sessionId, runId, keepHead));
			} else {
				await this.runStreaming(provider, messages, { ...params, signal: controller.signal }, mode, post);
			}
		} catch (err) {
			// Only a genuine abort is silent. Previously any error was dropped whenever the
			// controller happened to be aborted, which hid real provider failures.
			if (!isAbortError(err)) {
				post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			// Both cleanups are gated on still owning the session: a superseded run's
			// `finally` fires *after* its replacement has started, and an ungated delete
			// would throw away the new run's steering queue.
			if (this.activeRequests.get(sessionId) === controller) {
				this.activeRequests.delete(sessionId);
				this.steerQueues.delete(sessionId);
			}
			post({ type: 'done' });
		}
	}

	/**
	 * Turns a run's {@link RunResult} into the one status message the user sees. A run
	 * that ends for any reason other than "finished" must say so — silence reads as the
	 * chat having crashed mid-task.
	 */
	private reportStop(post: SessionPost, result: RunResult): void {
		if (result.reason === 'done' || !result.detail) {
			return;
		}
		if (result.reason === 'filtered' || result.reason === 'refused' || result.reason === 'stalled' || result.reason === 'error') {
			post({ type: 'error', message: result.detail });
			return;
		}
		post({ type: 'info', message: result.detail });
	}

	/**
	 * Handles a send when the selected "provider" is Auto. In Agent mode this runs the
	 * full plan → implement → review pipeline across the role-routed models; otherwise
	 * it routes to the single best role model (plan for Ask/Plan, code for inline edits).
	 */
	private async handleAutoSend(mode: ChatMode, message: WebviewToHost, sessionId: string, runId: string): Promise<void> {
		const history: ChatMessage[] = this.sanitizeHistory(message.messages ?? []);
		const post = this.sessionPost(sessionId, runId);
		const fail = (text: string) => { post({ type: 'error', message: text }); };

		this.activeRequests.get(sessionId)?.abort();
		const controller = new AbortController();
		this.activeRequests.set(sessionId, controller);

		try {
			const context = await this.resolveContext(mode, message.context);
			const contextText = context?.content;

			if (mode === 'agent') {
				const maxSteps = this.configuredMaxSteps();
				await this.mcp.ensureStarted();
				const approver = this.approverFor(sessionId, runId, controller.signal);
				const orchestrator = new AutoOrchestrator(this.registry, this.router, approver, maxSteps, this.mcp,
					id => this.modelCache.get(id));
				let stepThinking: ThinkingStreamParser | undefined;
				post({ type: 'todos', items: [] });
				// An Auto run is still an agent run to the user, and the webview offers the
				// same mid-run steering box. Without draining the queue here those messages
				// were rendered as delivered and then silently discarded.
				this.steerQueues.delete(sessionId);
				await orchestrator.run(
					{
						history, contextText, baseSystemPrompt: await this.baseSystem(), signal: controller.signal,
						steering: () => this.drainSteering(sessionId, runId),
					},
					{
						phase: (role, a, streaming) => {
							stepThinking?.flush();
							stepThinking = streaming ? new ThinkingStreamParser(text => post({ type: 'token', delta: text })) : undefined;
							post({
								type: 'autoPhase', role, label: a.roleLabel,
								provider: a.providerLabel, model: a.model, source: a.source, streaming,
							});
						},
						token: delta => stepThinking ? stepThinking.push(delta) : post({ type: 'token', delta }),
						agentStepStart: () => {
							stepThinking?.flush();
							stepThinking = new ThinkingStreamParser(text => post({ type: 'token', delta: text }));
							post({ type: 'agentStepStart' });
						},
						agentStepEnd: content => { stepThinking?.flush(); stepThinking = undefined; post({ type: 'agentStepEnd', content: formatThinking(content) }); },
						onToolStart: call => post({ type: 'toolStart', id: call.id, name: call.name, args: call.args }),
						onToolEnd: (call, result, isError) => post({ type: 'toolEnd', id: call.id, name: call.name, result, isError }),
						note: text => post({ type: 'info', message: text }),
						onTodos: items => post({ type: 'todos', items }),
					},
				);
				stepThinking?.flush();
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
			if (!isAbortError(err)) {
				post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			}
		} finally {
			if (this.activeRequests.get(sessionId) === controller) {
				this.activeRequests.delete(sessionId);
				this.steerQueues.delete(sessionId);
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
		const thinking = new ThinkingStreamParser(text => post({ type: 'token', delta: text }));
		let full = '';
		let truncated = false;
		try {
			({ text: full, truncated } = await streamChatWithContinuation(provider, {
				// A long chat would otherwise grow until the provider rejects it outright.
				messages: trimMessages(messages, this.configuredContextTokens(params.model, params.maxTokens, provider.info.id)),
				...params,
				onToken: delta => thinking.push(delta),
				onNotice: text => post({ type: 'info', message: text }),
			}));
		} finally {
			// Flushed even on failure, or text buffered inside an unclosed <thinking> tag
			// is lost along with the error.
			thinking.flush();
		}
		if (truncated) {
			post({
				type: 'info',
				message: 'The reply is still incomplete after several automatic continuations — raise "openvsChat.maxTokens" or ask for a smaller piece at a time.',
			});
		}
		// A reply with no text at all leaves nothing on screen: the webview drops the empty
		// bubble, so without this the tab just goes quiet and re-enables Send, which reads
		// as the chat having died. Same failure the agent loop guards against.
		if (!full.trim()) {
			post({
				type: 'error',
				message: `${provider.info.label} returned an empty response. This is usually a transient provider error — send the message again, or switch models.`,
			});
		}
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
		sessionId: string,
		runId: string,
		keepHead?: number,
	): Promise<RunResult> {
		const configured = this.configuredMaxSteps();
		const approver = this.approverFor(sessionId, runId, params.signal);
		const runner = new AgentRunner(provider, approver, Math.min(configured, MAX_READ_ONLY_STEPS), {
			readOnly: true,
			maxContextTokens: this.configuredContextTokens(params.model, params.maxTokens, provider.info.id),
			contextWindow: this.windowFor(provider.info.id, params.model),
			keepHead,
		});
		let stepThinking: ThinkingStreamParser | undefined;
		return runner.run(messages, params, {
			onStepStart: () => { stepThinking = new ThinkingStreamParser(text => post({ type: 'token', delta: text })); post({ type: 'agentStepStart' }); },
			onToken: delta => stepThinking?.push(delta),
			onStepEnd: content => { stepThinking?.flush(); stepThinking = undefined; post({ type: 'agentStepEnd', content: formatThinking(content) }); },
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
		runId: string,
		keepHead?: number,
	): Promise<RunResult> {
		const maxSteps = this.configuredMaxSteps();
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
		const runner = new AgentRunner(provider, this.approverFor(sessionId, runId, params.signal), maxSteps, {
			mcp: this.mcp,
			maxContextTokens: this.configuredContextTokens(params.model, params.maxTokens, provider.info.id),
			contextWindow: this.windowFor(provider.info.id, params.model),
			keepHead,
			steering: () => this.drainSteering(sessionId, runId),
		});
		let stepThinking: ThinkingStreamParser | undefined;
		post({ type: 'todos', items: [] });
		// The agent reads from disk, so a save by the user is a change it cannot otherwise
		// see: its repeat-read guard would answer the re-read with "nothing has changed
		// since". Deliberately only saves — a file watcher would also fire for every artifact
		// a build writes, clearing the guard constantly and reopening the re-read loop.
		const saves = vscode.workspace.onDidSaveTextDocument(() => runner.invalidateReads());
		try {
			return await runner.run(messages, params, {
				onStepStart: () => { stepThinking = new ThinkingStreamParser(text => post({ type: 'token', delta: text })); post({ type: 'agentStepStart' }); },
				onToken: delta => stepThinking?.push(delta),
				onStepEnd: content => { stepThinking?.flush(); stepThinking = undefined; post({ type: 'agentStepEnd', content: formatThinking(content) }); },
				onToolStart: call => post({ type: 'toolStart', id: call.id, name: call.name, args: call.args }),
				onToolEnd: (call, result, isError) =>
					post({ type: 'toolEnd', id: call.id, name: call.name, result, isError }),
				onNote: text => post({ type: 'info', message: text }),
				onTodos: items => post({ type: 'todos', items }),
			});
		} finally {
			saves.dispose();
		}
	}

	/**
	 * The agent step budget. Generous by default: a real task (read several files, edit a
	 * few, run the build, fix what broke) routinely needs more than a dozen steps, and
	 * stopping early is what makes the assistant feel like it gave up mid-job.
	 */
	private configuredMaxSteps(): number {
		const configured = vscode.workspace.getConfiguration('openvsChat').get<number>('agent.maxSteps');
		return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_MAX_STEPS;
	}

	/**
	 * Estimated-token ceiling for the conversation sent to `model`, above which old
	 * tool output is trimmed. Derived from the model's context window unless the user
	 * pinned an explicit openvsChat.agent.maxContextTokens.
	 */
	private configuredContextTokens(model: string, maxOutputTokens: number, providerId?: string): number {
		const configured = vscode.workspace.getConfiguration('openvsChat').get<number>('agent.maxContextTokens');
		return contextBudgetFor(model, maxOutputTokens, typeof configured === 'number' ? configured : 0,
			providerId ? this.modelCache.get(providerId) : undefined);
	}

	/**
	 * The model's context window, preferring the fetched catalog's own figure (OpenRouter
	 * and other gateways report it) over the name-pattern guess.
	 */
	private windowFor(providerId: string, model: string): number {
		return contextWindowFor(model, this.modelCache.get(providerId));
	}

	/** History arrives from the webview with rendered thinking blocks still in past assistant turns; never re-send those. */
	private sanitizeHistory(history: ChatMessage[]): ChatMessage[] {
		return stripHistoryThinking(history);
	}

	/**
	 * Compacts an oversized request before dispatch: old turns are replaced by a
	 * model-written summary and the webview is told to persist the replacement, so the
	 * next send arrives already compacted instead of paying the summary again.
	 *
	 * Takes the fully assembled `messages`, not the bare history, for two reasons: the
	 * system prompt and any attached context are what actually push a request over the
	 * threshold, and every dispatch path (agent, read-only tool loop, plain streaming)
	 * then gets the same treatment. `keepHead` covers `[system, context?, the request]`
	 * so compaction can never summarize away the request itself.
	 *
	 * `replaced` counts only messages after the head, all of which came from the
	 * webview's payload, so the count it reports stays in the webview's terms.
	 */
	private async compactHistory(
		provider: ChatProvider,
		messages: ChatMessage[],
		keepHead: number,
		params: { model: string; apiKey: string; baseUrl: string; maxTokens: number; signal: AbortSignal },
		post: SessionPost,
	): Promise<ChatMessage[]> {
		// The trim budget is passed too, so compaction always precedes the lossy trim.
		const trimBudget = this.configuredContextTokens(params.model, params.maxTokens, provider.info.id);
		if (!shouldCompact(messages, this.windowFor(provider.info.id, params.model), trimBudget)) {
			return messages;
		}
		const res = await compactMessages(messages, async (toSummarize, maxTokens) => {
			let text = '';
			await provider.streamChat({
				messages: toSummarize,
				model: params.model,
				apiKey: params.apiKey,
				baseUrl: params.baseUrl,
				maxTokens,
				signal: params.signal,
				onToken: delta => { text += delta; },
			});
			return stripThinking(text);
		}, keepHead);
		if (!res) {
			return messages;
		}
		const summaryMsg = res.messages.find(m => m.content.startsWith(COMPACT_MARKER));
		post({ type: 'compacted', summary: summaryMsg?.content ?? '', replaced: res.replaced });
		post({ type: 'info', message: `Compacted ${res.replaced} earlier message(s) (~${Math.round(res.before / 1000)}k → ~${Math.round(res.after / 1000)}k tokens).` });
		return res.messages;
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
		const thinking = vscode.workspace.getConfiguration('openvsChat').get<boolean>('persona.thinking') !== false;
		return `${base}\n\n${modeDoctrine(mode, { inline, readTools, thinking })}\n\n${ChatViewProvider.CONCISE}`;
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
			const auto = vscode.workspace.getConfiguration('openvsChat').get<string>('ask.autoContext') ?? 'active';
			if (auto === 'off') {
				return undefined;
			}
			return this.openEditorsContext(auto === 'active');
		}
		return attached;
	}

	/**
	 * Collects the URIs of the files open in editor tabs (active editor first, deduped) and
	 * renders them via {@link filesContext} so Ask mode can answer questions about what's
	 * loaded. When `activeOnly` is set, only the active editor is included.
	 */
	private async openEditorsContext(activeOnly = false): Promise<AttachedContext | undefined> {
		const active = vscode.window.activeTextEditor?.document.uri;
		const seen = new Set<string>();
		const uris: vscode.Uri[] = [];
		if (active) {
			seen.add(active.toString());
			uris.push(active);
		}
		// Active-only means exactly that: with no focused editor there is nothing to
		// attach. Falling through to the tab sweep here would quietly attach every open
		// file — the expensive behavior this setting exists to avoid.
		if (activeOnly) {
			return this.filesContext(uris);
		}
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText && !seen.has(tab.input.uri.toString())) {
					seen.add(tab.input.uri.toString());
					uris.push(tab.input.uri);
				}
			}
		}
		return this.filesContext(uris);
	}

	/** Renders the given files (per-file and total capped) as one attached-context block. */
	private async filesContext(uris: vscode.Uri[]): Promise<AttachedContext | undefined> {
		const PER_FILE_CHARS = 8_000;
		const TOTAL_CHARS = 32_000;
		const active = vscode.window.activeTextEditor?.document.uri;
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
			approval: parseApprovalPolicy(vscode.workspace.getConfiguration('openvsChat').get<string>('guardrails.approval')),
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
			(m: WebviewToHost) => this.dispatchMessage(m), undefined, this.context.subscriptions);
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
	<script nonce="${nonce}">window.__OPENVS_SETTINGS_ONLY__ = ${settingsOnly ? 'true' : 'false'};
	window.__OPENVS_HERO_URI__ = ${JSON.stringify(String(mediaUri('hero.png')))};</script>
${CHAT_APP_HTML}
	<script nonce="${nonce}" src="${mediaUri('prompts.js')}"></script>
	<script nonce="${nonce}" src="${mediaUri('main.js')}"></script>
</body>
</html>`;
	}
}

/**
 * One run's channel to the user: renders approvals and questions as cards inside the
 * chat tab that raised them, and remembers "always allow" decisions for that run.
 *
 * Scoped per run rather than shared across the extension for two reasons. A single
 * global approver could not say which tab was asking — two parallel agent runs produced
 * two identical, unattributable modal dialogs — and an "always allow" granted in one
 * conversation must not silently carry into another.
 */
class SessionApprover implements ToolApprover {
	/** Action signatures the user chose not to be asked about again this run. */
	private readonly alwaysAllowed = new Set<string>();

	constructor(
		private readonly view: ChatViewProvider,
		private readonly sessionId: string,
		private readonly runId: string,
		private readonly signal: AbortSignal,
	) { }

	async confirm(request: ApprovalRequest): Promise<ApprovalResult> {
		if (this.alwaysAllowed.has(request.signature)) {
			return { approved: true };
		}
		const reply = await this.view.promptUser({
			type: 'approvalRequest',
			kind: request.kind,
			title: request.title,
			detail: request.detail,
			preview: request.preview ?? '',
			previewLanguage: request.previewLanguage ?? '',
		}, this.sessionId, this.runId, this.signal);
		if (!reply) {
			return this.nativeConfirm(request);
		}
		const approved = reply.approved === true;
		if (approved && reply.always === true) {
			this.alwaysAllowed.add(request.signature);
		}
		const feedback = typeof reply.feedback === 'string' ? reply.feedback : undefined;
		return { approved, feedback };
	}

	async ask(question: UserQuestion): Promise<string> {
		const reply = await this.view.promptUser({
			type: 'askRequest',
			question: question.question,
			options: question.options,
			multiSelect: !!question.multiSelect,
			detail: question.detail ?? '',
		}, this.sessionId, this.runId, this.signal);
		if (!reply) {
			return this.nativeAsk(question);
		}
		return typeof reply.answer === 'string' ? reply.answer : '';
	}

	/** Fallback for when the chat view isn't open: a native modal. */
	private async nativeConfirm(request: ApprovalRequest): Promise<ApprovalResult> {
		const detail = request.preview
			? `${request.detail}\n\n${request.preview.slice(0, 1_000)}`
			: request.detail;
		const choice = await vscode.window.showWarningMessage(
			request.title, { modal: true, detail }, 'Allow', 'Deny');
		return { approved: choice === 'Allow' };
	}

	/** Fallback for when the chat view isn't open: a native quick pick. */
	private async nativeAsk(question: UserQuestion): Promise<string> {
		const picked = await vscode.window.showQuickPick(
			question.options.map(o => ({ label: o.label, detail: o.description })),
			{ title: question.question, canPickMany: !!question.multiSelect, ignoreFocusOut: true },
		);
		if (!picked) {
			return '';
		}
		return Array.isArray(picked) ? picked.map(p => p.label).join(', ') : picked.label;
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
