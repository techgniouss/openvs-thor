/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { ModelEntry, ProviderInfo, entrySupportsTools, modelSupportsVision } from '../providers/types';

/**
 * The phases of an Auto run. Each phase can be served by a different model/provider,
 * letting users route planning, implementation and review to whichever model they
 * think is best (e.g. plan with Claude Opus, implement with Sonnet, review with GPT-4o).
 */
export type AutoRole = 'plan' | 'code' | 'review';

export const AUTO_ROLES: AutoRole[] = ['plan', 'code', 'review'];

/**
 * Roles the router can resolve. {@link AutoRole} is the Auto *pipeline*'s set and must stay
 * as it is — {@link AUTO_ROLES} drives `resolveAll()` and the Auto settings rows, so adding
 * a member there would put a completion entry in both. `complete` is resolved on its own.
 */
export type RoutedRole = AutoRole | 'complete';

/** Human-facing labels for the roles. */
export const ROLE_LABELS: Record<RoutedRole, string> = {
	plan: 'Planning',
	code: 'Implementation',
	review: 'Review',
	complete: 'Inline Completions',
};

/** The settings key (under `openvsChat.auto`) that stores each role's `provider:model`. */
const ROLE_SETTING: Record<RoutedRole, string> = {
	plan: 'auto.planModel',
	code: 'auto.codeModel',
	review: 'auto.reviewModel',
	complete: 'completions.model',
};

/**
 * A resolved decision for one role: which provider+model will serve it, where the
 * decision came from, whether it can actually run, and (if not) why.
 */
export interface RoleAssignment {
	readonly role: RoutedRole;
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
 * Providers never offered to {@link RoleRouter.inferredPool}.
 *
 * `custom` points at a local endpoint that may well not be running, and `antigravity`'s
 * credential is restricted by Google's terms to Google's own client — neither is something
 * to select on a user's behalf. Both remain available when pinned explicitly.
 */
const NOT_AUTO_INFERRED = new Set(['custom', 'antigravity']);

/**
 * Models never selected *on the user's behalf*, however well they would serve the role.
 *
 * These bill at a premium (or against a separate credit balance), and an inferred role is
 * a choice the user did not make — spending their credits on it is not ours to decide.
 * A user who wants one pins it per role, which bypasses inference entirely.
 */
const NOT_AUTO_SELECTED_MODELS: RegExp[] = [/fable/i, /opus/i, /\bo[13]-pro\b/i, /gpt-[0-9.]+-pro\b/i];

/**
 * Models never used for inline completion, however capable.
 *
 * Reasoning models emit their thinking before any code, which for a completion means
 * seconds of latency and then a suggestion for a cursor position that no longer exists.
 * The {@link NOT_AUTO_SELECTED_MODELS} set is folded in for its own reason as well: this
 * endpoint fires on every typing pause, making it the worst possible place to spend a
 * user's credits without being asked.
 */
const NOT_COMPLETION_MODELS: RegExp[] = [
	/-?r1\b/i, /think/i, /qwq/i, /\bo[1-9]\b/i, /reason/i, ...NOT_AUTO_SELECTED_MODELS,
];

/** Whether `model` is barred from serving inline completions. See {@link NOT_COMPLETION_MODELS}. */
export function isCompletionExcluded(model: string): boolean {
	return NOT_COMPLETION_MODELS.some(pattern => pattern.test(model));
}

/** The settings key holding a role's `provider:model` pin. */
export function roleSettingKey(role: RoutedRole): string {
	return ROLE_SETTING[role];
}

/**
 * How many inferred candidates are evaluated per role. Each costs a credential read and
 * becomes a runtime fallback link; a handful is enough to survive a bad model id without
 * turning one failing role into a long chain of doomed requests.
 */
const MAX_INFERRED_CANDIDATES = 5;

/**
 * How many models one provider may contribute to that chain.
 *
 * Unbounded, a user with one well-stocked provider gets a chain of five models behind a
 * single credential — and the failures a chain exists to survive (a revoked key, a region
 * outage, a gateway refusing that account) take every link with them at once. Capping it
 * spends the remaining links on *other* providers the user has.
 */
const MAX_PER_PROVIDER = 2;

/**
 * Name fragments that suggest a model suits a role, and ones that suggest it is a small
 * fast checkpoint that should rank below its larger siblings.
 *
 * Matched against the model id rather than a provider list, deliberately. The previous
 * design ranked by *vendor* — a fixed table naming specific Anthropic/OpenAI/NVIDIA model
 * ids, walked before anything else — which made Auto prefer paid frontier models, and
 * fail with a 404 for every user whose account could not actually serve the exact id that
 * table named. Ranking by capability keeps the choice inside whatever the user really has.
 */
const ROLE_AFFINITY: Record<RoutedRole, RegExp[]> = {
	// Planning and review are reasoning passes: prefer larger/thinking checkpoints.
	plan: [/sonnet|gpt-5|gpt-4|\bo[1-4]\b|large|max\b|reason|think|-r1|deepseek|nemotron|glm|235b|120b|70b/i],
	code: [/coder|-code|sonnet|gpt-5|gpt-4|devstral|codestral|qwen3|llama-3\.3|llama-4|gpt-oss|kimi|glm|deepseek|nemotron|120b|70b/i],
	review: [/sonnet|gpt-5|gpt-4|\bo[1-4]\b|large|max\b|reason|think|-r1|deepseek|nemotron|glm|120b|70b/i],
	// Deliberately NOT a copy of `code`, which matches deepseek/-r1/think and 70b/120b: every
	// one of those is wrong for a model that must answer in under a second.
	// Also deliberately excludes small/fast marketing terms (instant, flash, a bare
	// single-digit-b size on their own) that LIGHTWEIGHT already rewards on their own via
	// LIGHTWEIGHT_WEIGHT below — without this a model with no real coder specialization could
	// win purely for sounding fast (llama-3.1-8b-instant) over a genuine FIM/coder model that
	// doesn't happen to have a fast-sounding name (codestral-latest). This does not fully
	// separate the two signals: a name that is genuinely both coder-specific and small (e.g.
	// qwen2.5-coder:7b, codegemma:2b) still matches both tables and gets both bonuses — which
	// is correct here, since such a model really does have both properties, unlike the
	// marketing-only case this exclusion exists to prevent.
	complete: [/codestral|devstral|coder|-code|starcoder|codegemma|ministral/i],
};

/** Small/fast checkpoints — usable, but ranked under a larger sibling from the same key. */
const LIGHTWEIGHT = /mini|lite|small|tiny|instant|haiku|flash|\b[1-9]b\b|-[1-9]b\b|1[0-9]b\b/i;

/**
 * Magnitude of the lightweight-checkpoint adjustment to a candidate's score. Auto roles
 * subtract this (a small checkpoint ranks under its larger sibling); `complete` adds it
 * (latency dominates quality there) — see {@link scoreForRole}.
 */
const LIGHTWEIGHT_WEIGHT = 2;

/** Extra requirements this particular run puts on a role's model. */
export interface RoleNeeds {
	/** The request carries image attachments, so the model must accept them. */
	readonly vision?: boolean;
}

/**
 * Memoizes the credential lookup so one resolution pass reads each provider's secret once.
 * Exported so a caller resolving several roles together (an Auto run, the settings panel)
 * can share one across them instead of paying a full sweep per role.
 */
export type CredentialMemo = Map<string, Promise<boolean>>;

/**
 * Decides which provider+model serves each Auto phase. Honours the user's explicit
 * per-role configuration first (and never silently substitutes it); when a role is
 * left unset, it infers a model from whichever providers currently have a credential.
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
	getConfigured(role: RoutedRole): { providerId: string; model: string } | undefined {
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
	async setConfigured(role: RoutedRole, providerId: string, model: string): Promise<void> {
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

	/**
	 * Resolves a single role to a concrete assignment (configured or inferred).
	 *
	 * `localReachable` defaults to `false`, keeping every existing 3-argument call site
	 * (the Auto pipeline, the settings panel) exactly as it behaved before this role — the
	 * `custom` provider stays excluded for them. Only a caller that has confirmed the local
	 * endpoint answers (the completion resolver) passes `true`, and it only ever matters for
	 * `role === 'complete'` — see {@link inferable}.
	 */
	async resolveRole(role: RoutedRole, needs: RoleNeeds = {}, memo: CredentialMemo = new Map(), localReachable = false): Promise<RoleAssignment> {
		return (await this.resolveRoleCandidates(role, needs, memo, localReachable))[0];
	}

	/**
	 * Resolves a role to an ordered list of usable assignments (best first) so callers can
	 * fall back if the first model fails at runtime (e.g. a model id this account cannot
	 * actually serve). A configured role yields exactly one entry — it is honoured as-is and
	 * never substituted. An unset role yields the ranked inferred candidates.
	 *
	 * `ignorePin` defaults to `false`, keeping every existing call site's behavior (pin
	 * honoured as-is) unchanged. The one caller that needs the full ranked pool even while a
	 * role is pinned is the completions model *picker* — `resolve()`'s own path still calls
	 * this with `ignorePin: false` so the pin keeps governing which model actually serves a
	 * request; only the list shown to the user for switching away from it uses `true`.
	 */
	async resolveRoleCandidates(
		role: RoutedRole, needs: RoleNeeds = {}, memo: CredentialMemo = new Map(), localReachable = false, ignorePin = false,
	): Promise<RoleAssignment[]> {
		const configured = ignorePin ? undefined : this.getConfigured(role);
		if (configured) {
			return [await this.evaluate(role, configured.providerId, configured.model, 'configured', needs, memo)];
		}
		const ready: RoleAssignment[] = [];
		for (const candidate of await this.inferredPool(role, needs, memo, localReachable)) {
			const assignment = await this.evaluate(role, candidate.providerId, candidate.model, 'inferred', needs, memo);
			if (assignment.ready) {
				ready.push(assignment);
			}
			if (ready.length >= MAX_INFERRED_CANDIDATES) {
				break;
			}
		}
		// Fall back to the not-ready placeholder so callers get a clear problem to report.
		return ready.length ? ready : [this.noCandidate(role, needs)];
	}

	/** One credential read per provider per resolution pass, however many roles ask. */
	private credentials(providerId: string, memo: CredentialMemo): Promise<boolean> {
		let pending = memo.get(providerId);
		if (!pending) {
			pending = this.registry.hasCredentials(providerId);
			memo.set(providerId, pending);
		}
		return pending;
	}

	/**
	 * Every provider+model pair Auto may select for this role, best first.
	 *
	 * Built from what the user actually holds a credential for — never from a fixed table of
	 * vendor model ids. That table was the source of two failures at once: it preferred paid
	 * frontier models nobody asked to spend on, and it named exact model ids that a given
	 * account may not be entitled to, so the first request of a run 404'd. Offering *several*
	 * models per provider (the user's own pick first, then that provider's suggestions) also
	 * fixes the case where the one model a provider was represented by happened to fail the
	 * role's requirements, which used to disqualify the whole provider.
	 */
	private async inferredPool(
		role: RoutedRole,
		needs: RoleNeeds,
		memo: CredentialMemo,
		localReachable: boolean,
	): Promise<Array<{ providerId: string; model: string }>> {
		const pool: Array<{ providerId: string; model: string; score: number }> = [];
		for (const providerId of this.registry.ids) {
			if (!this.inferable(role, providerId, localReachable)) {
				continue;
			}
			const provider = this.registry.getProvider(providerId);
			if (!provider) {
				continue;
			}
			// Required even for providers that don't strictly need a key: an endpoint nobody
			// configured is not a sensible thing to route a run to unprompted.
			if (!await this.credentials(providerId, memo)) {
				continue;
			}
			const entries = this.catalog?.(providerId);
			const chosen = this.registry.getModel(providerId);
			const models = [...new Set([chosen, ...provider.info.suggestedModels].filter(m => !!m))];
			models.forEach((model, index) => {
				if (!this.selectable(role, providerId, provider.info, entries, model, needs)) {
					return;
				}
				pool.push({ providerId, model, score: scoreForRole(role, model, model === chosen, index) });
			});
		}
		pool.sort((a, b) => b.score - a.score);
		const perProvider = new Map<string, number>();
		return pool
			.filter(candidate => {
				const taken = perProvider.get(candidate.providerId) ?? 0;
				perProvider.set(candidate.providerId, taken + 1);
				return taken < MAX_PER_PROVIDER;
			})
			.map(({ providerId, model }) => ({ providerId, model }));
	}

	/**
	 * Which providers may be inferred for `role`.
	 *
	 * `custom` is kept out of the Auto roles because a local endpoint may not be running.
	 * For completion that reasoning inverts: a local FIM model answers in ~100 ms and costs
	 * no quota, which makes it the best backend available — and unlike the Auto case the
	 * premise is cheaply testable, so it is admitted when a reachability probe succeeds.
	 * `antigravity` stays out of every role.
	 */
	private inferable(role: RoutedRole, providerId: string, localReachable: boolean): boolean {
		if (providerId === 'antigravity') {
			return false;
		}
		if (providerId === 'custom') {
			return role === 'complete' && localReachable;
		}
		return !NOT_AUTO_INFERRED.has(providerId);
	}

	/** Whether a model may be *auto-selected* for a role (a pinned model skips this entirely). */
	private selectable(
		role: RoutedRole,
		providerId: string,
		info: ProviderInfo,
		entries: ModelEntry[] | undefined,
		model: string,
		needs: RoleNeeds,
	): boolean {
		if (NOT_AUTO_SELECTED_MODELS.some(pattern => pattern.test(model))) {
			return false;
		}
		if (role === 'complete' && isCompletionExcluded(model)) {
			return false;
		}
		// When the catalog has been fetched it is the account's own answer to "does this model
		// exist for me": suggesting one it doesn't list buys a 404 on the first request.
		if (entries?.length && !entries.some(entry => entry.id === model)) {
			return false;
		}
		if (role === 'code' && !this.toolCapable(providerId, info, model)) {
			return false;
		}
		return !(needs.vision && !modelSupportsVision(info, model));
	}

	/** Resolves every role (for the settings UI and pre-flight checks). */
	async resolveAll(): Promise<RoleAssignment[]> {
		// One memo across all three roles: the settings panel renders this on every refresh.
		const memo: CredentialMemo = new Map();
		return Promise.all(AUTO_ROLES.map(role => this.resolveRole(role, {}, memo)));
	}

	/** Builds (and validates) an assignment for an explicit provider+model choice. */
	private async evaluate(
		role: RoutedRole,
		providerId: string,
		model: string,
		source: 'configured' | 'inferred',
		needs: RoleNeeds,
		memo: CredentialMemo,
	): Promise<RoleAssignment> {
		const roleLabel = ROLE_LABELS[role];
		const provider = this.registry.getProvider(providerId);
		if (!providerId || !provider) {
			return {
				role, roleLabel, providerId, providerLabel: providerId || '(unset)', model, source,
				ready: false,
				problem: `Unknown provider "${providerId || '?'}". Use the format provider:model (e.g. anthropic:claude-sonnet-5).`,
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
		// Checked here as well as in `selectable` so a *pinned* model that can't take the
		// run's images is reported as a routing problem rather than a provider 400 mid-run.
		if (needs.vision && !modelSupportsVision(provider.info, model)) {
			return {
				role, roleLabel, providerId, providerLabel, model, source, ready: false,
				problem: `"${model}" doesn't accept image input. Remove the attached image(s) or pin a vision-capable model for ${roleLabel.toLowerCase()}.`,
			};
		}
		if (provider.info.requiresApiKey && !await this.credentials(providerId, memo)) {
			return {
				role, roleLabel, providerId, providerLabel, model, source, ready: false,
				problem: `No API key for ${providerLabel}. Add a key or sign in (⚙ Providers) to use it for ${roleLabel.toLowerCase()}.`,
			};
		}
		return { role, roleLabel, providerId, providerLabel, model, source, ready: true };
	}

	/** The placeholder returned when nothing the user has configured can serve a role. */
	private noCandidate(role: RoutedRole, needs: RoleNeeds): RoleAssignment {
		// Both requirements are named when both apply: told only about tools, a user who
		// attached an image goes looking for a tool-capable model they already have.
		const wanted = [role === 'code' ? 'tool-capable' : '', needs.vision ? 'vision-capable' : ''].filter(Boolean);
		const requirement = wanted.length ? ` with a ${wanted.join(', ')} model` : '';
		return {
			role,
			roleLabel: ROLE_LABELS[role],
			providerId: '',
			providerLabel: '(none)',
			model: '',
			source: 'inferred',
			ready: false,
			problem: `No configured provider can serve ${ROLE_LABELS[role].toLowerCase()}${requirement}. Add an API key (⚙ Providers) or pin a model in settings.`,
		};
	}
}

/**
 * Ranks one candidate model for a role. Higher wins.
 *
 * `index` is the model's position in its provider's own list, used only as a tiebreak so
 * that a provider's headline model outranks its long tail. The user's own selected model
 * for that provider gets a bonus because it is the one choice here they actually made.
 */
export function scoreForRole(role: RoutedRole, model: string, isUserChoice: boolean, index: number): number {
	let value = ROLE_AFFINITY[role].some(pattern => pattern.test(model)) ? 3 : 0;
	// For the Auto roles a small checkpoint ranks below its larger sibling. For completion
	// the trade reverses: latency is the dominant quality term, because a suggestion that
	// arrives after the cursor moved scores zero no matter how good it is.
	const lightweight = LIGHTWEIGHT.test(model);
	if (role === 'complete') {
		value += lightweight ? LIGHTWEIGHT_WEIGHT : 0;
	} else if (lightweight) {
		value -= LIGHTWEIGHT_WEIGHT;
	}
	if (isUserChoice) {
		// Outranks role affinity deliberately: of everything in this pool it is the one model
		// the user picked themselves, and Auto silently preferring a sibling they didn't choose
		// is the surprise. Affinity still decides among the models nobody chose — including
		// when the chosen one can't serve the role at all and is filtered out before scoring.
		value += 4;
	}
	return value + Math.max(0, 1 - index * 0.1);
}
