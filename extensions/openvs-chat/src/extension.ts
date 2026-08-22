/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WebAuthManager } from './auth';
import { RoleRouter } from './auto/router';
import { ChatViewProvider, InlineKind } from './chatViewProvider';
import { registerInlineCompletions } from './completions/inlineProvider';
import { StatsRow } from './completions/stats';
import { generateCommitMessage } from './git/commitMessage';
import { McpManager } from './mcp/manager';
import { loadEnvFile } from './oauth';
import { ProviderRegistry } from './providers/registry';
import { setStreamIdleTimeout } from './providers/types';
import { getRelayUrl, isRemoteEnabled } from './remote/config';
import { deployRelay } from './remote/deploy';
import { RemoteService } from './remote/remoteService';
import { SkillRegistry } from './skills';

/**
 * Providers only use `fetch`, so the stream stall timeout is pushed in from here and
 * kept in step with the setting.
 */
function applyStreamIdleTimeout(): void {
	const ms = vscode.workspace.getConfiguration('openvsChat').get<number>('stream.idleTimeoutMs');
	if (typeof ms === 'number') {
		setStreamIdleTimeout(ms);
	}
}

/**
 * The active {@link ChatViewProvider}, held at module scope only so {@link deactivate} can
 * reach it — `activate` otherwise keeps every other collaborator as a local, wired together
 * once and never referenced again outside the closures registered on `context.subscriptions`.
 */
let activeViewProvider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	loadEnvFile(context.extensionPath);
	applyStreamIdleTimeout();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('openvsChat.stream.idleTimeoutMs')) {
			applyStreamIdleTimeout();
		}
	}));
	const registry = new ProviderRegistry(context.secrets);
	const router = new RoleRouter(registry);
	const auth = new WebAuthManager(registry);
	const mcp = new McpManager();
	const viewProvider = new ChatViewProvider(context, registry, auth, mcp);
	activeViewProvider = viewProvider;
	context.subscriptions.push(mcp);
	const remoteService = new RemoteService(context, viewProvider);
	context.subscriptions.push(remoteService);

	const completions = registerInlineCompletions(registry, router);
	context.subscriptions.push(completions);
	context.subscriptions.push(vscode.commands.registerCommand('openvsChat.completions.toggle', async () => {
		const cfg = vscode.workspace.getConfiguration('openvsChat.completions');
		await cfg.update('enabled', !(cfg.get<boolean>('enabled') ?? true), vscode.ConfigurationTarget.Global);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('openvsChat.completions.trigger', async () => {
		await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('openvsChat.completions.showStats', () => {
		const provider = completions.getActiveProvider();
		if (!provider) {
			vscode.window.showInformationMessage('OpenVS Thor inline completions are currently off — there is nothing to report.');
			return;
		}
		completions.channel.appendLine(formatStatsReport(provider.report()));
		completions.channel.show(true);
	}));

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, viewProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.registerUriHandler(auth),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('openvsChat.focus', () =>
			vscode.commands.executeCommand('openvsChat.view.focus')),
		vscode.commands.registerCommand('openvsChat.newChat', () => viewProvider.newChat()),
		vscode.commands.registerCommand('openvsChat.openSettings', () => viewProvider.openSettingsWindow()),
		vscode.commands.registerCommand('openvsChat.selectProvider', () => selectProvider(registry, viewProvider)),
		vscode.commands.registerCommand('openvsChat.configureProvider', (presetId?: string) =>
			configureProvider(registry, viewProvider, presetId)),
		vscode.commands.registerCommand('openvsChat.signIn', (presetId?: string) =>
			signIn(registry, auth, viewProvider, presetId)),
		vscode.commands.registerCommand('openvsChat.clearKey', () => clearKey(registry, viewProvider)),
		vscode.commands.registerCommand('openvsChat.mcpReconnect', async () => {
			mcp.reconnect();
			await mcp.ensureStarted();
			vscode.window.showInformationMessage(`MCP: ${mcp.getStatus().join('  ·  ')}`);
		}),
		vscode.commands.registerCommand('openvsChat.mcpStatus', async () => {
			await mcp.ensureStarted();
			vscode.window.showInformationMessage(`MCP: ${mcp.getStatus().join('  ·  ')}`);
		}),
		vscode.commands.registerCommand('openvsChat.selectSkill', () => selectSkill(viewProvider, context.extensionUri)),
		vscode.commands.registerCommand('openvsChat.createSkill', () => createSkill(viewProvider)),
		vscode.commands.registerCommand('openvsChat.mcpAdd', () => mcpAdd(mcp)),
		vscode.commands.registerCommand('openvsChat.mcpOpenConfig', () => mcpOpenConfig()),
		vscode.commands.registerCommand('openvsChat.remoteEnable', () => remoteEnable()),
		vscode.commands.registerCommand('openvsChat.remoteStatus', () => remoteStatus(remoteService)),
		vscode.commands.registerCommand('openvsChat.remoteDeployRelay', () => remoteDeployRelay(context, registry)),
		vscode.commands.registerCommand('openvsChat.generateCommitMessage', (rootUri?: vscode.Uri, _resourceGroups?: unknown, token?: vscode.CancellationToken) => {
			// The scm/inputBox toolbar always supplies a token; only the Command Palette (no
			// args) needs one made up here, and that one must be disposed once done with it.
			if (token) {
				return generateCommitMessage(registry, rootUri, token);
			}
			const cts = new vscode.CancellationTokenSource();
			return generateCommitMessage(registry, rootUri, cts.token).finally(() => cts.dispose());
		}),
	);

	// Inline-editor commands operate on the active selection (or whole file).
	const inline = (kind: InlineKind) => () => viewProvider.runInline(kind);
	context.subscriptions.push(
		vscode.commands.registerCommand('openvsChat.explainSelection', inline('explain')),
		vscode.commands.registerCommand('openvsChat.fixSelection', inline('fix')),
		vscode.commands.registerCommand('openvsChat.docSelection', inline('doc')),
		vscode.commands.registerCommand('openvsChat.optimizeSelection', inline('optimize')),
		vscode.commands.registerCommand('openvsChat.generateTests', inline('tests')),
		vscode.commands.registerCommand('openvsChat.editSelection', async () => {
			const instruction = await vscode.window.showInputBox({
				title: 'Edit selection with AI',
				prompt: 'Describe the change you want',
				ignoreFocusOut: true,
			});
			if (instruction) {
				await viewProvider.runInline('edit', instruction);
			}
		}),
		vscode.languages.registerCodeActionsProvider(
			{ scheme: 'file' },
			new InlineCodeActions(),
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] },
		),
	);

	// Covers every path that can reach the misconfigured state, not just this activation's
	// starting settings: the Settings UI (or a hand edit of settings.json) can flip
	// `remote.enabled` on, or clear `relayUrl`, without ever going through `remoteEnable()`.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('openvsChat.remote.enabled') || e.affectsConfiguration('openvsChat.remote.relayUrl')) {
			void warnIfRemoteMisconfigured(context);
		}
	}));
	void warnIfRemoteMisconfigured(context);
}

/**
 * `globalState` key recording that the user dismissed the nudge below via "Don't Ask Again".
 * `remote.enabled` is written at `ConfigurationTarget.Global` (see `remoteEnable`), so it's the
 * same everywhere — without this flag the nudge would re-fire on every window's activation until
 * the user deploys a relay, even for someone who's already seen it and is getting to it later.
 * Cleared as soon as the misconfiguration itself resolves (relay deployed, or remote disabled),
 * so a *future* re-enable-without-relay prompts fresh rather than staying silenced forever from
 * one old dismissal.
 */
const REMOTE_DEPLOY_NUDGE_DISMISSED_KEY = 'openvsChat.remote.deployNudgeDismissed';

/**
 * Nudges the user to finish relay setup when `remote.enabled` is on but `relayUrl` is still
 * empty — e.g. a settings sync/import, or the setting flipped by hand — without ever going
 * through {@link remoteEnable}'s prompt. `RemoteService.status()` already reports this case, but
 * nothing surfaced it: the host would sit silently unpaired until the user thought to run
 * "OpenVS Thor: Remote: Status". Gives the same one-click "Deploy Your Own Relay"
 * `remoteEnable()` gives on first ask. Called at activation and on every relevant config change
 * — see the `onDidChangeConfiguration` listener in {@link activate}.
 *
 * Skipped in a folderless window: remote pairing is workspace-keyed (`getWorkspaceKey()`
 * in `remote/config.ts`), so a window with nothing to pair has nothing this nudge would unblock.
 */
async function warnIfRemoteMisconfigured(context: vscode.ExtensionContext): Promise<void> {
	if (!isRemoteEnabled() || getRelayUrl()) {
		// Resolved, or no longer enabled — reset so a later re-enable-without-relay nudges again.
		await context.globalState.update(REMOTE_DEPLOY_NUDGE_DISMISSED_KEY, false);
		return;
	}
	if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
		return;
	}
	if (context.globalState.get<boolean>(REMOTE_DEPLOY_NUDGE_DISMISSED_KEY)) {
		return;
	}
	const action = await vscode.window.showWarningMessage(
		'OpenVS remote control is enabled, but no relay is deployed yet — pairing won\'t work until you do. '
		+ 'Run "OpenVS Thor: Remote: Deploy Your Own Relay" to do that in one step.',
		'Deploy Your Own Relay', 'Don\'t Ask Again');
	if (action === 'Deploy Your Own Relay') {
		await vscode.commands.executeCommand('openvsChat.remoteDeployRelay');
	} else if (action === 'Don\'t Ask Again') {
		await context.globalState.update(REMOTE_DEPLOY_NUDGE_DISMISSED_KEY, true);
	}
}

/** Offers OpenVS AI actions as editor quick-fixes / refactors. */
class InlineCodeActions implements vscode.CodeActionProvider {
	provideCodeActions(
		_doc: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		ctx: vscode.CodeActionContext,
	): vscode.CodeAction[] | undefined {
		if (range.isEmpty && ctx.diagnostics.length === 0) {
			return undefined;
		}
		const make = (title: string, command: string, kind: vscode.CodeActionKind) => {
			const action = new vscode.CodeAction(title, kind);
			action.command = { command, title };
			return action;
		};
		const actions = [
			make('AI: Explain this', 'openvsChat.explainSelection', vscode.CodeActionKind.QuickFix),
			make('AI: Edit this…', 'openvsChat.editSelection', vscode.CodeActionKind.RefactorRewrite),
		];
		if (ctx.diagnostics.length) {
			actions.unshift(make('AI: Fix this', 'openvsChat.fixSelection', vscode.CodeActionKind.QuickFix));
		}
		return actions;
	}
}

export function deactivate(): void {
	// Settles every prompt still waiting for a reply — the one place that is allowed to
	// happen unconditionally; see PromptRegistry.settleAllUnanswered's doc for why a reload
	// must not do this.
	activeViewProvider?.dispose();
	activeViewProvider = undefined;
}

/**
 * Renders {@link StatsRow}s for `openvsChat.completions.showStats`'s output-channel dump —
 * highest shown count first, since that is the model with the most evidence behind its rate.
 */
function formatStatsReport(rows: StatsRow[]): string {
	const header = `${new Date().toISOString()} — inline completion acceptance`;
	if (!rows.length) {
		return `${header}\n  No completions have been shown yet.`;
	}
	const sorted = [...rows].sort((a, b) => b.shown - a.shown);
	const lines = sorted.map(r => {
		const rate = r.rate === undefined ? 'not enough samples yet' : `${Math.round(r.rate * 100)}%`;
		return `  ${r.model}: ${r.accepted}/${r.shown} accepted (${rate})`;
	});
	return [header, ...lines].join('\n');
}

async function pickProvider(registry: ProviderRegistry, placeHolder: string): Promise<string | undefined> {
	const configs = await registry.resolveAll();
	const picked = await vscode.window.showQuickPick(
		configs.map(c => ({
			label: c.label,
			description: c.hasApiKey ? '$(key) key set' : (c.requiresApiKey ? '$(warning) no key' : 'no key needed'),
			detail: `Model: ${c.model}`,
			id: c.id,
		})),
		{ placeHolder, matchOnDetail: true },
	);
	return picked?.id;
}

async function selectProvider(registry: ProviderRegistry, view: ChatViewProvider): Promise<void> {
	const id = await pickProvider(registry, 'Select the AI provider to chat with');
	if (!id) {
		return;
	}
	await vscode.workspace.getConfiguration('openvsChat').update(
		'defaultProvider', id, vscode.ConfigurationTarget.Global);
	view.selectProvider(id);
	await view.refreshConfig();
}

/**
 * Placeholder shown in the API-key input box, per provider. A recognizable prefix is the
 * quickest way for someone to tell they are about to paste the wrong vendor's key; the
 * providers whose credentials carry no prefix say what is wanted in words instead, rather
 * than inheriting a misleading `sk-...`.
 */
const KEY_PLACEHOLDERS: Record<string, string | undefined> = {
	nvidia: 'nvapi-...',
	anthropic: 'sk-ant-...',
	gemini: 'AIza...',
	openrouter: 'sk-or-v1-...',
	groq: 'gsk_...',
	mistral: 'Your Mistral API key',
	cloudflare: 'Cloudflare API token with the Workers AI permission',
};

async function configureProvider(
	registry: ProviderRegistry, view: ChatViewProvider, presetId?: string,
): Promise<void> {
	const id = presetId ?? await pickProvider(registry, 'Which provider do you want to configure?');
	if (!id) {
		return;
	}
	const provider = registry.getProvider(id);
	if (!provider) {
		return;
	}
	const key = await vscode.window.showInputBox({
		title: `${provider.info.label} API key`,
		prompt: `Paste your API key (stored in the OS secret store). Get one at ${provider.info.apiKeyUrl}`,
		password: true,
		ignoreFocusOut: true,
		placeHolder: KEY_PLACEHOLDERS[id] ?? 'sk-...',
	});
	if (!key) {
		return;
	}
	await registry.setApiKey(id, key.trim());
	vscode.window.showInformationMessage(`Saved the API key for ${provider.info.label}.`);
	await view.credentialsChanged(id);
}

async function signIn(
	registry: ProviderRegistry, auth: WebAuthManager, view: ChatViewProvider, presetId?: string,
): Promise<void> {
	const id = presetId ?? await pickProvider(registry, 'Sign in to which provider?');
	if (!id) {
		return;
	}
	try {
		const ok = await auth.signIn(id);
		if (ok) {
			vscode.window.showInformationMessage(`Signed in to ${registry.getProvider(id)?.info.label ?? id}.`);
		}
	} catch (err) {
		vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
	await view.credentialsChanged(id);
}

async function selectSkill(view: ChatViewProvider, extensionUri: vscode.Uri): Promise<void> {
	const skills = await new SkillRegistry(extensionUri).list();
	const active = view.activeSkillIds();
	const picked = await vscode.window.showQuickPick(
		skills.map(s => ({ label: s.name, description: s.description, id: s.id, picked: active.includes(s.id) })),
		{ placeHolder: 'Activate skills (their instructions steer every message)', canPickMany: true },
	);
	if (picked) {
		await view.setActiveSkills(picked.map(p => p.id));
		await vscode.commands.executeCommand('openvsChat.view.focus');
	}
}

/**
 * Guided skill creation: asks for an id/name/description, writes a Markdown scaffold
 * to `.openvs/skills/<id>.md` in the workspace, and opens it for editing. The skill
 * shows up in the picker immediately (the registry re-reads the folder on each list).
 */
async function createSkill(view: ChatViewProvider): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		vscode.window.showWarningMessage('Open a folder first — workspace skills live in .openvs/skills/. (You can also define global skills via the "openvsChat.skills" setting.)');
		return;
	}
	const id = await vscode.window.showInputBox({
		title: 'New skill (1/3): id',
		prompt: 'Short identifier, used as the file name and in /skill <id>',
		placeHolder: 'e.g. api-reviewer',
		ignoreFocusOut: true,
		validateInput: v => /^[a-z0-9][a-z0-9-_]*$/.test(v) ? undefined : 'Use lowercase letters, digits, - or _ (must start with a letter or digit).',
	});
	if (!id) {
		return;
	}
	const name = await vscode.window.showInputBox({
		title: 'New skill (2/3): display name',
		value: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
		ignoreFocusOut: true,
	});
	if (name === undefined) {
		return;
	}
	const description = await vscode.window.showInputBox({
		title: 'New skill (3/3): one-line description',
		placeHolder: 'What does this skill make the assistant do?',
		ignoreFocusOut: true,
	});
	if (description === undefined) {
		return;
	}

	const file = vscode.Uri.joinPath(root, '.openvs', 'skills', `${id}.md`);
	try {
		await vscode.workspace.fs.stat(file);
		const overwrite = await vscode.window.showWarningMessage(
			`A skill file for "${id}" already exists. Overwrite it?`, { modal: true }, 'Overwrite');
		if (overwrite !== 'Overwrite') {
			return;
		}
	} catch {
		// Doesn't exist yet — the normal path.
	}
	const scaffold = [
		`# ${name || id}`,
		'',
		`> ${description || 'Describe what this skill does.'}`,
		'',
		'## Instructions',
		'',
		'Write the instructions the assistant should follow while this skill is active.',
		'Be specific: conventions to apply, steps to take, tone, what to avoid.',
		'',
	].join('\n');
	await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(scaffold));
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
	vscode.window.showInformationMessage(`Skill "${id}" created. Edit the instructions, then activate it with /skill ${id} in the chat.`);
	await view.refreshConfig();
}

/**
 * Guided MCP server registration: asks where to store it (project file or global
 * settings), the server id and the launch command, then reconnects so its tools are
 * available to the agent right away.
 */
async function mcpAdd(mcp: McpManager): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	const target = await vscode.window.showQuickPick(
		[
			...(root ? [{ label: '$(root-folder) This project', description: '.openvs/mcp.json (checked into the repo if you commit it)', id: 'project' }] : []),
			{ label: '$(globe) Global', description: 'openvsChat.mcp.servers user setting (all projects)', id: 'global' },
		],
		{ placeHolder: 'Where should this MCP server be configured?' },
	);
	if (!target) {
		return;
	}
	const id = await vscode.window.showInputBox({
		title: 'MCP server (1/2): id',
		prompt: 'Short name; the agent sees tools as mcp__<id>__<tool>',
		placeHolder: 'e.g. github',
		ignoreFocusOut: true,
		validateInput: v => /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(v) ? undefined : 'Use letters, digits, - or _.',
	});
	if (!id) {
		return;
	}
	const commandLine = await vscode.window.showInputBox({
		title: 'MCP server (2/2): launch command',
		prompt: 'The stdio command to start the server (arguments separated by spaces)',
		placeHolder: 'e.g. npx -y @modelcontextprotocol/server-github',
		ignoreFocusOut: true,
	});
	if (!commandLine?.trim()) {
		return;
	}
	const [command, ...args] = commandLine.trim().split(/\s+/);
	const entry = { command, ...(args.length ? { args } : {}) };

	if (target.id === 'project' && root) {
		const file = vscode.Uri.joinPath(root, '.openvs', 'mcp.json');
		let config: { servers: Record<string, unknown> } = { servers: {} };
		try {
			const existing = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
			// Accept both wrapped and bare formats; keep whatever map we find.
			config = existing.servers ? existing : (existing.mcpServers ? { servers: existing.mcpServers } : { servers: existing });
		} catch {
			// New file.
		}
		config.servers[id] = entry;
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(config, null, '\t') + '\n'));
	} else {
		const cfg = vscode.workspace.getConfiguration('openvsChat');
		const servers = { ...(cfg.get<Record<string, unknown>>('mcp.servers') ?? {}) };
		servers[id] = entry;
		await cfg.update('mcp.servers', servers, vscode.ConfigurationTarget.Global);
	}

	mcp.reconnect();
	await mcp.ensureStarted();
	vscode.window.showInformationMessage(`MCP: ${mcp.getStatus().join('  ·  ')}`);
}

/** Opens (creating if needed) the project's `.openvs/mcp.json`. */
async function mcpOpenConfig(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		vscode.window.showWarningMessage('Open a folder first — the project MCP config lives in .openvs/mcp.json. (Global servers live in the "openvsChat.mcp.servers" setting.)');
		return;
	}
	const file = vscode.Uri.joinPath(root, '.openvs', 'mcp.json');
	try {
		await vscode.workspace.fs.stat(file);
	} catch {
		const scaffold = { servers: { 'example-disabled': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], disabled: true } } };
		await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(scaffold, null, '\t') + '\n'));
	}
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

/**
 * `openvsChat.remoteEnable`: flips `openvsChat.remote.enabled` on, or — if no relay URL is
 * configured yet — explains what's missing instead. There is no default relay; the user
 * deploys their own via `wrangler deploy` first.
 */
async function remoteEnable(): Promise<void> {
	if (!getRelayUrl()) {
		const action = await vscode.window.showWarningMessage(
			'Set "openvsChat.remote.relayUrl" to your own deployed relay before enabling remote control — there is no default relay. '
			+ 'Run "OpenVS Thor: Remote: Deploy Your Own Relay" to do that in one step.',
			'Deploy Your Own Relay');
		if (action) {
			await vscode.commands.executeCommand('openvsChat.remoteDeployRelay');
		}
		return;
	}
	await vscode.workspace.getConfiguration('openvsChat').update('remote.enabled', true, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(
		'OpenVS remote control is enabled. Open ⚙ Providers & settings → Remote control to pair a device.');
}

/**
 * `openvsChat.remoteStatus`: shows the current connection state (disabled / connecting / connected / …).
 * The in-panel status indicator (`media/pairing.js`, in Settings → Remote control) shows this
 * live; this command remains as a keyboard-only / Command Palette alternative.
 */
function remoteStatus(remoteService: RemoteService): void {
	vscode.window.showInformationMessage(`OpenVS remote control: ${remoteService.status()}.`);
}

/**
 * `openvsChat.remoteDeployRelay`: turns the manual "deploy your own relay" steps this
 * extension has always required (see `remoteEnable`'s warning) into one click — installs
 * `openvs-relay/`'s dependencies if needed, mints and uploads a `RELAY_PEPPER` secret, runs
 * `wrangler deploy`, and saves the resulting URL into `openvsChat.remote.relayUrl`. Only works
 * from a full source checkout: `openvs-relay/` is a sibling of `extensions/` in this repo, not
 * something a normally-installed extension carries with it — this extension ships built-in
 * only (a packaged VSIX is refused, see `chatViewProvider.ts`'s `search_files` doc), so anyone
 * running it at all is, by construction, running it from a checkout of this monorepo.
 *
 * Authenticates `wrangler` non-interactively via `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`
 * rather than the `wrangler login` browser flow — reusing the exact credential the Cloudflare
 * Workers AI *chat provider* already asks for (`registry.getApiKey('cloudflare')`, the same
 * secret `ENV_VARS.cloudflare = 'CLOUDFLARE_API_TOKEN'` names in `providers/registry.ts`, plus
 * `openvsChat.cloudflare.accountId`). One Cloudflare credential serves both features instead of
 * this command inventing a second, parallel place to paste the same token. When either half is
 * missing this refuses up front with a pointer to where to add it, rather than letting
 * `wrangler` fail deep into the pipeline with a login prompt that has nothing to attach to in a
 * non-interactive spawn.
 */
async function remoteDeployRelay(context: vscode.ExtensionContext, registry: ProviderRegistry): Promise<void> {
	const relayDir = vscode.Uri.joinPath(context.extensionUri, '..', '..', 'openvs-relay').fsPath;
	if (!fs.existsSync(relayDir)) {
		vscode.window.showErrorMessage(
			'Could not find openvs-relay/ next to this extension — this command only works from a full source checkout of the OpenVS Thor repo. '
			+ 'From a checkout: cd openvs-relay && npm install && npx wrangler deploy, then paste the printed URL into "openvsChat.remote.relayUrl".');
		return;
	}

	const cloudflareToken = await registry.getApiKey('cloudflare');
	const cloudflareAccountId = vscode.workspace.getConfiguration('openvsChat').get<string>('cloudflare.accountId')?.trim();
	if (!cloudflareToken || !cloudflareAccountId) {
		const missing = !cloudflareToken && !cloudflareAccountId ? 'API token and Account ID'
			: !cloudflareToken ? 'API token' : 'Account ID';
		const action = await vscode.window.showWarningMessage(
			`Deploying your own relay needs a Cloudflare ${missing} first — add ${missing === 'API token and Account ID' ? 'both' : 'it'} `
			+ 'under ⚙ Providers & settings → Providers → Cloudflare, then retry this command.',
			'Open Settings');
		if (action) {
			await vscode.commands.executeCommand('openvsChat.openSettings');
		}
		return;
	}

	const channel = vscode.window.createOutputChannel('OpenVS Chat: Deploy Relay');
	channel.show(true);
	channel.appendLine(`Deploying your own OpenVS relay from ${relayDir} …`);

	const skipInstall = fs.existsSync(path.join(relayDir, 'node_modules'));
	// `withProgress`'s CancellationToken has no native relationship to `deployRelay`'s
	// AbortSignal (it predates AbortController in the vscode API) — bridged by hand so Cancel
	// actually kills the in-flight `npm`/`wrangler` process instead of merely hiding the
	// notification while the deploy keeps running unattended.
	const controller = new AbortController();
	let cancelled = false;
	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Deploying OpenVS relay…', cancellable: true },
		(_progress, token) => {
			token.onCancellationRequested(() => { cancelled = true; controller.abort(); });
			return deployRelay({
				relayDir,
				skipInstall,
				env: { CLOUDFLARE_API_TOKEN: cloudflareToken, CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId },
				signal: controller.signal,
			});
		},
	);
	channel.appendLine(result.output);

	if (!result.ok || !result.url) {
		if (cancelled) {
			channel.appendLine('\n[Cancelled by user]');
			vscode.window.showInformationMessage('Relay deploy cancelled.');
			return;
		}
		channel.appendLine(`\n[FAILED at step: ${result.step ?? 'unknown'}]`);
		const stepHint = result.step === 'install' ? 'npm install failed — check your network connection and retry.'
			: result.step === 'secret' ? 'Check that the Cloudflare API token under ⚙ Providers & settings → Providers → Cloudflare has "Edit Cloudflare Workers" permission, then retry.'
			: 'wrangler deploy failed, or its output did not contain a *.workers.dev URL — see the output for the real reason.';
		const action = await vscode.window.showErrorMessage(`Relay deploy failed. ${stepHint}`, 'Show Output');
		if (action) {
			channel.show();
		}
		return;
	}

	const existingRelayUrl = getRelayUrl();
	if (existingRelayUrl && existingRelayUrl !== result.url) {
		const decision = await vscode.window.showWarningMessage(
			`openvsChat.remote.relayUrl is already set to ${existingRelayUrl}. Replace it with the newly deployed ${result.url}?`,
			'Replace', 'Keep Existing');
		if (decision !== 'Replace') {
			channel.appendLine(`\nDeployed to ${result.url}, but kept the existing relayUrl (${existingRelayUrl}) — update it yourself if you want to switch.`);
			return;
		}
	}

	await vscode.workspace.getConfiguration('openvsChat').update('remote.relayUrl', result.url, vscode.ConfigurationTarget.Global);
	channel.appendLine(`\nRelay deployed: ${result.url}`);
	channel.appendLine('Note: push notifications need VAPID_PUBLIC/VAPID_PRIVATE/VAPID_SUBJECT secrets set separately (see openvs-relay/wrangler.jsonc) — remote control itself works without them.');

	const choice = await vscode.window.showInformationMessage(
		`OpenVS relay deployed at ${result.url}. Enable remote control now?`, 'Enable Remote Control');
	if (choice) {
		await remoteEnable();
	}
}

async function clearKey(registry: ProviderRegistry, view: ChatViewProvider): Promise<void> {
	const id = await pickProvider(registry, 'Clear the stored API key for which provider?');
	if (!id) {
		return;
	}
	await registry.clearApiKey(id);
	vscode.window.showInformationMessage(`Cleared the API key for ${registry.getProvider(id)?.info.label ?? id}.`);
	await view.credentialsChanged(id);
}
