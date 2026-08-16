/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { isAbortError, streamChatWithContinuation } from '../providers/types';
import { API, GitExtension, Repository } from './git';

/**
 * How much of the staged diff to hand the model. A large diff costs proportionally more and
 * risks tripping a small per-request token allowance (see `agentRunner.adoptRequestCeiling`
 * in the wider extension) for a task that only needs a summary, not the full text — mirrors
 * the 12k-char cap `rules.ts` applies to steering instructions.
 */
const DIFF_CHAR_CAP = 12_000;

/** Reply is a commit message, not code — no need for the extension's general `maxTokens` budget. */
const MAX_REPLY_TOKENS = 400;

const TRUNCATION_NOTICE = '\n\n[diff truncated — showing the first part only]';

/**
 * Builds the prompt sent to the model. Kept pure and exported so it can be unit-tested
 * without touching `vscode` or the Git extension.
 */
export function buildCommitMessagePrompt(diff: string): string {
	const truncated = diff.length > DIFF_CHAR_CAP;
	const body = truncated ? diff.slice(0, DIFF_CHAR_CAP) + TRUNCATION_NOTICE : diff;
	return 'Write a git commit message for the following staged changes. ' +
		'Follow the Conventional Commits style: a short imperative subject line (max 50 characters, ' +
		'no trailing period), optionally followed by a blank line and a brief body explaining the ' +
		'"why" if it isn\'t obvious from the diff. Reply with the commit message only — no markdown ' +
		'fences, no preamble, no explanation.\n\n' +
		`${'```diff'}\n${body}\n${'```'}`;
}

/**
 * Strips a single wrapping ``` fence some models add despite being told not to — common on
 * the smaller/free models this extension favors. Only strips when the fence wraps the
 * *entire* reply, so a fenced snippet inside a longer explanation is left alone rather than
 * mangled.
 */
export function stripWrappingFence(text: string): string {
	const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim());
	return match ? match[1].trim() : text;
}

/**
 * Picks the repository the command should act on. The `scm/inputBox` toolbar passes the
 * clicked input's repository root as the first command argument, so this only needs to guess
 * when the command is invoked another way (e.g. the Command Palette, which passes nothing).
 */
function pickRepository(git: API, rootUri: vscode.Uri | undefined): Repository | undefined {
	if (rootUri) {
		const byRoot = git.getRepository(rootUri);
		if (byRoot) {
			return byRoot;
		}
	}
	if (git.repositories.length === 1) {
		return git.repositories[0];
	}
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri) {
		const match = git.getRepository(activeUri);
		if (match) {
			return match;
		}
	}
	return git.repositories[0];
}

async function getGitApi(): Promise<API | undefined> {
	const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!ext) {
		return undefined;
	}
	const exports = ext.isActive ? ext.exports : await ext.activate();
	return exports.enabled ? exports.getAPI(1) : undefined;
}

/**
 * Generates a commit message from the currently staged changes using whichever provider is
 * configured (`openvsChat.defaultProvider`), and writes it into the repository's SCM input
 * box. Bound to the `scm/inputBox` toolbar button; `rootUri` and `token` are the arguments
 * that toolbar passes to the command it runs.
 */
export async function generateCommitMessage(
	registry: ProviderRegistry,
	rootUri: vscode.Uri | undefined,
	token: vscode.CancellationToken,
): Promise<void> {
	const git = await getGitApi();
	if (!git) {
		vscode.window.showErrorMessage('The built-in Git extension is not available.');
		return;
	}
	const repo = pickRepository(git, rootUri);
	if (!repo) {
		vscode.window.showErrorMessage('No git repository found in this workspace.');
		return;
	}

	const diff = await repo.diff(true);
	if (!diff.trim()) {
		vscode.window.showInformationMessage('No staged changes to generate a commit message from.');
		return;
	}

	const providerId = registry.getDefaultProviderId();
	const provider = registry.getProvider(providerId);
	if (!provider) {
		vscode.window.showErrorMessage('No AI provider is configured.');
		return;
	}
	if (provider.info.requiresApiKey && !(await registry.hasCredentials(providerId))) {
		const action = await vscode.window.showErrorMessage(
			`No API key configured for ${provider.info.label}. Configure a provider to generate commit messages.`,
			'Configure Provider',
		);
		if (action) {
			await vscode.commands.executeCommand('openvsChat.configureProvider', providerId);
		}
		return;
	}

	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	}
	const sub = token.onCancellationRequested(() => controller.abort());

	let result: { text: string; truncated: boolean };
	try {
		// Continuation matters here even at a small maxTokens: a model that ignores the
		// brevity instruction and writes a long body would otherwise hand back a message
		// chopped off mid-sentence with no indication anything was cut.
		result = await streamChatWithContinuation(provider, {
			messages: [{ role: 'user', content: buildCommitMessagePrompt(diff) }],
			model: registry.getModel(providerId),
			apiKey: (await registry.getApiKey(providerId)) ?? '',
			baseUrl: registry.getBaseUrl(providerId),
			maxTokens: MAX_REPLY_TOKENS,
			signal: controller.signal,
			onToken: () => { /* no incremental UI to update while this runs */ },
		});
	} catch (err) {
		if (isAbortError(err)) {
			return;
		}
		vscode.window.showErrorMessage(`Failed to generate commit message: ${err instanceof Error ? err.message : String(err)}`);
		return;
	} finally {
		sub.dispose();
	}

	const message = stripWrappingFence(result.text.trim());
	if (!message) {
		vscode.window.showWarningMessage(`${provider.info.label} returned an empty commit message.`);
		return;
	}
	repo.inputBox.value = message;
	if (result.truncated) {
		vscode.window.showWarningMessage('The generated commit message may be incomplete — it hit the model\'s output limit even after continuing.');
	}
}
