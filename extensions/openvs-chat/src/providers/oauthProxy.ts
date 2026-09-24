/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';

/** What one mint produced. */
export interface WireSession {
	readonly token: string;
	/** When `token` expires, epoch ms. */
	readonly expiresAt: number;
	/** Where to send requests with this token, when the mint said (Copilot names a per-account host). */
	readonly baseUrl?: string;
	/**
	 * The stored credential as it should now be saved, when the mint refreshed it — a new
	 * access token, and a new refresh token where the vendor rotates them. See
	 * {@link OAuthProxyChatProvider.setCredentialPersister}.
	 */
	readonly updatedCredential?: string;
}

/** Re-mint this long before actual expiry, so a request that's mid-flight when the cached
 * token would otherwise lapse still completes on it. Matches Copilot's own ~5-minute
 * `refresh_in` margin observed in a companion project. */
const MINT_MARGIN_MS = 5 * 60_000;

/**
 * Longest a mint may take. It runs on its own signal (see {@link OAuthProxyChatProvider.wireSession}),
 * so without a bound a refresh endpoint that never answers would hold every later request for
 * that credential, on a shared promise no caller could cancel.
 */
const MINT_TIMEOUT_MS = 30_000;

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
 * override `streamChat`/`runAgentStep`/`listModels` themselves: run the request inside
 * {@link withWireSession} for `request.apiKey`, delegating to
 * `super.streamChat({ ...request, apiKey: session.token })` (etc.), and override the
 * *synchronous* `authHeaders` to shape the now-already-minted token into whatever headers the
 * wire endpoint needs.
 */
export abstract class OAuthProxyChatProvider extends OpenAICompatibleProvider {
	private readonly cache = new Map<string, WireSession>();
	private readonly inflight = new Map<string, Promise<WireSession>>();
	/**
	 * A stored credential a refresh replaced, mapped to its replacement, for requests still
	 * carrying the old string. Refresh tokens that rotate are single-use: minting from the
	 * old one again would fail and force a new sign-in.
	 */
	private readonly successor = new Map<string, string>();
	private persist?: (previous: string, next: string) => Promise<void>;

	/**
	 * Saves a refreshed credential over the one it replaced. Wired by the registry, which owns
	 * credential storage. A refreshed token that is never saved is refreshed again after every
	 * restart — and where the vendor rotates refresh tokens, the saved one is already spent.
	 */
	setCredentialPersister(persist: (previous: string, next: string) => Promise<void>): void {
		this.persist = persist;
	}

	/** Exchanges/validates `storedCredential`, returning the token to send on the wire and
	 * when it expires (epoch ms). Called at most once per credential per mint window — see
	 * {@link wireSession}. */
	protected abstract mintToken(storedCredential: string, signal: AbortSignal): Promise<WireSession>;

	/**
	 * The session to actually send with for `storedCredential`. Serves the cached value while
	 * it's fresh; otherwise mints once (de-duplicating a concurrent burst onto the same
	 * in-flight mint, so N requests arriving together cost one exchange, not N) and caches it.
	 *
	 * The mint runs on its own signal, not the first caller's: that promise is shared, so a
	 * Stop in the tab that happened to start it used to fail the same request in every other
	 * tab waiting on it. Each caller still stops waiting the moment its own signal aborts.
	 */
	protected async wireSession(storedCredential: string, signal: AbortSignal): Promise<WireSession> {
		const stored = this.current(storedCredential);
		const cached = this.cache.get(stored);
		if (cached && cached.expiresAt - Date.now() > MINT_MARGIN_MS) {
			return cached;
		}
		let pending = this.inflight.get(stored);
		if (!pending) {
			const own = new AbortController();
			const timer = setTimeout(() => own.abort(), MINT_TIMEOUT_MS);
			pending = this.mintToken(stored, own.signal).then(async minted => {
				await this.adopt(stored, minted);
				return minted;
			}).finally(() => {
				clearTimeout(timer);
				this.inflight.delete(stored);
			});
			this.inflight.set(stored, pending);
		}
		const minted = await untilAborted(pending, signal);
		this.cache.set(this.current(stored), minted);
		return minted;
	}

	/** The token to actually send for `storedCredential`. See {@link wireSession}. */
	protected async wireToken(storedCredential: string, signal: AbortSignal): Promise<string> {
		return (await this.wireSession(storedCredential, signal)).token;
	}

	/**
	 * Runs one request with a wire session, re-minting once if the backend answers 401.
	 *
	 * A token revoked or rotated server-side before its stated expiry otherwise stayed cached
	 * until then — half an hour of every request failing for Copilot. The retry is safe: a 401
	 * is a rejected request, raised before any of the reply was streamed.
	 */
	protected async withWireSession<T>(storedCredential: string, signal: AbortSignal, request: (session: WireSession) => Promise<T>): Promise<T> {
		const session = await this.wireSession(storedCredential, signal);
		try {
			return await request(session);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!/\bHTTP 401\b/.test(message)) {
				throw err;
			}
			const stored = this.current(storedCredential);
			if (this.cache.get(stored) === session) {
				this.cache.delete(stored);
			}
			return request(await this.wireSession(stored, signal));
		}
	}

	/** The newest stored credential `storedCredential` has been refreshed into. */
	private current(storedCredential: string): string {
		let stored = storedCredential;
		for (let next = this.successor.get(stored); next !== undefined && next !== stored; next = this.successor.get(stored)) {
			stored = next;
		}
		return stored;
	}

	/** Records a mint's refreshed credential, and saves it where the registry wired a persister. */
	private async adopt(stored: string, minted: WireSession): Promise<void> {
		const next = minted.updatedCredential;
		if (!next || next === stored) {
			return;
		}
		this.successor.set(stored, next);
		// Best-effort: failing to save must not fail the request the fresh token is for.
		await this.persist?.(stored, next).catch(() => { /* kept in memory for this session */ });
	}
}

/** `work`, or a cancellation as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new DOMException('Aborted', 'AbortError'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
		signal.addEventListener('abort', onAbort, { once: true });
		work.then(
			value => { signal.removeEventListener('abort', onAbort); resolve(value); },
			err => { signal.removeEventListener('abort', onAbort); reject(err); },
		);
	});
}
