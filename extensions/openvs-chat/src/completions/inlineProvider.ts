/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RoleAssignment, RoleRouter } from '../auto/router';
import { ChatProvider } from '../providers/types';
import { ProviderRegistry } from '../providers/registry';
import { FIM_STOP, buildChatPrompt } from './prompt';
import { CompletionCache } from './cache';
import { CompletionModelResolver, ResolvedCompletionModel } from './completionModel';
import { CompletionScheduler } from './scheduler';
import { CompletionStats, StatsRow } from './stats';
import { CompletionStatusBar } from './statusBar';
import { CompletionWindow } from './types';
import { HealthTracker } from './health';
import { applyEol, buildWindow } from './context';
import { describeExclusion, isExcluded } from './exclusions';
import { sanitizeCompletion } from './sanitize';

/** Settings read fresh per request, so a change takes effect without a reload. */
interface CompletionSettings {
	readonly maxLines: number;
	readonly prefixChars: number;
	readonly suffixChars: number;
	readonly maxTokens: number;
	readonly quotaReserve: number;
	readonly slowMs: number;
	readonly excludeFiles: string[];
	readonly disabledLanguages: string[];
	readonly allowUntrusted: boolean;
}

/** Cap on the extracted import block; see `context.ts`. */
const IMPORT_CHARS = 600;

/** How much more a user may get when they ask explicitly rather than just pausing. */
const INVOKE_LINE_MULTIPLIER = 4;

/**
 * Serves inline ghost-text completions from whichever model backend the user has.
 *
 * Glue only: windowing, exclusion, sanitizing, caching, gating and routing each live in
 * their own tested module. What is here is the order they run in and the mapping onto the
 * editor's provider contract.
 */
export class OpenVSInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private readonly cache = new CompletionCache();
	private readonly health: HealthTracker;
	private readonly scheduler = new CompletionScheduler();
	private readonly resolver: CompletionModelResolver;
	private readonly stats = new CompletionStats();
	/** Which model actually served each shown item, looked up by the lifecycle hooks below. */
	private readonly itemModel = new WeakMap<vscode.InlineCompletionItem, string>();
	/** Items that received a partial accept at some point — see {@link handleEndOfLifetime}. */
	private readonly itemPartiallyAccepted = new WeakSet<vscode.InlineCompletionItem>();
	private readonly configListener: vscode.Disposable;

	private readonly onDidChangeModelInfoEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeModelInfo = this.onDidChangeModelInfoEmitter.event;
	private candidates: vscode.InlineCompletionModel[] = [];
	private currentModelId = '';
	private readonly router: RoleRouter;

	constructor(
		private readonly registry: ProviderRegistry,
		router: RoleRouter,
		private readonly status: CompletionStatusBar,
		private readonly log: vscode.OutputChannel,
	) {
		this.router = router;
		this.resolver = new CompletionModelResolver(router, registry);
		this.health = new HealthTracker();
		void this.refreshModelCandidates().catch(() => { });
		this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('openvsChat.completions') || e.affectsConfiguration('openvsChat.auto')) {
				void this.refreshModelCandidates().catch(() => { });
			}
		});
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionList | undefined> {
		const settings = readSettings();
		const invoked = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
		const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');

		const exclusion = isExcluded({
			relativePath,
			scheme: document.uri.scheme,
			languageId: document.languageId,
			cursorLine: document.lineAt(position.line).text,
		}, {
			excludeFiles: settings.excludeFiles,
			trusted: vscode.workspace.isTrusted,
			allowUntrusted: settings.allowUntrusted,
			disabledLanguages: settings.disabledLanguages,
		});
		if (exclusion) {
			this.status.setOutcome('excluded', describeExclusion(exclusion));
			return undefined;
		}

		const resolved = await this.resolver.resolve();
		if (!resolved) {
			this.status.setOutcome('no-model');
			return undefined;
		}
		const provider = this.registry.getProvider(resolved.providerId);
		if (!provider) {
			return undefined;
		}

		const window = buildWindow({
			text: document.getText(),
			languageId: document.languageId,
			relativePath,
			eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
		}, document.offsetAt(position), {
			prefixChars: settings.prefixChars,
			suffixChars: settings.suffixChars,
			importChars: IMPORT_CHARS,
		});

		const key = this.cache.keyFor(resolved.model, window.prefix, window.suffix, window.imports, invoked);
		const cached = this.cache.get(key);

		// Both breakers govern live requests only — a cache hit costs nothing (no network
		// call at all), so it must never be gated behind either. Checked here, after the
		// cache lookup, rather than before it. An explicit Alt+\ additionally always bypasses
		// both: the user is saying they will wait, and refusing it would leave no way to use a
		// slow or nearly-spent backend deliberately.
		if (cached === undefined) {
			if (!invoked && this.health.isSlow(settings.slowMs)) {
				this.status.setOutcome('paused-slow');
				return undefined;
			}
			if (!invoked && this.scheduler.gate(provider.rateLimit?.(resolved.model), settings.quotaReserve) !== 'ok') {
				this.status.setOutcome('paused-quota');
				return undefined;
			}
		}

		const text = cached ?? await this.request(provider, resolved, window, settings, invoked, token);
		if (!text) {
			return undefined;
		}
		if (cached === undefined) {
			this.cache.set(key, text);
		}

		// A real suggestion clears whatever paused/error state a prior request left behind —
		// without this, one early 'no-model'/'paused-quota'/'error' outcome sticks in the
		// status bar forever, even once completions start succeeding normally again, which is
		// exactly the "user reports the feature as broken" failure this status bar exists to
		// prevent.
		this.status.setOutcome('shown');

		// Anchored at the cursor as a zero-width replacement. When the suggest widget is open
		// the editor matches our text against `context.selectedCompletionInfo` itself and
		// declines to render a suggestion that does not extend the selected item.
		const item = new vscode.InlineCompletionItem(
			applyEol(text, window.eol),
			new vscode.Range(position, position),
		);
		this.itemModel.set(item, resolved.model);
		const list = new vscode.InlineCompletionList([item]);
		// Without this the editor re-requests on every character the user types *through* the
		// suggestion — the largest single source of avoidable requests on a metered tier.
		list.enableForwardStability = true;
		return list;
	}

	/** Issues one request, preferring a real FIM endpoint and falling back to a chat prompt. */
	private async request(
		provider: ChatProvider,
		resolved: ResolvedCompletionModel,
		window: CompletionWindow,
		settings: CompletionSettings,
		invoked: boolean,
		token: vscode.CancellationToken,
	): Promise<string> {
		const apiKey = await this.registry.getApiKey(resolved.providerId) ?? '';
		const baseUrl = this.registry.getBaseUrl(resolved.providerId);
		const maxLines = invoked ? settings.maxLines * INVOKE_LINE_MULTIPLIER : settings.maxLines;
		const started = Date.now();

		// Linked to the editor's own cancellation (dismissed suggestion, cursor move, a
		// superseding keystroke) as well as the scheduler's own supersede signal, so either
		// one aborts the in-flight call. Disposed below regardless of outcome — each listener
		// is short-lived, but nothing else was releasing it.
		const linked = new AbortController();
		const cancelListener = token.onCancellationRequested(() => linked.abort());
		let raw: string | undefined;
		try {
			raw = await this.scheduler.run(async signal => {
				signal.addEventListener('abort', () => linked.abort());
				if (resolved.usesFim && provider.completeFim) {
					return provider.completeFim({
						prefix: window.prefix, suffix: window.suffix, model: resolved.model,
						apiKey, baseUrl, maxTokens: settings.maxTokens,
						stop: FIM_STOP, signal: linked.signal,
					});
				}
				let text = '';
				await provider.streamChat({
					messages: buildChatPrompt(window),
					model: resolved.model, apiKey, baseUrl,
					maxTokens: settings.maxTokens, signal: linked.signal,
					onToken: delta => { text += delta; },
					isCompletion: true,
				});
				return text;
			}).catch((err: unknown) => {
				// The scheduler only swallows an abort of its *own* controller (a superseding
				// request); this `linked` controller also aborts on the editor's own
				// cancellation — dismissed suggestion, cursor move, every superseding
				// keystroke — which is normal, frequent, expected behavior, not a failure. That
				// must stay silent rather than logging an error and flipping the status bar on
				// essentially every keystroke.
				if (token.isCancellationRequested || linked.signal.aborted) {
					return undefined;
				}
				const message = err instanceof Error ? err.message : String(err);
				this.log.appendLine(`${new Date().toISOString()} ${resolved.providerId}/${resolved.model} failed: ${message}`);
				this.status.setOutcome('error', message);
				return undefined;
			});
		} finally {
			cancelListener.dispose();
		}

		if (raw === undefined) {
			return '';
		}
		const elapsed = Date.now() - started;
		this.health.record(elapsed);
		this.log.appendLine(`${new Date().toISOString()} ${resolved.providerId}/${resolved.model} ${elapsed}ms ${resolved.usesFim ? 'fim' : 'chat'}`);
		return sanitizeCompletion(raw, window, { maxLines });
	}

	/** The editor showed this item; `updatedInsertText` is the text after bracket repair. */
	handleDidShowCompletionItem(item: vscode.InlineCompletionItem, _updatedInsertText: string): void {
		const model = this.itemModel.get(item);
		if (model) {
			this.stats.shown(model);
		}
	}

	/**
	 * Records that this item was partially accepted at some point. Scoring itself happens in
	 * {@link handleEndOfLifetime} — see there for why.
	 *
	 * The proposed API declares this method twice — once with `info: PartialAcceptInfo` and
	 * once, deprecated, with a bare `acceptedLength: number` — so a single implementation
	 * must accept either to satisfy the merged overload type.
	 */
	handleDidPartiallyAcceptCompletionItem(item: vscode.InlineCompletionItem, _infoOrLength: vscode.PartialAcceptInfo | number): void {
		this.itemPartiallyAccepted.add(item);
	}

	/**
	 * Final disposition of a shown item, and the sole place acceptance is scored.
	 *
	 * A partially-accepted item still ends its life through this hook (typically as
	 * `Ignored`, never as its own terminal outcome) — scoring the partial accept
	 * immediately as well as here would double-count it and inflate the rate above what
	 * actually happened, so {@link handleDidPartiallyAcceptCompletionItem} only records the
	 * fact and this method decides the final tally.
	 */
	handleEndOfLifetime(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
		const model = this.itemModel.get(item);
		if (!model) {
			return;
		}
		if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted) {
			this.stats.accepted(model);
		} else if (this.itemPartiallyAccepted.has(item)) {
			// A partial accept is still evidence the suggestion was useful — see CompletionStats.partial.
			this.stats.partial(model, 0);
		} else {
			this.stats.rejected(model);
		}
	}

	/** Exposed for `openvsChat.completions.showStats`. */
	report(): StatsRow[] {
		return this.stats.report();
	}

	/** Populated from the router's ranked candidates for the `complete` role. */
	get modelInfo(): vscode.InlineCompletionModelInfo | undefined {
		return this.candidates.length
			? { models: this.candidates, currentModelId: this.currentModelId }
			: undefined;
	}

	/**
	 * Persists the user's pick.
	 *
	 * Writes `openvsChat.completions.model`, never `ProviderRegistry.setModel` — that writes
	 * `openvsChat.<provider>.model`, which is the *chat* model, so routing the dropdown there
	 * would silently change the model the chat panel uses. This is one of the two calls
	 * `test-completion-isolation.mjs` exists to forbid.
	 */
	async setCurrentModelId(modelId: string): Promise<void> {
		await vscode.workspace.getConfiguration('openvsChat').update(
			'completions.model', modelId, vscode.ConfigurationTarget.Global);
		this.currentModelId = modelId;
		// The old backend's latency history and cached suggestions say nothing about the new one.
		this.health.reset();
		this.cache.clear();
		this.onDidChangeModelInfoEmitter.fire();
	}

	/**
	 * Refreshes {@link candidates} from the router's ranked list for the `complete` role, and
	 * keeps {@link currentModelId} pointing at a model that is actually in that list — falling
	 * back to the router's own top pick when the previous selection dropped out (e.g. its
	 * credential was cleared), so the picker never shows a phantom current model.
	 *
	 * Passes `ignorePin: true` — {@link resolveRoleCandidates} honours a configured
	 * `openvsChat.completions.model` by returning exactly that one entry, which is correct
	 * for `resolve()` (a pin must govern which model actually serves a request) but wrong
	 * here: it would collapse this picker to a single, unswitchable option the moment any
	 * model is ever picked from it. The pin still wins for real requests; it is only not
	 * allowed to hide the rest of the pool from the UI that lets the user change it. If the
	 * pin names a model outside the ranked pool (e.g. one a provider doesn't suggest), it is
	 * still resolved and prepended so the picker's "current" entry never disagrees with what
	 * is actually serving completions.
	 */
	private async refreshModelCandidates(): Promise<void> {
		const assignments: RoleAssignment[] = await this.router.resolveRoleCandidates(
			'complete', {}, new Map(), this.resolver.localReachable, true);
		this.candidates = assignments
			.filter(a => a.ready)
			.map(a => ({ id: `${a.providerId}:${a.model}`, name: `${a.model} (${a.providerLabel})` }));

		const pinned = this.router.getConfigured('complete');
		if (pinned) {
			// A configured pin is the sole source of truth for what actually serves a request
			// (see resolve(), which always honours it) — the picker's "current" entry must
			// track it unconditionally, not just when the *previous* currentModelId became
			// invalid. Sticking with "still a valid candidate" here would let a pin changed
			// underneath this provider (a settings.json edit, Settings Sync) leave the picker
			// showing the old selection, since that old model can easily still be a live,
			// ready candidate in the unpinned ranked pool above — just no longer the one
			// actually routing completions.
			const pinnedId = `${pinned.providerId}:${pinned.model}`;
			if (!this.candidates.some(c => c.id === pinnedId)) {
				const assignment = await this.router.resolveRole('complete', {}, new Map(), this.resolver.localReachable);
				if (assignment.ready) {
					this.candidates = [{ id: pinnedId, name: `${assignment.model} (${assignment.providerLabel})` }, ...this.candidates];
				}
			}
			this.currentModelId = this.candidates.some(c => c.id === pinnedId) ? pinnedId : (this.candidates[0]?.id ?? '');
		} else if (!this.candidates.some(c => c.id === this.currentModelId)) {
			this.currentModelId = this.candidates[0]?.id ?? '';
		}
		this.onDidChangeModelInfoEmitter.fire();
	}

	/** Releases the in-flight request and cached suggestions. */
	dispose(): void {
		this.scheduler.dispose();
		this.cache.clear();
		this.configListener.dispose();
		this.onDidChangeModelInfoEmitter.dispose();
	}
}

/** Reads the `openvsChat.completions.*` settings. */
function readSettings(): CompletionSettings {
	const cfg = vscode.workspace.getConfiguration('openvsChat.completions');
	return {
		maxLines: cfg.get<number>('maxLines') ?? 6,
		prefixChars: cfg.get<number>('prefixChars') ?? 2000,
		suffixChars: cfg.get<number>('suffixChars') ?? 1000,
		maxTokens: cfg.get<number>('maxTokens') ?? 96,
		quotaReserve: cfg.get<number>('quotaReserve') ?? 0.15,
		slowMs: cfg.get<number>('slowMs') ?? 3000,
		excludeFiles: cfg.get<string[]>('excludeFiles') ?? [],
		disabledLanguages: cfg.get<string[]>('disabledLanguages') ?? [],
		allowUntrusted: cfg.get<boolean>('untrusted') ?? false,
	};
}

/**
 * What {@link registerInlineCompletions} hands back: the disposable registration itself, plus
 * the two things `openvsChat.completions.showStats` needs to reach — the shared output channel
 * and whichever provider instance is currently active (there is none while the feature is
 * toggled off).
 */
export interface CompletionsRegistration extends vscode.Disposable {
	readonly channel: vscode.OutputChannel;
	getActiveProvider(): OpenVSInlineCompletionProvider | undefined;
}

/**
 * Registers inline completions and keeps the registration in step with the enabled setting.
 *
 * Disabling disposes the provider rather than leaving it registered and returning nothing:
 * an off switch that still reads the document on every keystroke is not off.
 */
export function registerInlineCompletions(registry: ProviderRegistry, router: RoleRouter): CompletionsRegistration {
	const status = new CompletionStatusBar();
	const log = vscode.window.createOutputChannel('OpenVS Thor Completions');
	let active: { provider: OpenVSInlineCompletionProvider; registration: vscode.Disposable } | undefined;

	const sync = () => {
		const cfg = vscode.workspace.getConfiguration('openvsChat.completions');
		const enabled = cfg.get<boolean>('enabled') ?? true;
		status.setEnabled(enabled);
		if (enabled === !!active) {
			return;
		}
		if (!enabled) {
			active?.provider.dispose();
			active?.registration.dispose();
			active = undefined;
			return;
		}
		const provider = new OpenVSInlineCompletionProvider(registry, router, status, log);
		const registration = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			provider,
			{
				displayName: 'OpenVS Thor',
				// The editor debounces before calling the provider, which is strictly cheaper
				// than debouncing after the call has already been made.
				debounceDelayMs: cfg.get<number>('debounceMs') ?? 250,
			},
		);
		active = { provider, registration };
	};

	sync();
	const watcher = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('openvsChat.completions')) {
			sync();
		}
	});

	const disposable = new vscode.Disposable(() => {
		watcher.dispose();
		active?.provider.dispose();
		active?.registration.dispose();
		status.dispose();
		log.dispose();
	});

	return Object.assign(disposable, {
		channel: log,
		getActiveProvider: () => active?.provider,
	});
}
