/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { WebAuthManager } from './auth';
import { ChatViewProvider, InlineKind } from './chatViewProvider';
import { McpManager } from './mcp/manager';
import { ProviderRegistry } from './providers/registry';
import { setStreamIdleTimeout } from './providers/types';
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

export function activate(context: vscode.ExtensionContext): void {
	applyStreamIdleTimeout();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('openvsChat.stream.idleTimeoutMs')) {
			applyStreamIdleTimeout();
		}
	}));
	const registry = new ProviderRegistry(context.secrets);
	const auth = new WebAuthManager(registry);
	const mcp = new McpManager();
	const viewProvider = new ChatViewProvider(context, registry, auth, mcp);
	context.subscriptions.push(mcp);

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
	// no-op
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
		placeHolder: id === 'nvidia' ? 'nvapi-...' : id === 'anthropic' ? 'sk-ant-...' : id === 'openrouter' ? 'sk-or-v1-...' : 'sk-...',
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

async function clearKey(registry: ProviderRegistry, view: ChatViewProvider): Promise<void> {
	const id = await pickProvider(registry, 'Clear the stored API key for which provider?');
	if (!id) {
		return;
	}
	await registry.clearApiKey(id);
	vscode.window.showInformationMessage(`Cleared the API key for ${registry.getProvider(id)?.info.label ?? id}.`);
	await view.credentialsChanged(id);
}
