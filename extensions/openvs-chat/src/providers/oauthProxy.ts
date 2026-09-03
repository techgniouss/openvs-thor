/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';

interface CachedToken {
	readonly token: string;
	readonly expiresAt: number;
}

/** Re-mint this long before actual expiry, so a request that's mid-flight when the cached
 * token would otherwise lapse still completes on it. Matches Copilot's own ~5-minute
 * `refresh_in` margin observed in a companion project. */
const MINT_MARGIN_MS = 5 * 60_000;

/**
 * Base for a provider whose STORED credential is not the token sent on the wire — e.g.
 * Copilot, where the stored value is a long-lived GitHub OAuth token and the wire value is a
 * short-lived Copilot token exchanged from it (~30min). Minting once per request would
 * double the latency of every call, so the exchanged token is cached per stored credential
 * and only re-minted when missing or within {@link MINT_MARGIN_MS} of its stated expiry.
 *
 * A provider with only ONE stage (Grok, Kiro: the stored credential IS an access/refresh
 * token pair, just one that needs periodic refreshing) still fits this shape — `mintToken`
 * simply validates the current token and refreshes when it's near expiry, returning it
 * unchanged otherwise.
 *
 * `OpenAICompatibleProvider.authHeaders(apiKey)` is synchronous and called inline while
 * `streamChat`/`runAgentStep`/`listModels`/`completeFim` build their request, but minting is
 * necessarily async (it's a network call) — so those methods can't just be handed the stored
 * credential and trusted to mint it via an overridden `authHeaders`. Subclasses instead
 * override `streamChat`/`runAgentStep`/`listModels` themselves: resolve {@link wireToken} for
 * `request.apiKey` first, then delegate to `super.streamChat({ ...request, apiKey: token })`
 * (etc.), and override the *synchronous* `authHeaders` to shape the now-already-minted token
 * into whatever headers the wire endpoint needs.
 */
export abstract class OAuthProxyChatProvider extends OpenAICompatibleProvider {
	private readonly cache = new Map<string, CachedToken>();
	private readonly inflight = new Map<string, Promise<CachedToken>>();

	/** Exchanges/validates `storedCredential`, returning the token to send on the wire and
	 * when it expires (epoch ms). Called at most once per credential per mint window — see
	 * {@link wireToken}. */
	protected abstract mintToken(storedCredential: string, signal: AbortSignal): Promise<CachedToken>;

	/**
	 * The token to actually send for `storedCredential`. Serves the cached value while it's
	 * fresh; otherwise mints once (de-duplicating a concurrent burst onto the same in-flight
	 * mint, so N requests arriving together cost one exchange, not N) and caches the result.
	 */
	protected async wireToken(storedCredential: string, signal: AbortSignal): Promise<string> {
		const cached = this.cache.get(storedCredential);
		if (cached && cached.expiresAt - Date.now() > MINT_MARGIN_MS) {
			return cached.token;
		}
		let pending = this.inflight.get(storedCredential);
		if (!pending) {
			pending = this.mintToken(storedCredential, signal).finally(() => {
				this.inflight.delete(storedCredential);
			});
			this.inflight.set(storedCredential, pending);
		}
		const minted = await pending;
		this.cache.set(storedCredential, minted);
		return minted.token;
	}
}
