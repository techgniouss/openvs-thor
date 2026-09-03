# OAuth-Proxy and Web-Cookie Provider Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Copilot, xAI Grok and AWS Kiro as chat providers by calling each vendor's internal client API directly (the same identity their own CLI/IDE clients use, not a documented public API), and add a Google-account "web cookie" provider that answers chat requests by replaying a signed-in Chrome profile's session against `gemini.google.com` instead of any API.

## ⚠️ Read this before touching any code in this plan

Every provider in this plan works by **impersonating another product's own client** rather than calling a documented, licensed API:

- **Copilot**: sends the exact headers (`copilot-integration-id: vscode-chat`, `editor-version`, …) the VS Code Copilot Chat extension sends, against GitHub's internal `copilot_internal/v2/token` exchange and `api.githubcopilot.com`. This is not the public Copilot API (there isn't one for chat) — it's GitHub's Copilot Chat *backend*, meant to be called only by GitHub's own client.
- **Grok**: sends the exact client-identity headers (`x-grok-client-version`, `X-XAI-Token-Auth: xai-grok-cli`, …) the Grok CLI sends, against `cli-chat-proxy.grok.com`, using the Grok CLI's own OAuth client id.
- **Kiro**: reads the token file AWS's own Kiro IDE/CLI already wrote to `~/.aws/sso/cache/`, and calls CodeWhisperer's internal `generateAssistantResponse` endpoint the way the Kiro desktop app does.
- **Web-cookie (`web_gemini`)**: decrypts a real, signed-in Chrome profile's cookies (via Windows DPAPI) and replays them as HTTP headers against `gemini.google.com`'s consumer chat UI — the same account a person uses in their browser, now also answering programmatic requests it was never designed to receive. The source project's own README says outright: *"cookie replay against a consumer chat UI is outside Google's terms... the session can be invalidated at any time."* `openvs-thor`'s own `antigravity.ts` (a prior instance of this exact pattern, already shipped) states the same thing about its own backend: *"Antigravity's ToS restricts this credential to Google's own client, and Google has banned accounts for proxying it through third-party tools... this is not the sanctioned path."*

**What this means concretely, for every provider in this plan:**
- The account behind the credential (a personal GitHub/xAI/AWS/Google account) can be rate-limited, suspended, or banned at the vendor's sole discretion, with no appeal path framed around "I was using a third-party tool."
- The endpoints, headers, and client ids are all unversioned implementation details of someone else's product. A version bump on their end (a new required header, a rotated client id, a deprecated endpoint) breaks the provider with no warning and no changelog to consult — this already happened once in the source project (Google's Gemini CLI OAuth was fully sunset 2026-06-18, requiring a rewrite to Antigravity's identity instead).
- Grok's and Kiro's implementations in the source project are themselves marked **"UNVERIFIED END-TO-END"** — written from a reference client's source code, never run against a live account. Treat the first real call during this plan's execution as the actual test, same as the source project does.

This plan proceeds because the user explicitly asked for all of it, informed of the above (confirmed in chat 2026-09-03, following the same precedent `antigravity.ts` already documents in this codebase: *"Only wired up because the user asked for it explicitly... this is not the sanctioned path"*). **Every new provider file created by this plan must carry a doc comment stating this plainly**, in `antigravity.ts`'s own words where they apply, so a future reader of the code — not just of this plan — sees the same warning.

**Architecture:** Two new pieces of plumbing are needed that Phase 1's plan didn't require: (1) a **device-flow authentication mechanism** (RFC 8628 — show the user a code and a URL, poll a token endpoint until they approve it in a browser), shared by Copilot and Grok, surfaced as a new kind of "Sign in" flow alongside the existing redirect-URI OAuth in `oauth.ts`; and (2) a **two-stage token mint** for Copilot specifically (the stored credential is a long-lived GitHub token; what's actually sent per-request is a short-lived Copilot token exchanged from it, cached ~30 minutes). Kiro skips both — it imports an already-refreshed token file Kiro's own client wrote, and only needs a refresh-on-expiry hook, which fits the existing `OAuthTokenStore.getFreshAccessToken` shape with a per-provider refresh function (same as `refreshAnthropic`/`refreshOpenAI`/`refreshAntigravity` already do). The web-cookie provider is architecturally unrelated to the other three (no OAuth at all — a decrypted browser cookie jar) and is scoped as its own phase.

**Tech Stack:** TypeScript, VS Code `SecretStorage`, Node's `crypto` module (for the web-cookie provider's AES-GCM decryption — see Phase 4's platform note), the existing `apiFetch`/`OAuthTokenStore` machinery.

**Spec:** No separate spec document — derived from a source analysis of `AutomationScripts/ai/providers/copilot.py`, `grok.py`, `kiro.py`, and `providers/web_cookie_providers/` (a Python batch-dispatcher project) conducted in chat on 2026-09-03, cross-referenced against `extensions/openvs-chat/src/providers/antigravity.ts` and `src/oauth.ts` as the existing precedent for this exact category of integration. Read `2026-09-03-provider-resilience-and-free-additions.md`'s "Design rationale" section first — that plan should land before this one, since every provider this plan adds benefits from `withProviderResilience` at its call sites for free once it exists.

## Global Constraints

- Same coding guidelines as the companion plan: tabs, PascalCase types, JSDoc on exports, `async`/`await`, no `any`, copyright header on every new file.
- **Every provider's `ProviderInfo` doc comment must name the ToS risk plainly**, following `antigravity.ts`'s wording. Do not soften this to generic "unofficial API" language — say whose terms it violates and what the consequence is (account action), the way `antigravity.ts` already does.
- These four providers are **opt-in and off by default** in every user-facing sense that already exists for `antigravity`: `NOT_AUTO_INFERRED` in `auto/router.ts` (`router.ts:68`) already excludes `antigravity` from being picked *for* the user by Auto mode — add `copilot`, `grok`, `kiro`, and the web-cookie provider's id to that same set. A user who wants one must pin it explicitly per role or select it directly in the chat picker; Auto mode must never select one of these on its own.
- The granularity in this plan is coarser than the companion resilience plan: full bite-sized TDD steps are given where the logic is pure and testable offline (the device-flow state machine, the token-mint caching, the Kiro response-shape extractor). Live-network pieces (the actual OAuth exchange, the actual chat call) are specified with every real endpoint/header/constant needed, but are correctness-critical against a service this plan's author has not called — verify each one against a real account before considering its task done, exactly as the source project's own "UNVERIFIED END-TO-END" notes demand.

---

## Phase 3: Device-flow OAuth proxies — Copilot, Grok, Kiro

### File Structure

- Create: `extensions/openvs-chat/src/deviceAuth.ts` — the shared RFC 8628 device-flow client: request a device code, show it to the user, poll for approval. Used by Copilot and Grok.
- Create: `extensions/openvs-chat/src/providers/oauthProxy.ts` — a small `OAuthProxyChatProvider` abstract base analogous to the source project's `_oauth_compat.OAuthChatProvider`: holds a per-instance short-lived-token cache, and calls a subclass-supplied `mintToken()` when the cache is empty or within 5 minutes of expiry. `AntigravityProvider` does NOT use this (it mints nothing — Antigravity's access token from `OAuthTokenStore.getFreshAccessToken` is already the thing sent on the wire); this base class exists specifically for the two-stage case Copilot needs and Grok/Kiro can trivially satisfy too (a one-stage mint is just a mint that returns the token unchanged until it's near expiry).
- Create: `extensions/openvs-chat/src/providers/copilot.ts`
- Create: `extensions/openvs-chat/src/providers/grok.ts`
- Create: `extensions/openvs-chat/src/providers/kiro.ts`
- Modify: `extensions/openvs-chat/src/oauth.ts` — add `copilot`/`grok`/`kiro` credential kinds (device-flow-obtained tokens, stored the same way `StoredOAuth` already stores redirect-flow tokens) and their refresh functions.
- Modify: `extensions/openvs-chat/src/extension.ts` — register three new commands (`openvsChat.copilotSignIn`, `openvsChat.grokSignIn`, `openvsChat.kiroImportCredential`) alongside the existing sign-in command pattern (search for how the existing web sign-in command is registered).
- Modify: `extensions/openvs-chat/src/providers/registry.ts` — register the three new providers; add `copilot`, `grok`, `kiro` to `NO_BASE_URL_SETTING` (`registry.ts:49`) since all three call a fixed, non-configurable endpoint the way `antigravity` does.
- Modify: `extensions/openvs-chat/src/auto/router.ts` — add `copilot`, `grok`, `kiro` to `NOT_AUTO_INFERRED` (`router.ts:68`).
- Modify: `extensions/openvs-chat/media/main.js` / `media/prompts.js` — a device-flow "Sign in" button needs different UI than the existing redirect-URI one (it must show a code and a "Continue in browser" link, then a pending/polling state, not just open a URL and wait for a callback). Model this on how the existing "Sign in with web" button and its pending state are implemented for Claude/ChatGPT/OpenRouter — read that flow fully before designing the device-flow variant so the two don't diverge in avoidable ways (e.g. both should show the same kind of cancel affordance).
- Test: `extensions/openvs-chat/scripts/test-device-auth.mjs` — pure state-machine tests (no real network) for `deviceAuth.ts`'s polling logic: `authorization_pending` keeps polling, `slow_down` backs off, `expired_token`/`access_denied` fail cleanly, success returns the token.
- Test: `extensions/openvs-chat/scripts/test-oauth-proxy.mjs` — pure tests for `OAuthProxyChatProvider`'s token cache: mint on first use, reuse while fresh, re-mint within the expiry window, one mint call per concurrent burst (not one per request).
- Test: `extensions/openvs-chat/scripts/test-kiro-extract.mjs` — pure tests for the CodeWhisperer response-shape extractor (the one piece of Kiro's integration that's pure string/JSON parsing, ported faithfully from `providers/kiro.py`'s `extract_codewhisperer`).

### Interfaces

- Produces (Task 14): `deviceAuth.ts`:
  ```ts
  export interface DeviceCodeResponse {
  	readonly deviceCode: string;
  	readonly userCode: string;
  	readonly verificationUri: string;
  	readonly expiresInSeconds: number;
  	readonly intervalSeconds: number;
  }
  export interface DeviceFlowConfig {
  	readonly deviceCodeUrl: string;
  	readonly tokenUrl: string;
  	readonly clientId: string;
  	readonly scope: string;
  	/** Extra body fields the token poll needs beyond `client_id`/`grant_type`/`device_code`
  	 * (Grok's endpoint needs none beyond the RFC defaults; declared for forward-fitting). */
  	readonly extraTokenParams?: Record<string, string>;
  }
  export interface DeviceTokenResult {
  	readonly accessToken: string;
  	readonly refreshToken?: string;
  	readonly expiresAt: number; // epoch ms
  }
  export function requestDeviceCode(config: DeviceFlowConfig, signal: AbortSignal): Promise<DeviceCodeResponse>;
  /** Polls until approved, denied, or expired. `onTick` fires once per poll so a caller can
   * update a "waiting for you to approve in the browser…" UI; throws on denial/expiry/timeout. */
  export function pollDeviceToken(
  	config: DeviceFlowConfig, device: DeviceCodeResponse, signal: AbortSignal, onTick?: () => void,
  ): Promise<DeviceTokenResult>;
  ```
- Produces (Task 15): `providers/oauthProxy.ts`:
  ```ts
  export abstract class OAuthProxyChatProvider extends OpenAICompatibleProvider {
  	/** Exchanges the stored long-lived credential for the token actually sent on the wire.
  	 * For a one-stage provider (Grok, Kiro) this just validates/refreshes; for Copilot it
  	 * performs the GitHub-token -> Copilot-token exchange. */
  	protected abstract mintToken(storedCredential: string, signal: AbortSignal): Promise<{ token: string; expiresAt: number }>;
  	/** Resolves the wire token for `storedCredential`, minting fresh only when the cache is
  	 * empty or within 5 minutes of expiry. Keyed by `storedCredential` so pooled/rotated
  	 * credentials (via Phase 1's key rotation) never share a cached mint. */
  	protected async wireToken(storedCredential: string, signal: AbortSignal): Promise<string>;
  }
  ```
- Produces (Task 18): `extract_codewhisperer`-equivalent `extractCodeWhispererText(body: unknown): string` in `providers/kiro.ts`, exported for the test file.
- Consumes: `withProviderResilience` from the companion plan's Task 4 (all three providers' call sites should be wrapped the same way once registered — see Task 19).

---

### Task 14: Device-flow authentication client

**Files:**
- Create: `extensions/openvs-chat/src/deviceAuth.ts`
- Test: `extensions/openvs-chat/scripts/test-device-auth.mjs`

**Interfaces:** Produces `requestDeviceCode`, `pollDeviceToken`, `DeviceFlowConfig`, `DeviceCodeResponse`, `DeviceTokenResult` (see above).

- [ ] **Step 1: Write the failing test for the polling state machine**

```js
// extensions/openvs-chat/scripts/test-device-auth.mjs
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/deviceAuth.ts's polling state machine. Stubs `fetch` globally
// so no real network call happens. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-device-auth.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/deviceAuth.js', import.meta.url));

const CONFIG = {
	deviceCodeUrl: 'https://example.test/device/code',
	tokenUrl: 'https://example.test/token',
	clientId: 'client-123',
	scope: 'offline_access',
};

const DEVICE = {
	deviceCode: 'dc-1',
	userCode: 'ABCD-1234',
	verificationUri: 'https://example.test/activate',
	expiresInSeconds: 900,
	intervalSeconds: 0, // 0 so the test doesn't actually wait between polls
};

function fakeFetch(responses) {
	let i = 0;
	return async () => {
		const r = responses[Math.min(i, responses.length - 1)];
		i++;
		return { ok: r.status === 200, status: r.status, json: async () => r.body };
	};
}

// authorization_pending keeps polling; the next response succeeds.
{
	globalThis.fetch = fakeFetch([
		{ status: 400, body: { error: 'authorization_pending' } },
		{ status: 400, body: { error: 'authorization_pending' } },
		{ status: 200, body: { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600 } },
	]);
	const controller = new AbortController();
	const before = Date.now();
	const result = await m.pollDeviceToken(CONFIG, DEVICE, controller.signal);
	assert.equal(result.accessToken, 'tok-1');
	assert.equal(result.refreshToken, 'ref-1');
	assert.ok(result.expiresAt > before);
}

// access_denied fails immediately without exhausting further polls.
{
	let calls = 0;
	globalThis.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: 'access_denied' }) }; };
	const controller = new AbortController();
	await assert.rejects(() => m.pollDeviceToken(CONFIG, DEVICE, controller.signal), /denied/i);
	assert.equal(calls, 1, 'denial must not be retried');
}

// expired_token fails cleanly.
{
	globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'expired_token' }) });
	const controller = new AbortController();
	await assert.rejects(() => m.pollDeviceToken(CONFIG, DEVICE, controller.signal), /expired/i);
}

// slow_down is treated like authorization_pending (keep polling) rather than a failure.
{
	globalThis.fetch = fakeFetch([
		{ status: 400, body: { error: 'slow_down' } },
		{ status: 200, body: { access_token: 'tok-2', expires_in: 3600 } },
	]);
	const controller = new AbortController();
	const result = await m.pollDeviceToken(CONFIG, DEVICE, controller.signal);
	assert.equal(result.accessToken, 'tok-2');
}

// Aborting the signal stops polling and rejects with an AbortError, not a generic failure.
{
	globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) });
	const controller = new AbortController();
	const pending = m.pollDeviceToken(CONFIG, DEVICE, controller.signal);
	controller.abort();
	await assert.rejects(() => pending, err => err.name === 'AbortError');
}

// onTick fires once per poll attempt.
{
	let ticks = 0;
	globalThis.fetch = fakeFetch([
		{ status: 400, body: { error: 'authorization_pending' } },
		{ status: 200, body: { access_token: 'tok-3', expires_in: 3600 } },
	]);
	const controller = new AbortController();
	await m.pollDeviceToken(CONFIG, DEVICE, controller.signal, () => { ticks++; });
	assert.equal(ticks, 2);
}

console.log('All device-auth assertions passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/openvs-chat/scripts/test-device-auth.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * RFC 8628 (OAuth 2.0 Device Authorization Grant) client, shared by the Copilot and Grok
 * sign-in flows in `providers/copilot.ts` / `providers/grok.ts`. Unlike this extension's
 * existing redirect-URI OAuth (`oauth.ts`), a device flow has no callback URL: the user is
 * shown a short code and a URL, approves it in any browser (not necessarily the one VS Code
 * would open), and this polls a token endpoint until that approval lands.
 */

export interface DeviceCodeResponse {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly verificationUri: string;
	readonly expiresInSeconds: number;
	readonly intervalSeconds: number;
}

export interface DeviceFlowConfig {
	readonly deviceCodeUrl: string;
	readonly tokenUrl: string;
	readonly clientId: string;
	readonly scope: string;
	readonly extraTokenParams?: Record<string, string>;
}

export interface DeviceTokenResult {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt: number;
}

/** Starts a device flow: asks the provider for a code + verification URL to show the user. */
export async function requestDeviceCode(config: DeviceFlowConfig, signal: AbortSignal): Promise<DeviceCodeResponse> {
	const response = await fetch(config.deviceCodeUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
		body: new URLSearchParams({ client_id: config.clientId, scope: config.scope }).toString(),
		signal,
	});
	if (!response.ok) {
		throw new Error(`device code request failed: HTTP ${response.status}`);
	}
	const json = await response.json() as Record<string, unknown>;
	const deviceCode = json.device_code;
	const userCode = json.user_code;
	const verificationUri = json.verification_uri ?? json.verification_url;
	if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
		throw new Error('device code response missing device_code/user_code/verification_uri');
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		expiresInSeconds: Number(json.expires_in) || 900,
		intervalSeconds: Number(json.interval) || 5,
	};
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/**
 * Polls `config.tokenUrl` every `device.intervalSeconds` (backing off further on
 * `slow_down`, per RFC 8628 §3.5) until the user approves the code, denies it, or it
 * expires. Never retried past `access_denied`/`expired_token`/`expired_grant` — those are
 * terminal, unlike `authorization_pending`/`slow_down`.
 */
export async function pollDeviceToken(
	config: DeviceFlowConfig,
	device: DeviceCodeResponse,
	signal: AbortSignal,
	onTick?: () => void,
): Promise<DeviceTokenResult> {
	let intervalMs = Math.max(1, device.intervalSeconds) * 1000;
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	for (; ;) {
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		if (Date.now() > deadline) {
			throw new Error('device code expired before it was approved');
		}
		onTick?.();
		const response = await fetch(config.tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
			body: new URLSearchParams({
				client_id: config.clientId,
				device_code: device.deviceCode,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				...(config.extraTokenParams ?? {}),
			}).toString(),
			signal,
		});
		const json = await response.json().catch(() => ({})) as Record<string, unknown>;
		if (response.ok && typeof json.access_token === 'string') {
			return {
				accessToken: json.access_token,
				refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
				expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
			};
		}
		const error = typeof json.error === 'string' ? json.error : '';
		if (error === 'access_denied') {
			throw new Error('sign-in was denied in the browser');
		}
		if (error === 'expired_token' || error === 'expired_grant') {
			throw new Error('device code expired before it was approved');
		}
		if (error === 'slow_down') {
			intervalMs += 5000;
		}
		// authorization_pending, slow_down, or an unrecognized transient error: keep polling.
		await sleep(intervalMs, signal);
	}
}
```

- [ ] **Step 4: Compile and run the test**

Run:
```bash
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-device-auth.mjs
```
Expected: `All device-auth assertions passed.`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/deviceAuth.ts extensions/openvs-chat/scripts/test-device-auth.mjs
git commit -m "feat(openvs-chat): add RFC 8628 device-flow OAuth client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 15: `OAuthProxyChatProvider` — the two-stage token mint cache

**Files:**
- Create: `extensions/openvs-chat/src/providers/oauthProxy.ts`
- Test: `extensions/openvs-chat/scripts/test-oauth-proxy.mjs`

**Interfaces:** Produces `OAuthProxyChatProvider` (see above). Consumes `OpenAICompatibleProvider` (existing).

- [ ] **Step 1: Write the failing test**

```js
// extensions/openvs-chat/scripts/test-oauth-proxy.mjs
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/oauthProxy.ts's token-mint cache. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-oauth-proxy.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/oauthProxy.js', import.meta.url));

class FakeProxy extends m.OAuthProxyChatProvider {
	constructor() {
		super();
		this.mintCalls = 0;
	}
	get info() { return { id: 'fake', label: 'Fake', suggestedModels: ['m'], apiKeyUrl: '', requiresApiKey: true, supportsTools: false, toolModelPatterns: [], visionModelPatterns: [] }; }
	async mintToken(storedCredential, _signal) {
		this.mintCalls++;
		return { token: `wire-${storedCredential}-${this.mintCalls}`, expiresAt: Date.now() + 30 * 60_000 };
	}
	// Exposed for the test; production subclasses never need to call this directly.
	testWireToken(cred, signal) { return this.wireToken(cred, signal); }
}

// First call mints. A second call with the same stored credential, while still fresh,
// reuses the cached token instead of minting again.
{
	const p = new FakeProxy();
	const t1 = await p.testWireToken('cred-a', new AbortController().signal);
	const t2 = await p.testWireToken('cred-a', new AbortController().signal);
	assert.equal(t1, t2);
	assert.equal(p.mintCalls, 1);
}

// A different stored credential (e.g. after key rotation to a second pooled account)
// gets its own cache entry and its own mint.
{
	const p = new FakeProxy();
	const t1 = await p.testWireToken('cred-a', new AbortController().signal);
	const t2 = await p.testWireToken('cred-b', new AbortController().signal);
	assert.notEqual(t1, t2);
	assert.equal(p.mintCalls, 2);
}

// A concurrent burst of calls for the same credential before the first mint resolves
// must share ONE in-flight mint, not fire one per call.
{
	class SlowProxy extends m.OAuthProxyChatProvider {
		constructor() { super(); this.mintCalls = 0; }
		get info() { return { id: 'slow', label: 'Slow', suggestedModels: ['m'], apiKeyUrl: '', requiresApiKey: true, supportsTools: false, toolModelPatterns: [], visionModelPatterns: [] }; }
		async mintToken(cred) {
			this.mintCalls++;
			await new Promise(r => setTimeout(r, 20));
			return { token: `wire-${cred}`, expiresAt: Date.now() + 30 * 60_000 };
		}
		testWireToken(cred, signal) { return this.wireToken(cred, signal); }
	}
	const p = new SlowProxy();
	const signal = new AbortController().signal;
	const [a, b, c] = await Promise.all([p.testWireToken('x', signal), p.testWireToken('x', signal), p.testWireToken('x', signal)]);
	assert.equal(a, b);
	assert.equal(b, c);
	assert.equal(p.mintCalls, 1, 'concurrent calls for the same credential share one mint');
}

console.log('All oauth-proxy assertions passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/openvs-chat/scripts/test-oauth-proxy.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
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
 * `refresh_in` margin in the source project. */
const MINT_MARGIN_MS = 5 * 60_000;

/**
 * Base for a provider whose STORED credential is not the token sent on the wire — e.g.
 * Copilot, where the stored value is a long-lived GitHub OAuth token and the wire value is a
 * short-lived Copilot token exchanged from it (`~30min`). Minting once per request would
 * double the latency of every call, so the exchanged token is cached per stored credential
 * and only re-minted when missing or within {@link MINT_MARGIN_MS} of its stated expiry.
 *
 * A provider with only ONE stage (Grok, Kiro: the stored credential IS an access/refresh
 * token pair, just one that needs periodic refreshing) still fits this shape — `mintToken`
 * simply validates the current token and refreshes when it's near expiry, returning it
 * unchanged otherwise.
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
```

- [ ] **Step 4: Compile and run the test**

Run:
```bash
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-oauth-proxy.mjs
```
Expected: `All oauth-proxy assertions passed.`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/providers/oauthProxy.ts extensions/openvs-chat/scripts/test-oauth-proxy.mjs
git commit -m "feat(openvs-chat): add OAuthProxyChatProvider two-stage token mint cache

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 16: `CopilotProvider`

**Files:**
- Create: `extensions/openvs-chat/src/providers/copilot.ts`
- Modify: `extensions/openvs-chat/src/oauth.ts` — add a `copilot` credential kind stored via the device flow (Task 14), not the redirect-URI flow the existing `StoredOAuth['type']` union (`oauth.ts:77`) is built around; read `oauth.ts:209-260` (`OAuthTokenStore` class) fully before deciding whether `copilot`/`grok` fit as a fourth/fifth member of that same union with a device-flow-specific `getFreshAccessToken` branch, or need a small parallel store — prefer extending the existing union if `StoredOAuth`'s shape (whatever fields it holds beyond `type`) doesn't assume a redirect-URI-obtained token in a way that would be misleading for a device-flow one.
- Modify: `extensions/openvs-chat/src/extension.ts` — register `openvsChat.copilotSignIn`, invoking `requestDeviceCode` + `pollDeviceToken` against the constants below and showing the user code via `vscode.window.showInformationMessage` with a "Copy code & open browser" action (open `verificationUri` via `vscode.env.openExternal`).
- Modify: `extensions/openvs-chat/src/providers/registry.ts` — register `new CopilotProvider()`; add `'copilot'` to `NO_BASE_URL_SETTING`.

**Interfaces:** Consumes `deviceAuth.ts` (Task 14), `OAuthProxyChatProvider` (Task 15).

- [ ] **Step 1: Write the provider**

All constants below are transcribed verbatim from `AutomationScripts/ai/providers/copilot.py` (read in this plan's research) — cross-checked there against `ericc-ch/copilot-api`, a public reference implementation. Do not alter them without re-verifying against a live account, since a wrong header value here does not fail loudly with a helpful message — it 403s.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OAuthProxyChatProvider } from './oauthProxy';
import { ChatRequest, ModelEntry, ProviderInfo, apiFetch, describeHttpError } from './types';

/**
 * Provider for GitHub Copilot Chat's backend, called directly the way the VS Code Copilot
 * Chat extension itself does — NOT a documented public Copilot API (there isn't one for
 * chat completions). The stored credential is a GitHub OAuth device-flow token; each request
 * exchanges it for a short-lived Copilot token via `GET copilot_internal/v2/token` (cached
 * ~25 minutes by {@link OAuthProxyChatProvider}) and sends that instead.
 *
 * ⚠️ This impersonates the VS Code Copilot Chat client's identity rather than calling a
 * licensed integration surface. GitHub can rate-limit, suspend, or ban the Copilot account
 * behind this credential at their sole discretion, and every constant below (client id,
 * endpoint, header set) is an unversioned implementation detail that can change without
 * notice. Only added because the user asked for it explicitly, aware of this — see
 * `docs/superpowers/plans/2026-09-03-provider-oauth-and-cookie-integrations.md`. This is not
 * the sanctioned path; there is none for third-party Copilot Chat access.
 *
 * Copilot **Free** allows roughly 50 chat requests/month; **Pro** removes the cap on the base
 * model. On a lapsed/free account, expect 401/403 rather than a working stream.
 */
export class CopilotProvider extends OAuthProxyChatProvider {
	readonly info: ProviderInfo = {
		id: 'copilot',
		label: 'GitHub Copilot',
		suggestedModels: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
		apiKeyUrl: 'https://github.com/settings/copilot',
		requiresApiKey: true,
		supportsTools: true,
		toolModelPatterns: [],
		visionModelPatterns: ['gpt-4o', 'gpt-4\\.1'],
	};

	private static readonly COPILOT_VERSION = '0.26.7';
	private static readonly VSCODE_VERSION = '1.98.0';
	private static readonly API_VERSION = '2025-04-01';
	private static readonly USER_AGENT = `GitHubCopilotChat/${CopilotProvider.COPILOT_VERSION}`;
	private static readonly EDITOR_PLUGIN_VERSION = `copilot-chat/${CopilotProvider.COPILOT_VERSION}`;

	/** Host the last successful token mint said to use — an individual account is issued
	 * `api.individual.githubcopilot.com`, not the bare `api.githubcopilot.com` some
	 * community proxies hardcode. Falls back to the bare host before the first mint. */
	private lastApiHost = 'https://api.githubcopilot.com';

	protected async mintToken(githubToken: string, signal: AbortSignal): Promise<{ token: string; expiresAt: number }> {
		const response = await apiFetch('https://api.github.com/copilot_internal/v2/token', {
			method: 'GET',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json',
				'authorization': `token ${githubToken}`, // NOTE: "token", not "Bearer" — this endpoint rejects Bearer.
				'editor-version': `vscode/${CopilotProvider.VSCODE_VERSION}`,
				'editor-plugin-version': CopilotProvider.EDITOR_PLUGIN_VERSION,
				'user-agent': CopilotProvider.USER_AGENT,
				'x-github-api-version': CopilotProvider.API_VERSION,
				'x-vscode-user-agent-library-version': 'electron-fetch',
			},
		}, signal, { timeoutMs: 15_000, retries: 0 });
		if (!response.ok) {
			throw new Error(await describeHttpError('GitHub Copilot', response));
		}
		const body = await response.json() as { token?: string; expires_at?: number; chat_enabled?: boolean; endpoints?: { api?: string } };
		if (body.chat_enabled === false) {
			throw new Error('GitHub Copilot: this account has chat_enabled=false — Copilot Chat is not available on it.');
		}
		if (!body.token) {
			throw new Error('GitHub Copilot: token exchange returned no token.');
		}
		if (body.endpoints?.api) {
			this.lastApiHost = body.endpoints.api.replace(/\/+$/, '');
		}
		return { token: body.token, expiresAt: (body.expires_at ?? 0) * 1000 };
	}

	private authHeaders(token: string): Record<string, string> {
		return {
			'Authorization': `Bearer ${token}`,
			'copilot-integration-id': 'vscode-chat',
			'editor-version': `vscode/${CopilotProvider.VSCODE_VERSION}`,
			'editor-plugin-version': CopilotProvider.EDITOR_PLUGIN_VERSION,
			'user-agent': CopilotProvider.USER_AGENT,
			'openai-intent': 'conversation-panel',
			'x-github-api-version': CopilotProvider.API_VERSION,
			'x-request-id': crypto.randomUUID(),
			'x-vscode-user-agent-library-version': 'electron-fetch',
		};
	}

	// `streamChat`/`runAgentStep`/`listModels` are inherited from OpenAICompatibleProvider,
	// which builds its own auth headers via `authHeaders(apiKey)` and posts to
	// `${baseUrl}/chat/completions`. Both need overriding here because (a) the token in
	// `request.apiKey` is the STORED GitHub token, not the wire token, and (b) the wire
	// header set is Copilot-specific, not a plain Bearer. Override the two entry points
	// `OpenAICompatibleProvider` exposes for exactly this — `authHeaders` and the base URL —
	// rather than re-implementing streamChat/runAgentStep.
	protected override authHeaders(apiKey: string): Record<string, string> {
		// NOTE: OpenAICompatibleProvider.streamChat calls this synchronously and cannot await
		// the async mint — see Step 2 below for why this method's contract has to change, or
		// why streamChat/runAgentStep must be overridden here instead. Resolve this before
		// writing the final version; do not ship a version that ignores the async mint.
		return { 'Content-Type': 'application/json' };
	}
}
```

- [ ] **Step 2: Resolve the sync/async header mismatch before proceeding**

`OpenAICompatibleProvider.authHeaders(apiKey: string): Record<string, string>` (`openaiCompatible.ts:142`) is **synchronous** and is called inline while building the request in `streamChat`/`runAgentStep`/`listModels`/`completeFim`. `wireToken` (Task 15) is **async** (the mint is a network call). These two facts conflict, and the stub in Step 1 papers over it — it must not ship as-is. Pick one real fix before writing tests for this provider:

  - **(a)** Override `streamChat`, `runAgentStep`, and `listModels` in `CopilotProvider` directly instead of `authHeaders` — each becomes `const token = await this.wireToken(request.apiKey, request.signal); return super.streamChat({ ...request, apiKey: token });` (delegating to the base class's already-correct streaming/parsing logic, just substituting the minted token first). This is the smaller, more contained change and does not touch the shared base class's synchronous contract at all — **prefer this.**
  - **(b)** Change `OpenAICompatibleProvider.authHeaders` to `async`, threading `await` through every call site in the base class. Rejected: it penalizes every other provider (a synchronous header build becoming async ripples through `streamChat`'s otherwise-synchronous request-building code for zero benefit to them) to serve one subclass's need.

Rewrite `CopilotProvider` using approach (a): remove the `authHeaders` override entirely, and instead override `streamChat`/`runAgentStep`/`listModels` to resolve the wire token first, then delegate:

```ts
override async streamChat(request: ChatRequest) {
	const token = await this.wireToken(request.apiKey, request.signal);
	return super.streamChat({ ...request, apiKey: token, baseUrl: this.lastApiHost });
}
```
(and the analogous overrides for `runAgentStep`/`listModels`), and instead override the base class's `protected authHeaders(apiKey: string)` — now receiving the already-minted wire token, not the stored GitHub token — to return the Copilot header set from Step 1's `authHeaders` method body.

- [ ] **Step 3: Register the provider and its sign-in command**

In `registry.ts`: import and add `new CopilotProvider()` to the constructor array; add `'copilot'` to `NO_BASE_URL_SETTING`.

In `oauth.ts`: read `StoredOAuth`'s full shape (`oauth.ts:77` onward) and `OAuthTokenStore`'s `getFreshAccessToken` (`oauth.ts:245`) before adding `'copilot'` as a fourth type — for Copilot, "refreshing" the stored credential doesn't apply the way it does for `anthropic`/`openai`/`antigravity` (the GitHub device-flow token this stores is long-lived and not refreshed via a `refresh_token` grant the way those three are); confirm whether `getFreshAccessToken` should simply return the stored GitHub token unchanged for `copilot` (since the actual short-lived exchange is `CopilotProvider.mintToken`'s job, not `OAuthTokenStore`'s) rather than forcing Copilot through a refresh path built for a different credential shape.

In `extension.ts`: register `openvsChat.copilotSignIn` using `requestDeviceCode`/`pollDeviceToken` against:
```ts
const COPILOT_DEVICE_FLOW = {
	deviceCodeUrl: 'https://github.com/login/device/code',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	clientId: 'Iv1.b507a08c87ecfe98',
	scope: 'read:user',
};
```
On success, store the returned `accessToken` via `registry.setApiKey('copilot', accessToken)` (Copilot has no separate refresh token to persist — the GitHub device-flow token itself is the long-lived credential).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --prefix extensions/openvs-chat`
Expected: no errors.

- [ ] **Step 5: Manual verification against a real GitHub Copilot account**

Run the sign-in command, approve the device code in a browser, send a chat message with `gpt-4.1`. This is the actual test — nothing in Steps 1-4 proves the header set or the token exchange are correct against GitHub's live backend, only that the code compiles and the state machine is internally consistent.

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/providers/copilot.ts extensions/openvs-chat/src/oauth.ts extensions/openvs-chat/src/extension.ts extensions/openvs-chat/src/providers/registry.ts
git commit -m "feat(openvs-chat): add GitHub Copilot Chat provider via device-flow OAuth

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 17: `GrokProvider`

**Files:**
- Create: `extensions/openvs-chat/src/providers/grok.ts`
- Modify: `extensions/openvs-chat/src/oauth.ts`, `extensions/openvs-chat/src/extension.ts`, `extensions/openvs-chat/src/providers/registry.ts` — same shape as Task 16 Step 3.

**Interfaces:** Consumes `deviceAuth.ts`, `OAuthProxyChatProvider` — same pattern as `CopilotProvider`, one stage simpler (no separate token-exchange endpoint; `mintToken` just refreshes the OAuth token when it's near expiry).

- [ ] **Step 1: Write the provider**

All constants transcribed verbatim from `AutomationScripts/ai/providers/grok.py` (read in this plan's research), which itself sourced them from `router-for-me/CLIProxyAPI` (`internal/auth/xai/types.go`, `internal/runtime/executor/xai_executor.go`) — a public MIT-licensed reference implementing the same identity. **The scope string is not optional** — the source project documents that omitting `grok-cli:access`/`offline_access` produces three separate, confusing-looking failures (403 on the inference endpoint, 403 on the fallback API, and no refresh token issued at all), each of which looks like an account problem but is actually this.

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OAuthProxyChatProvider } from './oauthProxy';
import { ChatRequest, ProviderInfo } from './types';

/**
 * Provider for xAI Grok via the Grok CLI's own OAuth identity, calling
 * `cli-chat-proxy.grok.com` directly rather than the public `api.x.ai` surface — NOT a
 * documented public Grok API integration.
 *
 * ⚠️ This impersonates the Grok CLI's client identity (client id, required
 * `x-grok-client-*` headers) rather than calling a licensed integration surface. xAI can
 * rate-limit, suspend, or ban the account behind this credential at their sole discretion.
 * **Unverified end-to-end** — transcribed from a public reference implementation
 * (`router-for-me/CLIProxyAPI`), never run against a live xAI account before this plan's
 * Task 17 Step 5. Only added because the user asked for it explicitly, aware of this — see
 * `docs/superpowers/plans/2026-09-03-provider-oauth-and-cookie-integrations.md`.
 *
 * Serves exactly ONE model (`grok-4.6`) — `cli-chat-proxy.grok.com`'s catalog is not the
 * full public xAI model line.
 */
export class GrokProvider extends OAuthProxyChatProvider {
	readonly info: ProviderInfo = {
		id: 'grok',
		label: 'xAI Grok (CLI identity)',
		suggestedModels: ['grok-4.6'],
		apiKeyUrl: 'https://x.ai',
		requiresApiKey: true,
		supportsTools: false, // unverified — cli-chat-proxy's tool-calling support is not confirmed
		toolModelPatterns: [],
		visionModelPatterns: [],
	};

	static readonly CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
	static readonly ISSUER = 'https://auth.x.ai';
	static readonly SCOPE = 'openid profile email offline_access grok-cli:access api:access';
	private static readonly CLIENT_VERSION = '0.2.120';

	private authHeaders(token: string): Record<string, string> {
		return {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/json',
			'Connection': 'Keep-Alive',
			'X-XAI-Token-Auth': 'xai-grok-cli',
			'x-grok-client-version': GrokProvider.CLIENT_VERSION,
			'x-grok-client-identifier': 'grok-shell',
			'x-authenticateresponse': 'authenticate-response',
			'User-Agent': `xai-grok-workspace/${GrokProvider.CLIENT_VERSION}`,
		};
	}

	/** `storedCredential` here is `${accessToken}|${refreshToken}|${expiresAtMs}` — see
	 * Task 17 Step 2 for why the stored value has to carry all three, not just the access
	 * token, unlike Copilot's single-token credential. */
	protected async mintToken(storedCredential: string, signal: AbortSignal): Promise<{ token: string; expiresAt: number }> {
		const [accessToken, refreshToken, expiresAtRaw] = storedCredential.split('|');
		const expiresAt = Number(expiresAtRaw) || 0;
		if (accessToken && expiresAt - Date.now() > 5 * 60_000) {
			return { token: accessToken, expiresAt };
		}
		if (!refreshToken) {
			throw new Error('xAI Grok: credential has no refresh_token — sign in again.');
		}
		const tokenEndpoint = await this.discoverTokenEndpoint(signal);
		const response = await fetch(tokenEndpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: GrokProvider.CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
			signal,
		});
		if (!response.ok) {
			throw new Error(`xAI Grok: token refresh HTTP ${response.status}`);
		}
		const body = await response.json() as { access_token?: string; expires_in?: number };
		if (!body.access_token) {
			throw new Error('xAI Grok: token refresh returned no access_token.');
		}
		return { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
	}

	private cachedTokenEndpoint = '';
	private async discoverTokenEndpoint(signal: AbortSignal): Promise<string> {
		if (this.cachedTokenEndpoint) {
			return this.cachedTokenEndpoint;
		}
		const response = await fetch(`${GrokProvider.ISSUER}/.well-known/openid-configuration`, { signal });
		if (!response.ok) {
			throw new Error(`xAI Grok: OIDC discovery HTTP ${response.status}`);
		}
		const doc = await response.json() as { token_endpoint?: string };
		if (!doc.token_endpoint) {
			throw new Error('xAI Grok: OIDC discovery did not return a token_endpoint.');
		}
		this.cachedTokenEndpoint = doc.token_endpoint;
		return this.cachedTokenEndpoint;
	}

	override async streamChat(request: ChatRequest) {
		const token = await this.wireToken(request.apiKey, request.signal);
		return super.streamChat({ ...request, apiKey: token, baseUrl: 'https://cli-chat-proxy.grok.com/v1' });
	}

	protected override authHeaders(apiKey: string): Record<string, string> {
		return this.authHeaders_(apiKey);
	}
	// Renamed to avoid recursion with the base class's protected method of the same name —
	// resolve this naming collision cleanly when implementing rather than shipping this
	// workaround: rename ONE of `authHeaders`/`authHeaders_` before writing tests.
	private authHeaders_(token: string) { return this.authHeaders(token); }
}
```

Note: the device-code exchange for Grok (unlike the refresh above) needs the OIDC-discovered `device_authorization_endpoint`, not a hardcoded one — `discoverEndpoints()` in `grok.py` fetches both endpoints from the same `.well-known/openid-configuration` document. Task 17's sign-in command (Step 3 below) must call that discovery once before starting the device flow, using `GrokProvider.ISSUER`, `GrokProvider.CLIENT_ID`, and `GrokProvider.SCOPE`.

- [ ] **Step 2: Fix the two self-inflicted issues left in Step 1's draft**

The draft above deliberately ships two problems for this step to resolve, rather than hiding them:
1. **The credential-encoding hack** (`storedCredential` as a `|`-joined string): decide whether to keep this (simplest, but fragile if a token ever contains `|` — GitHub/xAI tokens don't, but don't assume without checking the actual token format returned) or store the refresh token and expiry via a small JSON-stringified object in the same `SecretStorage` slot instead (`JSON.stringify({ accessToken, refreshToken, expiresAt })`), which `mintToken` then `JSON.parse`s. **Prefer the JSON form** — it isn't meaningfully more code and doesn't carry the `|`-collision risk forward.
2. **The `authHeaders`/`authHeaders_` naming collision**: pick one real name (e.g. rename the private wire-header builder to `wireAuthHeaders` and have the `protected override authHeaders` simply call it) rather than shipping the workaround method.

Rewrite the file with both fixed before writing any test for it.

- [ ] **Step 3: Register the provider and its sign-in command**

Same shape as Task 16 Step 3, using `GrokProvider.ISSUER`/`CLIENT_ID`/`SCOPE` and OIDC-discovered endpoints (fetch `${GrokProvider.ISSUER}/.well-known/openid-configuration` once at sign-in time to get `device_authorization_endpoint` and `token_endpoint`, rather than hardcoding them — xAI publishes rather than fixes these, per the source project's own reasoning for discovering instead of guessing).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --prefix extensions/openvs-chat`

- [ ] **Step 5: Manual verification against a real xAI account**

This is the actual test for this provider — the source project shipped this integration having never called it live. Sign in, send one message, and record here (as a follow-up doc comment in `grok.ts`) whether the header set and scope actually worked as transcribed, or what had to change.

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/providers/grok.ts extensions/openvs-chat/src/oauth.ts extensions/openvs-chat/src/extension.ts extensions/openvs-chat/src/providers/registry.ts
git commit -m "feat(openvs-chat): add xAI Grok provider via Grok CLI's OAuth identity

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 18: `KiroProvider`

**Files:**
- Create: `extensions/openvs-chat/src/providers/kiro.ts`
- Test: `extensions/openvs-chat/scripts/test-kiro-extract.mjs`
- Modify: `extensions/openvs-chat/src/providers/registry.ts` — register `new KiroProvider()`.
- Modify: `extensions/openvs-chat/src/extension.ts` — register `openvsChat.kiroImportCredential`, which reads `~/.aws/sso/cache/kiro-auth-token.json` (the file Kiro's own IDE/CLI already wrote after a user signs in there — **this provider does not implement any sign-in flow of its own**, it only imports) and stores its `refreshToken`/`accessToken`/`expiresAt` via `registry.setApiKey('kiro', JSON.stringify({...}))`.

**Interfaces:** Produces `extractCodeWhispererText(body: unknown): string`, exported for the test.

Given the free tier is roughly 50 interactions/month, this provider is explicitly low-priority — implement it last, and skip Step 5's live verification burning your monthly quota on anything beyond one confirmatory message.

- [ ] **Step 1: Write the failing test for the response-shape extractor**

Ported faithfully from `AutomationScripts/ai/providers/kiro.py`'s `extract_codewhisperer` (read in this plan's research) — the pure, testable-offline piece of this integration.

```js
// extensions/openvs-chat/scripts/test-kiro-extract.mjs
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the CodeWhisperer response-shape extractor in
// src/providers/kiro.ts, ported from AutomationScripts/ai/providers/kiro.py's
// extract_codewhisperer. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-kiro-extract.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/kiro.js', import.meta.url));

// Shape 1: plain JSON with a top-level text field.
assert.equal(m.extractCodeWhispererText({ completion: 'hello' }), 'hello');
assert.equal(m.extractCodeWhispererText({ content: 'hi there' }), 'hi there');

// Shape 2: an events list, each with assistantResponseEvent.content.
assert.equal(
	m.extractCodeWhispererText({ events: [
		{ assistantResponseEvent: { content: 'part one ' } },
		{ assistantResponseEvent: { content: 'part two' } },
	] }),
	'part one part two',
);
assert.equal(
	m.extractCodeWhispererText({ completionEvents: [{ assistantResponseEvent: { content: 'x' } }] }),
	'x',
);

// Shape 3: a raw string blob with embedded {"content":"..."} fragments (the AWS
// event-stream framing case) — regex fallback scrapes them out and unescapes each one.
assert.equal(
	m.extractCodeWhispererText('garbage-prefix{"content":"He said \\"hi\\""}garbage-suffix{"content":" bye"}'),
	'He said "hi" bye',
);

// Empty/unrecognized shapes return '' rather than throwing.
assert.equal(m.extractCodeWhispererText({}), '');
assert.equal(m.extractCodeWhispererText(null), '');
assert.equal(m.extractCodeWhispererText(42), '');

console.log('All kiro-extract assertions passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/openvs-chat/scripts/test-kiro-extract.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the extractor and the provider**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OAuthProxyChatProvider } from './oauthProxy';
import { ChatRequest, ProviderInfo, apiFetch, describeHttpError } from './types';

const CONTENT_FRAGMENT = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Pulls assistant text out of a CodeWhisperer `generateAssistantResponse` response, which
 * answers in one of three shapes depending on endpoint/streaming: plain JSON with a
 * `completion`/`content`/`text` field, an `events`/`completionEvents` list each carrying
 * `assistantResponseEvent.content`, or a raw AWS event-stream blob with `{"content":"..."}`
 * fragments embedded in binary framing (handled by scraping those fragments out rather than
 * parsing the framing properly — not worth it for the one field needed).
 * Ported from `AutomationScripts/ai/providers/kiro.py`'s `extract_codewhisperer`.
 */
export function extractCodeWhispererText(body: unknown): string {
	let text: string;
	if (typeof body === 'string') {
		text = body;
	} else if (body && typeof body === 'object') {
		const obj = body as Record<string, unknown>;
		for (const key of ['completion', 'content', 'text']) {
			const value = obj[key];
			if (typeof value === 'string' && value.trim()) {
				return value;
			}
		}
		const events = obj.events ?? obj.completionEvents;
		if (Array.isArray(events)) {
			const parts: string[] = [];
			for (const ev of events) {
				if (!ev || typeof ev !== 'object') {
					continue;
				}
				const inner = (ev as Record<string, unknown>).assistantResponseEvent ?? ev;
				const piece = (inner as Record<string, unknown>)?.content;
				if (typeof piece === 'string') {
					parts.push(piece);
				}
			}
			if (parts.length) {
				return parts.join('');
			}
		}
		text = JSON.stringify(body);
	} else {
		return '';
	}

	const parts: string[] = [];
	for (const match of text.matchAll(CONTENT_FRAGMENT)) {
		try {
			parts.push(JSON.parse(`"${match[1]}"`));
		} catch {
			// Malformed fragment — skip it rather than corrupt the assembled text.
		}
	}
	return parts.join('');
}

/**
 * Provider for AWS Kiro (Amazon Q Developer / CodeWhisperer) using the token file Kiro's
 * own IDE/CLI already wrote after a normal sign-in there — this provider does not implement
 * any sign-in flow, it only imports (`openvsChat.kiroImportCredential`).
 *
 * ⚠️ Calls CodeWhisperer's internal `generateAssistantResponse` endpoint directly rather than
 * a documented public API — the same category of integration as Copilot/Grok above, with the
 * same account-risk caveat. **Unverified end-to-end.**
 *
 * The free AWS Builder ID tier is roughly 50 interactions/MONTH — this exists for pattern
 * completeness and is not meant to carry real traffic. `NOT_AUTO_INFERRED` in `auto/router.ts`
 * must exclude it so Auto mode never burns the monthly allowance on the user's behalf.
 */
export class KiroProvider extends OAuthProxyChatProvider {
	readonly info: ProviderInfo = {
		id: 'kiro',
		label: 'AWS Kiro (Amazon Q)',
		suggestedModels: ['claude-sonnet-4-5'],
		apiKeyUrl: 'https://kiro.dev',
		requiresApiKey: true,
		supportsTools: false,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};

	private static readonly PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK';

	protected async mintToken(storedCredential: string, signal: AbortSignal): Promise<{ token: string; expiresAt: number }> {
		const cred = JSON.parse(storedCredential) as { accessToken?: string; refreshToken?: string; expiresAt?: number; region?: string };
		if (cred.accessToken && (cred.expiresAt ?? 0) - Date.now() > 5 * 60_000) {
			return { token: cred.accessToken, expiresAt: cred.expiresAt ?? 0 };
		}
		if (!cred.refreshToken) {
			throw new Error('AWS Kiro: credential has no refreshToken — re-import from Kiro (openvsChat.kiroImportCredential).');
		}
		const region = cred.region || 'us-east-1';
		const response = await apiFetch(`https://prod.${region}.auth.desktop.kiro.dev/refreshToken`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken: cred.refreshToken }),
		}, signal, { timeoutMs: 15_000, retries: 0 });
		if (!response.ok) {
			throw new Error(await describeHttpError('AWS Kiro', response));
		}
		const body = await response.json() as { accessToken?: string; expiresAt?: string | number };
		if (!body.accessToken) {
			throw new Error('AWS Kiro: refreshToken returned no accessToken.');
		}
		const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt
			: typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) || (Date.now() + 45 * 60_000)
				: Date.now() + 45 * 60_000;
		return { token: body.accessToken, expiresAt };
	}

	override async streamChat(request: ChatRequest) {
		const token = await this.wireToken(request.apiKey, request.signal);
		const response = await apiFetch('https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
			body: JSON.stringify({
				conversationState: {
					chatTriggerType: 'MANUAL',
					conversationId: crypto.randomUUID(),
					currentMessage: {
						userInputMessage: {
							content: request.messages[request.messages.length - 1]?.content ?? '',
							modelId: request.model,
							origin: 'AI_EDITOR',
						},
					},
					history: [],
				},
				profileArn: KiroProvider.PROFILE_ARN,
			}),
		}, request.signal, { timeoutMs: 60_000, retries: 0 });
		if (!response.ok) {
			throw new Error(await describeHttpError('AWS Kiro', response));
		}
		const text = extractCodeWhispererText(await response.json().catch(async () => response.text()));
		request.onToken(text);
		return { truncated: false };
	}

	// Kiro has no tool-calling support wired here (supportsTools: false) and no separate
	// /models endpoint documented in the source material — listModels falls back to the
	// inherited OpenAICompatibleProvider.listModels, which will 404 against this endpoint.
	// Override it to return suggestedModels directly instead of attempting a live fetch:
	override async listModels(): Promise<ModelEntry[]> {
		return this.info.suggestedModels.map(id => ({ id }));
	}
}
```

Note: `KiroProvider` does not send full conversation history — `conversationState.history` is hardcoded empty above, matching `kiro.py`'s own payload (its doc comment there notes CodeWhisperer's envelope wants a specific history shape this integration hasn't verified). This means **Kiro chat is effectively single-turn** as implemented; multi-turn context is lost between messages. This is a known, accepted limitation for a 50-interactions/month provider — flag it in the UI (`ProviderInfo` has no field for a caveat string today; consider whether one is worth adding, or whether the `label` — `'AWS Kiro (Amazon Q) — single-turn'` — is a low-effort enough way to surface it without a UI change) rather than silently shipping degraded multi-turn behavior.

- [ ] **Step 4: Compile and run the extractor test**

Run:
```bash
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-kiro-extract.mjs
```
Expected: `All kiro-extract assertions passed.`

- [ ] **Step 5: Register the provider and the import command**

In `registry.ts`: import and add `new KiroProvider()`. In `extension.ts`: register `openvsChat.kiroImportCredential` reading `~/.aws/sso/cache/kiro-auth-token.json` (use Node's `os.homedir()` + `fs.promises.readFile`, matching the path shape `kiro.py` documents), extracting `refreshToken`/`accessToken`/`expiresAt`/`region` into the JSON blob `mintToken` expects, and storing via `registry.setApiKey('kiro', json)`.

- [ ] **Step 6: One confirmatory live message, not more**

Given the ~50/month cap, verify with exactly one real chat message rather than iterating live.

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/src/providers/kiro.ts extensions/openvs-chat/src/extension.ts extensions/openvs-chat/src/providers/registry.ts extensions/openvs-chat/scripts/test-kiro-extract.mjs
git commit -m "feat(openvs-chat): add AWS Kiro provider (imports existing Kiro credential)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 19: Wire resilience + Auto-exclusion for all three

**Files:**
- Modify: `extensions/openvs-chat/src/auto/router.ts` — add `'copilot'`, `'grok'`, `'kiro'` to `NOT_AUTO_INFERRED` (`router.ts:68`).
- Confirm (no code change expected, verification only): the call sites Task 6-8 of the companion plan already wrapped with `withProviderResilience` cover these three automatically, since they're keyed by `providerId` generically, not per-provider — re-run the companion plan's Task 13 full-suite verification after this phase lands.

- [ ] **Step 1: Add the exclusions**

```ts
const NOT_AUTO_INFERRED = new Set(['custom', 'antigravity', 'copilot', 'grok', 'kiro']);
```

- [ ] **Step 2: Typecheck + full suite**

```bash
npm run typecheck --prefix extensions/openvs-chat
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/run-tests.mjs
```

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/auto/router.ts
git commit -m "fix(openvs-chat): never let Auto mode select an OAuth-proxy provider on its own

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 4: Web-cookie provider (`web_gemini`)

This phase carries materially more risk and engineering cost than Phase 3, for reasons worth restating precisely before scoping tasks:

- The credential is **a real, signed-in Chrome profile** belonging to a Google account — not an API key, not an OAuth token. Reading it means decrypting Chrome's own cookie store.
- The source project's decryption path (`agent/profile_cookies.py`) is **Windows-only**: it reads Chrome's `Local State` file for `os_crypt.encrypted_key`, unwraps it via `CryptUnprotectData` (a Windows DPAPI call, via Python's `ctypes` against `crypt32.dll`), then AES-GCM-decrypts each `v10`-prefixed cookie value, and strips a 32-byte domain-hash prefix Chrome adds before the plaintext is usable in an HTTP header. **`openvs-thor` is a cross-platform VS Code fork** (macOS and Linux are real targets, per `src/vs/code/`'s Electron main-process code existing for all three platforms) — a Windows-only provider needs an honest non-Windows story (macOS Chrome uses Keychain, not DPAPI; Linux uses a different scheme again, often just a fixed key or the desktop keyring), which the source project never had to solve because it is a Windows-only internal tool.
- Chrome's newer **App-Bound Encryption** (`v20` cookie prefix) is not decryptable this way at all — the source project's own `available()` check falls back to a stale bundle when it detects this, rather than pretending. Any Chrome install updated past a certain point on Windows will hit this.
- This is the one integration in this plan whose target is not a developer-facing API or CLI at all — it is **replaying a signed-in consumer account against a consumer chat UI** (`gemini.google.com`'s internal `batchexecute` RPC mechanism), which is a categorically different act from calling an internal-but-API-shaped backend the way Copilot/Grok/Kiro do above.

**Status: implemented 2026-09-04, after re-reading the actual source files below (not just the README summary this section was originally scoped from) and getting the user's explicit sign-off on the one real blocker: reading Chrome's `Cookies` SQLite file with no native build step.**

That blocker and how it was resolved: Node has no built-in SQLite reader trustworthy inside VS Code's embedded Electron/Node runtime (`node:sqlite` is Node 22.5+-only and the embedded version couldn't be confirmed from here), and a hand-written SQLite page-format parser could only be honestly verified by testing it against a real, live, signed-in Chrome profile — which this session declined to do unprompted (decrypting a real Google session as a side effect of "testing" is exactly the kind of specific, sensitive action that needs the user to ask for it directly, not fall out of a general "proceed"). Asked via `AskUserQuestion`; the user chose **add a small SQLite dependency**. Implemented with `sql.js` (WASM, MIT, zero native compilation — the user's own phrasing was "small dependency," and a WASM package avoids the native-binding/Electron-ABI fragility a `better-sqlite3`/`sqlite3` choice would have carried for a VS Code extension) rather than a native binding. This is the **one** dependency `extensions/openvs-chat` carries; `extensions/openvs-chat` also had to be added to `build/npm/dirs.ts` so the repo-wide `npm install` actually installs it (it wasn't there before — this extension had never needed one).

What shipped, matching the design below closely (see `CLAUDE.md`'s `providers/webCookie/` paragraph for the fuller description):

- `providers/webCookie/dpapi.ts` — `dpapiUnprotectCurrentUser`, a zero-dependency DPAPI unwrap via a `powershell.exe` one-liner (Windows only; degrades to `undefined` elsewhere). Unit-tested by round-tripping a synthetic, throwaway string through DPAPI as the current machine user — proves the shell-out mechanism actually works on a real Windows box without ever touching a real credential.
- `providers/webCookie/chromeCookies.ts` — `readMasterKey` (DPAPI-unwraps Chrome's `Local State` key, reporting App-Bound Encryption / a missing profile honestly rather than guessing), `stripDomainHashPrefix` + `decryptCookieValue` (AES-256-GCM via Node's built-in `crypto`, unit-tested against synthetic ciphertext generated with a throwaway key in the test itself — a wrong key, a too-short value, and a missing v10/v11 prefix all fail closed to `''`), `readCookies` (copies the locked `Cookies` DB, reads it via `sql.js`), `cookiesToHeader`, and `defaultChromeProfilePath`/`isPlatformSupported`.
- `providers/webCookie/geminiWebProvider.ts` — `GeminiWebProvider`, plus the pure, unit-tested pieces of the `batchexecute` protocol: `parseSessionTokens` (scrapes `SNlM0e`/`cfb2h` out of the app shell) and `extractGeminiText` (keeps only the LAST cumulative-snapshot frame carrying a body — tested against synthetic frames, including the "still generating" and "not a frame at all" cases).
- The `PRODUCTION_ENABLED`-equivalent hard gate: `openvsChat.webGemini.enabled`, off by default, checked inside every call — separate from (and in addition to) `NOT_AUTO_INFERRED` membership, which only stops *automatic* selection, not a user selecting it directly with the setting still off.
- Multi-account reuses Phase 1's `KeyRotator`/`withProviderResilience` rather than a bespoke pool (each stored "key" names a Chrome profile directory); an unreadable/unsigned-in profile is deliberately phrased to include "HTTP 401" so the shared `isKeyFailure` classifier rotates to the next configured profile automatically, the same as a bad API key would for any other provider.

What was read in full before writing any of the above (not just summarized from the README, per this section's original instruction):

- `AutomationScripts/ai/providers/web_cookie_providers/agent/profile_cookies.py` (the DPAPI + AES-GCM decrypt — read in full, not summarized, before writing any TypeScript port)
- `AutomationScripts/ai/providers/web_cookie_providers/_cookie_auth.py` (jar → `Cookie` header, `Set-Cookie` merge-back)
- `AutomationScripts/ai/providers/web_cookie_providers/_transport.py` (anti-bot detection handling)
- `AutomationScripts/ai/providers/web_cookie_providers/sites/gemini_web.py` (the actual `batchexecute` request/response parser for `gemini.google.com` — this is the piece with no equivalent anywhere else in this plan, since it's reverse-engineering a web app's internal RPC format rather than a documented or even semi-documented API)
- `AutomationScripts/ai/providers/web_cookie_providers/catalog.py` (the `PRODUCTION_ENABLED` master switch pattern — worth keeping as a design idea regardless: a single settings flag that must be explicitly True before this provider leaves the settings panel and enters the actual provider list, on top of having a key/credential, so it can't be dispatched to by accident the moment a Chrome profile happens to be importable)

### File Structure (as built)

- `extensions/openvs-chat/src/providers/webCookie/dpapi.ts`, `chromeCookies.ts`, `geminiWebProvider.ts` — a subdirectory (mirroring the source project's own `web_cookie_providers/` package boundary), matching the shape sketched above: platform-specific cookie decryption, the Gemini web adapter, and the `PRODUCTION_ENABLED`-equivalent settings gate each in their own module.
- `extensions/openvs-chat/package.json` gained its first runtime dependency (`sql.js`) and `build/npm/dirs.ts` gained an entry for `extensions/openvs-chat` so the monorepo's `npm install` actually installs it.

## Design rationale

See the companion plan's "Design rationale" section for what Phase 1/2 took and deliberately left out. This plan's two phases add:

- **Taken (Phase 3):** the two-stage/one-stage token-mint-and-cache pattern (`OAuthChatProvider._mint_token` in the source project, generalized here as `OAuthProxyChatProvider`), and the three providers' concrete endpoints/headers/client-ids, transcribed exactly rather than re-derived, since a wrong header value here fails silently (a 403 with no hint it's the header, not the account).
- **Taken (Phase 4):** the `PRODUCTION_ENABLED`-style hard gate (`openvsChat.webGemini.enabled`), separate from mere "disabled," for anything this risky; the DPAPI-unwrap-then-AES-GCM-per-cookie decryption shape and the exact `batchexecute` wire protocol, transcribed from the source project's own verified-working implementation rather than re-derived from the README summary.
- **Deliberately scoped smaller than the source project (Phase 3 & 4):** no cross-process OAuth-cred-file pool (`~/Documents/<provider>/oauth_creds_N.json`, rotate-on-429) and no bespoke multi-account pool for the cookie provider either — a single VS Code session has one signed-in identity per provider, not a pool of several harvested accounts, so `KeyRotator`/`getExtraApiKeys` from the companion plan already covers "I have two Copilot accounts" (or two Google accounts, for `web_gemini`) by treating each credential/profile-path as one entry in the ordinary primary+backup key pool, without needing a separate pool mechanism.
- **Deliberately not ported (Phase 4):** the source project's cross-process file-based multi-account state and its Set-Cookie-rotation persistence to disk — a session-scoped read-fresh-every-call model (matching `RateLimitTracker`'s own convention) needs neither, since there is no second process to coordinate with and the live profile read means there is nothing to go stale between calls to persist a fix for.
- **One deliberate platform gap:** Windows only. macOS (Keychain) and Linux (a distro keyring or fixed key) would each need their own unwrap step this plan did not design or implement; `isPlatformSupported()` fails honestly rather than guessing on either.
