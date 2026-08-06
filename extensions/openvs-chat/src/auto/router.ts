/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { ModelEntry, ProviderInfo, entrySupportsTools } from '../providers/types';

/**
 * The phases of an Auto run. Each phase can be served by a different model/provider,
 * letting users route planning, implementation and review to whichever model they
 * think is best (e.g. plan with Claude Opus, implement with Sonnet, review with GPT-4o).
 */
export type AutoRole = 'plan' | 'code' | 'review';

export const AUTO_ROLES: AutoRole[] = ['plan', 'code', 'review'];

/** Human-facing labels for the roles. */
export const ROLE_LABELS: Record<AutoRole, string> = {
	plan: 'Planning',
	code: 'Implementation',
	review: 'Review',
};

/** The settings key (under `openvsChat.auto`) that stores each role's `provider:model`. */
const ROLE_SETTING: Record<AutoRole, string> = {
	plan: 'auto.planModel',
	code: 'auto.codeModel',
	review: 'auto.reviewModel',
};

/**
 * A resolved decision for one role: which provider+model will serve it, where the
 * decision came from, whether it can actually run, and (if not) why.
 */
export interface RoleAssignment {
	readonly role: AutoRole;
	readonly roleLabel: string;
	/** '' when nothing could be resolved. */
	readonly providerId: string;
	readonly providerLabel: string;
	readonly model: string;
	/** 'configured' = the user pinned it; 'inferred' = chosen automatically. */
	readonly source: 'configured' | 'inferred';
	/** True when this assignment can run right now (provider exists + has a key + capable). */
	readonly ready: boolean;
	/** Explains why `ready` is false, suitable for showing to the user. */
	readonly problem?: string;
}

/**
 * Providers left out of the {@link RoleRouter.sweepCandidates} fallback.
 *
 * `custom` points at a local endpoint that may well not be running, and `antigravity`'s
 * credential is restricted by Google's terms to Google's own client — neither is something
 * to select on a user's behalf. Both remain available when pinned explicitly.
 */
const NOT_AUTO_INFERRED = new Set(['custom', 'antigravity']);

/**
 * Ranked inference candidates per role. The first candidate whose provider has a key
 * (and, for `code`, is tool-capable) wins. These are deliberately ordered "best first".
 *
 * Deliberately short: it names the models worth *preferring* when several providers are
 * configured. It is not the list of providers Auto supports — when none of these can run,
 * {@link RoleRouter.sweepCandidates} falls back to whatever the user actually has a
 * credential for, which is what keeps Auto working for someone whose only key is a free
 * provider (Groq, Mistral, Cloudflare, Gemini, OpenRouter, …) rather than telling them no
 * provider can serve the role.
 */
const INFERENCE_CANDIDATES: Record<AutoRole, Array<{ providerId: string; model: string }>> = {
	// Planning benefits from strong reasoning; tools are not needed here. Widely-available
	// models are listed first; reasoning-only models (o-series) come later as they have
	// stricter API constraints.
	plan: [
		{ providerId: 'anthropic', model: 'claude-fable-5' },
		{ providerId: 'anthropic', model: 'claude-opus-4-8' },
		{ providerId: 'openai', model: 'gpt-4o' },
		{ providerId: 'anthropic', model: 'claude-sonnet-5' },
		{ providerId: 'nvidia', model: 'nvidia/llama-3.1-nemotron-70b-instruct' },
		{ providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
	],
	// Implementation drives the tool loop, so every candidate must be tool-capable.
	code: [
		{ providerId: 'anthropic', model: 'claude-sonnet-5' },
		{ providerId: 'openai', model: 'gpt-4o' },
		{ providerId: 'anthropic', model: 'claude-sonnet-4-5' },
		{ providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
		{ providerId: 'nvidia', model: 'qwen/qwen2.5-coder-32b-instruct' },
	],
	// Review is a critique pass; tools are not needed.
	review: [
		{ providerId: 'openai', model: 'gpt-4o' },
		{ providerId: 'anthropic', model: 'claude-sonnet-5' },
		{ providerId: 'anthropic', model: 'claude-haiku-4-5' },
		{ providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
	],
};

/**
 * Decides which provider+model serves each Auto phase. Honours the user's explicit
 * per-role configuration first (and never silently substitutes it); when a role is
 * left unset, it infers a sensible model from whichever providers currently have a key.
 */
export class RoleRouter {
	constructor(
		private readonly registry: ProviderRegistry,
		/**
		 * The host's cached model catalog for a provider, when fetched. Tool capability was
		 * decided from the model *name* alone, while every other surface prefers the
		 * catalog's own report — so Auto could refuse a model as "not tool-capable" that
		 * plain Agent mode ran happily, and the user had no way to tell which was right.
		 */
		private readonly catalog?: (providerId: string) => ModelEntry[] | undefined,
	) { }

	/** Whether `model` can drive the tool loop, preferring the provider catalog's own report. */
	private toolCapable(providerId: string, info: ProviderInfo, model: string): boolean {
		return entrySupportsTools(info, this.catalog?.(providerId), model);
	}

	/** Reads the raw `provider:model` setting for a role (empty string if unset). */
	getConfigured(role: AutoRole): { providerId: string; model: string } | undefined {
		const raw = vscode.workspace.getConfiguration('openvsChat').get<string>(ROLE_SETTING[role])?.trim();
		if (!raw) {
			return undefined;
		}
		const idx = raw.indexOf(':');
		if (idx === -1) {
			// Tolerate a bare model id by leaving the provider blank (treated as invalid below).
			return { providerId: '', model: raw };
		}
		return { providerId: raw.slice(0, idx).trim(), model: raw.slice(idx + 1).trim() };
	}

	/** Persists a role assignment, or clears it (revert to auto-infer) when providerId is empty. */
	async setConfigured(role: AutoRole, providerId: string, model: string): Promise<void> {
		const value = providerId && model ? `${providerId}:${model}` : '';
		await vscode.workspace.getConfiguration('openvsChat').update(
			ROLE_SETTING[role], value, vscode.ConfigurationTarget.Global);
	}

	isReviewEnabled(): boolean {
		return vscode.workspace.getConfiguration('openvsChat').get<boolean>('auto.enableReview') ?? true;
	}

	/** Whether Auto+Agent should split the plan into steps and run a sub-agent per step. */
	isDecompose(): boolean {
		return vscode.workspace.getConfiguration('openvsChat').get<boolean>('auto.decompose') ?? false;
	}

	/** Resolves a single role to a concrete assignment (configured or inferred). */
	async resolveRole(role: AutoRole): Promise<RoleAssignment> {
		const configured = this.getConfigured(role);
		if (configured) {
			return this.evaluate(role, configured.providerId, configured.model, 'configured');
		}
		return this.infer(role);
	}

	/**
	 * Resolves a role to an ordered list of usable assignments (best first) so callers can
	 * fall back if the first model fails at runtime (e.g. a hardcoded model id that doesn't
	 * exist for this account). A configured role yields exactly one entry — it is honoured
	 * as-is and never substituted. An unset role yields every ready inferred candidate.
	 */
	async resolveRoleCandidates(role: AutoRole): Promise<RoleAssignment[]> {
		const configured = this.getConfigured(role);
		if (configured) {
			return [await this.evaluate(role, configured.providerId, configured.model, 'configured')];
		}
		const ready: RoleAssignment[] = [];
		for (const candidate of INFERENCE_CANDIDATES[role]) {
			const assignment = await this.evaluate(role, candidate.providerId, candidate.model, 'inferred');
			if (assignment.ready) {
				ready.push(assignment);
			}
		}
		// Only when the preferred models can't run at all — the sweep costs a credential read
		// per provider, and it exists to rescue the "none of the above" case, not to pad a
		// list that already has usable entries.
		if (!ready.length) {
			for (const candidate of await this.sweepCandidates()) {
				const assignment = await this.evaluate(role, candidate.providerId, candidate.model, 'inferred');
				if (assignment.ready) {
					ready.push(assignment);
				}
			}
		}
		// Fall back to the not-ready placeholder so callers get a clear problem to report.
		return ready.length ? ready : [await this.infer(role)];
	}

	/** The first candidate that can actually run, or undefined if none can. */
	private async firstReady(
		role: AutoRole,
		candidates: ReadonlyArray<{ providerId: string; model: string }>,
	): Promise<RoleAssignment | undefined> {
		for (const candidate of candidates) {
			const assignment = await this.evaluate(role, candidate.providerId, candidate.model, 'inferred');
			if (assignment.ready) {
				return assignment;
			}
		}
		return undefined;
	}

	/**
	 * Every provider the user actually holds a credential for, paired with its current
	 * model — the configured one, or that provider's first suggestion.
	 *
	 * This is the backstop behind {@link INFERENCE_CANDIDATES}, which names specific models
	 * from three providers only. Without it, Auto mode is unusable for anyone whose only key
	 * is for one of the other providers: every role resolves to "no configured provider can
	 * serve this", while plain Ask/Agent works fine with the very same key. Deriving the
	 * model from the registry rather than hardcoding one per provider also means a provider
	 * added later is covered without touching this file.
	 */
	private async sweepCandidates(): Promise<Array<{ providerId: string; model: string }>> {
		const out: Array<{ providerId: string; model: string }> = [];
		for (const providerId of this.registry.ids) {
			if (NOT_AUTO_INFERRED.has(providerId)) {
				continue;
			}
			// Required even for providers that don't strictly need a key: an endpoint nobody
			// configured is not a sensible thing to route a run to unprompted.
			if (!await this.registry.hasCredentials(providerId)) {
				continue;
			}
			const model = this.registry.getModel(providerId);
			if (model) {
				out.push({ providerId, model });
			}
		}
		return out;
	}

	/** Resolves every role (for the settings UI and pre-flight checks). */
	async resolveAll(): Promise<RoleAssignment[]> {
		return Promise.all(AUTO_ROLES.map(role => this.resolveRole(role)));
	}

	/** Builds (and validates) an assignment for an explicit provider+model choice. */
	private async evaluate(
		role: AutoRole,
		providerId: string,
		model: string,
		source: 'configured' | 'inferred',
	): Promise<RoleAssignment> {
		const roleLabel = ROLE_LABELS[role];
		const provider = this.registry.getProvider(providerId);
		if (!providerId || !provider) {
			return {
				role, roleLabel, providerId, providerLabel: providerId || '(unset)', model, source,
				ready: false,
				problem: `Unknown provider "${providerId || '?'}". Use the format provider:model (e.g. anthropic:claude-opus-4-0).`,
			};
		}
		const providerLabel = provider.info.label;
		if (!model) {
			return { role, roleLabel, providerId, providerLabel, model, source, ready: false, problem: 'No model set.' };
		}
		// The implementation phase runs the tool loop, so its model must support tools.
		if (role === 'code' && !this.toolCapable(providerId, provider.info, model)) {
			return {
				role, roleLabel, providerId, providerLabel, model, source, ready: false,
				problem: `"${model}" is not tool-capable, but the implementation phase needs tools. Pick a tool-capable model.`,
			};
		}
		const hasKey = await this.registry.hasCredentials(providerId);
		if (provider.info.requiresApiKey && !hasKey) {
			return {
				role, roleLabel, providerId, providerLabel, model, source, ready: false,
				problem: `No API key for ${providerLabel}. Add a key or sign in (⚙ Providers) to use it for ${roleLabel.toLowerCase()}.`,
			};
		}
		return { role, roleLabel, providerId, providerLabel, model, source, ready: true };
	}

	/**
	 * Picks the best available model for a role from the ranked candidate list, falling back
	 * to whatever the user has a credential for.
	 *
	 * The two lists are walked in sequence rather than concatenated: the sweep costs a
	 * credential read per provider, and building it up front would charge every caller for it
	 * even when the very first preferred candidate wins — which is the common case, and this
	 * runs on the settings panel's render path.
	 */
	private async infer(role: AutoRole): Promise<RoleAssignment> {
		const preferred = await this.firstReady(role, INFERENCE_CANDIDATES[role]);
		if (preferred) {
			return preferred;
		}
		const swept = await this.firstReady(role, await this.sweepCandidates());
		if (swept) {
			return swept;
		}
		return {
			role,
			roleLabel: ROLE_LABELS[role],
			providerId: '',
			providerLabel: '(none)',
			model: '',
			source: 'inferred',
			ready: false,
			problem: `No configured provider can serve ${ROLE_LABELS[role].toLowerCase()}. Add an API key (⚙ Providers) or pin a model in settings.`,
		};
	}
}
