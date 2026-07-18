/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { modelSupportsTools } from '../providers/types';

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
 * Ranked inference candidates per role. The first candidate whose provider has a key
 * (and, for `code`, is tool-capable) wins. These are deliberately ordered "best first".
 */
const INFERENCE_CANDIDATES: Record<AutoRole, Array<{ providerId: string; model: string }>> = {
	// Planning benefits from strong reasoning; tools are not needed here. Widely-available
	// models are listed first; reasoning-only models (o-series) come later as they have
	// stricter API constraints.
	plan: [
		{ providerId: 'anthropic', model: 'claude-opus-4-5' },
		{ providerId: 'openai', model: 'gpt-4o' },
		{ providerId: 'anthropic', model: 'claude-sonnet-4-5' },
		{ providerId: 'nvidia', model: 'nvidia/llama-3.1-nemotron-70b-instruct' },
		{ providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
	],
	// Implementation drives the tool loop, so every candidate must be tool-capable.
	code: [
		{ providerId: 'anthropic', model: 'claude-sonnet-4-5' },
		{ providerId: 'openai', model: 'gpt-4o' },
		{ providerId: 'anthropic', model: 'claude-sonnet-4-0' },
		{ providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
		{ providerId: 'nvidia', model: 'qwen/qwen2.5-coder-32b-instruct' },
	],
	// Review is a critique pass; tools are not needed.
	review: [
		{ providerId: 'openai', model: 'gpt-4o' },
		{ providerId: 'anthropic', model: 'claude-sonnet-4-5' },
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
	constructor(private readonly registry: ProviderRegistry) { }

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
		// Fall back to the not-ready placeholder so callers get a clear problem to report.
		return ready.length ? ready : [await this.infer(role)];
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
		if (role === 'code' && !modelSupportsTools(provider.info, model)) {
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

	/** Picks the best available model for a role from the ranked candidate list. */
	private async infer(role: AutoRole): Promise<RoleAssignment> {
		for (const candidate of INFERENCE_CANDIDATES[role]) {
			const provider = this.registry.getProvider(candidate.providerId);
			if (!provider) {
				continue;
			}
			if (role === 'code' && !modelSupportsTools(provider.info, candidate.model)) {
				continue;
			}
			const hasKey = await this.registry.hasCredentials(candidate.providerId);
			if (provider.info.requiresApiKey && !hasKey) {
				continue;
			}
			return {
				role,
				roleLabel: ROLE_LABELS[role],
				providerId: candidate.providerId,
				providerLabel: provider.info.label,
				model: candidate.model,
				source: 'inferred',
				ready: true,
			};
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
