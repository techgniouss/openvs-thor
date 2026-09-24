/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelEntry } from './types';

/**
 * Each provider's live model catalog, fetched at most once at a time and cached until a
 * credential change invalidates it. `vscode`-free (the lister is injected) so
 * `scripts/test-model-catalog.mjs` can drive the races directly.
 *
 * Two races this exists to close, both of which made the model pickers show a different list
 * from one refresh to the next:
 *  - `postConfig` runs after nearly every settings action, and each run started its own fetch
 *    for every uncached provider; the replies landed in whatever order the network chose.
 *    Concurrent loads now share one in-flight fetch.
 *  - A fetch started before a key change carries the old credential. When it finished after the
 *    change, it overwrote the fresh catalog with the old account's list. Each provider has a
 *    generation, bumped by {@link invalidate}; a fetch only caches if its generation is current.
 */
export class ModelCatalog {
	private readonly cache = new Map<string, ModelEntry[]>();
	private readonly fetches = new Map<string, Promise<ModelEntry[]>>();
	private readonly generations = new Map<string, number>();

	constructor(private readonly list: (providerId: string, signal: AbortSignal) => Promise<ModelEntry[]>) { }

	/** The cached catalog, if one is loaded. */
	get(providerId: string): ModelEntry[] | undefined {
		return this.cache.get(providerId);
	}

	/** Caches a catalog fetched elsewhere. */
	set(providerId: string, models: ModelEntry[]): void {
		this.cache.set(providerId, models);
	}

	/** The provider's current generation — compare before and after an await to tell whether a credential change superseded it. */
	generation(providerId: string): number {
		return this.generations.get(providerId) ?? 0;
	}

	/** The cache unless `refresh`, else the fetch already in flight, else a new one. */
	load(providerId: string, refresh: boolean): Promise<ModelEntry[]> {
		const cached = this.cache.get(providerId);
		if (cached && !refresh) {
			return Promise.resolve(cached);
		}
		const inFlight = this.fetches.get(providerId);
		if (inFlight) {
			return inFlight;
		}
		const generation = this.generation(providerId);
		const fetch = this.list(providerId, new AbortController().signal).then(models => {
			if (this.generation(providerId) === generation && models.length) {
				this.cache.set(providerId, models);
			}
			return models;
		}).finally(() => {
			if (this.fetches.get(providerId) === fetch) {
				this.fetches.delete(providerId);
			}
		});
		this.fetches.set(providerId, fetch);
		return fetch;
	}

	/** Forgets the catalog after a credential change, and disowns any fetch still running under the old one. */
	invalidate(providerId: string): void {
		this.cache.delete(providerId);
		this.fetches.delete(providerId);
		this.generations.set(providerId, this.generation(providerId) + 1);
	}
}
