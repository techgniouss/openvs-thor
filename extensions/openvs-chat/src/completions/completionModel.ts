/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RoleRouter } from '../auto/router';
import { ProviderRegistry } from '../providers/registry';
import { modelSupportsFim } from '../providers/types';

/** The backend a completion request will be sent to. */
export interface ResolvedCompletionModel {
	readonly providerId: string;
	readonly model: string;
	/** True when the provider can serve this model through a real FIM endpoint. */
	readonly usesFim: boolean;
}

/** How long a local-endpoint reachability result is trusted before being re-probed. */
const PROBE_TTL_MS = 60_000;
/** How long a probe may take before it is treated as unreachable. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Decides which provider and model serve inline completions.
 *
 * Thin on purpose: ranking, credential inference and pin handling all belong to
 * {@link RoleRouter}, which is already tested. What lives here is the one thing the router
 * cannot decide from a pure table — whether the user's local endpoint is actually up.
 *
 * `RoleRouter` and `ProviderRegistry` are used only as parameter types below, so tsc elides
 * these two imports from the emitted JS — neither `../auto/router.js` nor
 * `../providers/registry.js` (both of which pull in `vscode` at module scope) actually loads
 * at runtime here, which is what lets `test-completion-router.mjs` exercise this class with
 * plain duck-typed stubs and no `vscode` stub.
 */
export class CompletionModelResolver {
	private probedAt = 0;
	private probeResult = false;
	private probing = false;

	constructor(
		private readonly router: RoleRouter,
		private readonly registry: ProviderRegistry,
	) { }

	/** The last completed reachability probe's result — see {@link refreshProbeIfStale}. */
	get localReachable(): boolean {
		return this.probeResult;
	}

	/**
	 * The current completion backend, or undefined when nothing is eligible.
	 *
	 * Routes on the *last completed* local-endpoint probe, never on one still in flight —
	 * see {@link refreshProbeIfStale}. A stale probe under-admits `custom` for one extra
	 * cycle at worst; a blocking one pays a dead endpoint's connection timeout on every
	 * keystroke pause, which is the failure this design exists to avoid.
	 */
	async resolve(): Promise<ResolvedCompletionModel | undefined> {
		this.refreshProbeIfStale();
		const assignment = await this.router.resolveRole('complete', {}, new Map(), this.probeResult);
		if (!assignment.ready || !assignment.providerId || !assignment.model) {
			return undefined;
		}
		const info = this.registry.getProvider(assignment.providerId)?.info;
		return {
			providerId: assignment.providerId,
			model: assignment.model,
			usesFim: !!info && modelSupportsFim(info, assignment.model),
		};
	}

	/**
	 * Kicks a reachability probe when the cached result is older than {@link PROBE_TTL_MS},
	 * without ever being awaited by {@link resolve} — `resolve` is on the typing path, and a
	 * probe that blocks it pays a dead endpoint's connection timeout on every keystroke pause
	 * that lands during the check. `resolve` always routes on whatever the *previous* probe
	 * found; a probe kicked here updates `probeResult` for the call after it, once it lands.
	 */
	private refreshProbeIfStale(now = Date.now()): void {
		if (this.probing || now - this.probedAt < PROBE_TTL_MS) {
			return;
		}
		this.probing = true;
		this.probedAt = now;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		this.registry.listModels('custom', controller.signal)
			.then(() => { this.probeResult = true; })
			.catch(() => { this.probeResult = false; })
			.finally(() => { clearTimeout(timer); this.probing = false; });
	}
}
