/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Counters for one model. */
interface ModelStats {
	shown: number;
	accepted: number;
}

/** How many samples a model needs before its acceptance rate means anything. */
const MIN_SAMPLES = 10;

/** One model's record, for the stats command. */
export interface StatsRow {
	readonly model: string;
	readonly shown: number;
	readonly accepted: number;
	readonly rate: number | undefined;
}

/**
 * Tracks how often each model's suggestions are actually taken.
 *
 * This is the only measurement that says whether the feature *works*. Latency and error rate
 * say whether it runs; acceptance says whether what it produces was worth showing — which
 * matters more here than it would for a single-vendor product, because the model pool is
 * whatever free-tier backends the user happens to hold keys for and their quality varies
 * enormously.
 *
 * Local and in-memory. Nothing is transmitted anywhere.
 */
export class CompletionStats {
	private readonly byModel = new Map<string, ModelStats>();

	private entry(model: string): ModelStats {
		const existing = this.byModel.get(model);
		if (existing) {
			return existing;
		}
		const created: ModelStats = { shown: 0, accepted: 0 };
		this.byModel.set(model, created);
		return created;
	}

	shown(model: string): void {
		this.entry(model).shown++;
	}

	accepted(model: string): void {
		this.entry(model).accepted++;
	}

	/** Recorded so the model appears in {@link report} even when nothing is ever accepted. */
	rejected(model: string): void {
		this.entry(model);
	}

	/**
	 * A partial accept counts as an accept. A user taking one word of a suggestion is
	 * evidence it was on the right track, which is what this measures.
	 */
	partial(model: string, _chars: number): void {
		this.entry(model).accepted++;
	}

	/**
	 * Acceptance rate, or undefined below {@link MIN_SAMPLES} — undefined rather than zero,
	 * so a newly-tried model is ranked as unknown rather than as bad.
	 */
	rateFor(model: string): number | undefined {
		const stats = this.byModel.get(model);
		if (!stats || stats.shown < MIN_SAMPLES) {
			return undefined;
		}
		return stats.accepted / stats.shown;
	}

	/** Every model's record, for `openvsChat.completions.showStats`. */
	report(): StatsRow[] {
		return [...this.byModel.entries()].map(([model, stats]) => ({
			model,
			shown: stats.shown,
			accepted: stats.accepted,
			rate: this.rateFor(model),
		}));
	}
}
