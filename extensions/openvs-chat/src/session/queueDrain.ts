/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decides which client's queue drain wins. Every client — the desktop panel and each paired
 * phone — holds the same shared queue and drains it on the same `done`, so with a phone
 * paired a queued follow-up used to be sent twice; and since a send aborts the tab's running
 * request, the second copy killed the run the first had just started and appended the turn
 * twice. One drain is accepted per finished run; any other is refused.
 */
export class QueueDrainGate {
	/** Tabs whose last run has finished and whose queue has not been drained since. */
	private readonly drainable = new Set<string>();

	/** Records that `sessionId`'s run finished (its `done` is being posted). */
	runFinished(sessionId: string): void {
		this.drainable.add(sessionId);
	}

	/**
	 * Admits a send for `sessionId`, or refuses it. A queue drain is admitted only while the
	 * tab's finished run has not been drained yet; any other send is always admitted. Either
	 * way an admitted send starts a run, so the tab stops being drainable until that run ends.
	 */
	admit(sessionId: string, fromQueue: boolean): boolean {
		if (fromQueue && !this.drainable.has(sessionId)) {
			return false;
		}
		this.drainable.delete(sessionId);
		return true;
	}
}
