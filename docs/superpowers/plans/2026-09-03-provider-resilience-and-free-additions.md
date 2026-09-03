# Provider Resilience + Free Provider Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-API-key rotation and a provider/model quota-cooldown to `openvs-chat`'s provider layer, and add three new free OpenAI-compatible providers (Z.AI, OpenCode Zen, xkiro).

**Architecture:** Two new session-scoped, in-memory trackers (`KeyRotator`, `CooldownTracker`) sit on `ProviderRegistry` next to the existing `RateLimitTracker`-per-provider pattern. A single new helper, `withProviderResilience`, wraps every call site that currently does `apiKey = await registry.getApiKey(id); provider.streamChat({...})` — on a 401/403/429 it marks a cooldown and, if a spare key exists, rotates and retries once. The three new providers are trivial subclasses of the existing `OpenAICompatibleProvider` base, following the same shape as `MistralProvider`.

**Tech Stack:** TypeScript, VS Code `SecretStorage`, existing `apiFetch`/`describeHttpError` in `providers/types.ts`. No new dependencies.

**Spec:** No separate spec document — derived from a source analysis of `AutomationScripts/ai/` (a Python multi-provider batch dispatcher) conducted in chat on 2026-09-03, cross-referenced against the current `extensions/openvs-chat/src/providers/*` architecture. See "Design rationale" at the end of this file for the source material this borrows from and what it deliberately leaves out.

## Global Constraints

- Follow `extensions/openvs-thor/CLAUDE.md` coding guidelines: tabs not spaces, PascalCase types, JSDoc on exported symbols, `async`/`await`, no `any`, register disposables properly (none of these trackers are disposables — they're plain in-memory maps owned by `ProviderRegistry`, which is itself long-lived for the extension's lifetime).
- Every provider file needs the OpenVS copyright header (copy verbatim from `extensions/openvs-chat/src/providers/mistral.ts:1-4`).
- Trackers are **session-scoped and in-memory only** — same convention as `RateLimitTracker` in `providers/rateLimits.ts` (see its doc comment: "Session-scoped and in memory on purpose... the cost of forgetting is one request, since the very next response re-states it"). Do NOT persist rotation/cooldown state to disk or `globalState` — that would let a stale cooldown survive a key rotation or a plan upgrade.
- **MANDATORY:** run `npm run typecheck --prefix extensions/openvs-chat` after every task and fix errors before moving on. Do not accumulate compile errors across tasks.
- After each task's tests pass, run the full suite once with `node extensions/openvs-chat/scripts/run-tests.mjs` (after `npx tsc -p extensions/openvs-chat/tsconfig.json`) to catch cross-file breakage before committing.

---

## Phase 1: Key rotation + quota cooldown (resilience core)

### File Structure

- Create: `extensions/openvs-chat/src/providers/keyRotation.ts` — `KeyRotator` class (rotation state per provider id).
- Create: `extensions/openvs-chat/src/providers/cooldown.ts` — `CooldownTracker` class (per provider+model cooldown timestamps) and the daily-vs-rate-limit marker detection.
- Create: `extensions/openvs-chat/src/providers/resilience.ts` — `withProviderResilience()`, the shared retry-with-rotation wrapper, and its 401/403/429 detection regex.
- Modify: `extensions/openvs-chat/src/providers/registry.ts` — add `EXTRA_KEY_PREFIX`, `getApiKeys`, `rotateApiKey`, `noteApiKeySuccess`, `getExtraApiKeys`, `setExtraApiKeys`; hold `keyRotator` and public `readonly cooldowns`.
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts` — wrap the two `provider.streamChat(...)` / `provider.runAgentStep(...)` call sites (search `getApiKey(providerId)`, currently at lines 1616 and 1947) with `withProviderResilience`.
- Modify: `extensions/openvs-chat/src/auto/orchestrator.ts` — wrap its call site (currently `registry.getApiKey(providerId)` at line 422).
- Modify: `extensions/openvs-chat/src/git/commitMessage.ts` — wrap its call site (currently line 143).
- Modify: `extensions/openvs-chat/src/completions/inlineProvider.ts` — **do NOT wrap this one.** See Task 4's note — completions must not gain a retry, per the non-interference contract `test-completion-isolation.mjs` enforces.
- Modify: `extensions/openvs-chat/src/auto/router.ts` — skip a cooling-down candidate when ranking role candidates (near `NOT_AUTO_SELECTED_MODELS`, `src/auto/router.ts:77`).
- Modify: `extensions/openvs-chat/package.json` — add `openvsChat.<id>.extraApiKeysHint` is NOT needed (no new setting; extra keys live in `SecretStorage`, not `settings.json`, matching how the primary key is stored). Add one new webview message pair instead (Task 5).
- Modify: `extensions/openvs-chat/media/main.js` and `media/prompts.js` (or wherever the Providers settings panel renders a provider's API-key field — locate via `grep -n "setApiKey" extensions/openvs-chat/media/main.js`) — add an "Additional API keys" textarea under the existing key field.
- Test: `extensions/openvs-chat/scripts/test-key-rotation.mjs`
- Test: `extensions/openvs-chat/scripts/test-cooldown.mjs`
- Test: `extensions/openvs-chat/scripts/test-provider-resilience.mjs`

### Interfaces

- Produces (Task 1): `KeyRotator` in `providers/keyRotation.ts`:
  ```ts
  export class KeyRotator {
  	activeIndex(id: string, keys: readonly string[]): number;
  	rotate(id: string, keys: readonly string[]): boolean;
  	clear(id: string): void;
  }
  ```
- Produces (Task 2): `CooldownTracker` in `providers/cooldown.ts`:
  ```ts
  export class CooldownTracker {
  	markCooldown(providerId: string, model: string, detail: string, now?: number): number; // returns the `until` epoch ms
  	isCoolingDown(providerId: string, model: string, now?: number): boolean;
  	remainingMs(providerId: string, model: string, now?: number): number;
  	clear(providerId: string, model: string): void;
  }
  ```
- Produces (Task 3): `ProviderRegistry` additions in `providers/registry.ts`:
  ```ts
  async getApiKeys(id: string): Promise<string[]>;               // [primary, ...extra], env/oauth excluded
  async rotateApiKey(id: string): Promise<boolean>;               // true = a different stored key is now active
  noteApiKeySuccess(id: string): void;
  async getExtraApiKeys(id: string): Promise<string[]>;
  async setExtraApiKeys(id: string, keys: string[]): Promise<void>;
  readonly cooldowns: CooldownTracker;
  ```
  (existing `getApiKey(id): Promise<string | undefined>` keeps its signature but its body changes to consult `getApiKeys` + the rotator.)
- Produces (Task 4): `withProviderResilience` in `providers/resilience.ts`:
  ```ts
  export async function withProviderResilience<T>(
  	registry: ProviderRegistry,
  	providerId: string,
  	model: string,
  	fn: (apiKey: string) => Promise<T>,
  ): Promise<T>;
  ```
- Consumes (Task 6+): `ProviderRegistry` from Task 3, `withProviderResilience` from Task 4.

---

### Task 1: `KeyRotator`

**Files:**
- Create: `extensions/openvs-chat/src/providers/keyRotation.ts`
- Test: `extensions/openvs-chat/scripts/test-key-rotation.mjs`

**Interfaces:**
- Produces: `KeyRotator` (see Interfaces above).

- [ ] **Step 1: Write the failing test**

```js
// extensions/openvs-chat/scripts/test-key-rotation.mjs
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/keyRotation.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-key-rotation.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/keyRotation.js', import.meta.url));

// A single-key provider never "rotates" — there is nothing to rotate to.
{
	const r = new m.KeyRotator();
	assert.equal(r.activeIndex('p', ['k1']), 0);
	assert.equal(r.rotate('p', ['k1']), false, 'single key: rotate is a no-op');
	assert.equal(r.activeIndex('p', ['k1']), 0);
}

// Two keys: rotate advances to the other one and stays there.
{
	const r = new m.KeyRotator();
	assert.equal(r.activeIndex('p', ['k1', 'k2']), 0);
	assert.equal(r.rotate('p', ['k1', 'k2']), true);
	assert.equal(r.activeIndex('p', ['k1', 'k2']), 1);
	// Rotating again marks k2 errored too — both are now errored, so the errored set
	// resets and rotation restarts from the first non-current key (index 0... but 0 is
	// the "current" being rotated away from, so it lands back on the other one: with a
	// 2-key pool this cycles 0 -> 1 -> 0 -> 1 forever, which is correct behaviour).
	assert.equal(r.rotate('p', ['k1', 'k2']), true);
	assert.equal(r.activeIndex('p', ['k1', 'k2']), 0);
}

// Three keys: rotating through all of them resets the errored set and cycles rather
// than getting stuck once every key has failed once.
{
	const r = new m.KeyRotator();
	const keys = ['a', 'b', 'c'];
	assert.equal(r.activeIndex('p', keys), 0);
	r.rotate('p', keys); // a errored, active -> b
	assert.equal(r.activeIndex('p', keys), 1);
	r.rotate('p', keys); // b errored, active -> c
	assert.equal(r.activeIndex('p', keys), 2);
	r.rotate('p', keys); // c errored -> all 3 errored -> reset -> active -> a (first non-current)
	assert.equal(r.activeIndex('p', keys), 0);
}

// `clear` drops the errored mark so a key that recovers is trusted again immediately.
{
	const r = new m.KeyRotator();
	r.rotate('p', ['a', 'b']);
	assert.equal(r.activeIndex('p', ['a', 'b']), 1);
	r.clear('p');
	// clear does not change WHICH key is active, only forgets the "errored" history —
	// a later 429 on the current key must be able to mark it errored again.
	assert.equal(r.activeIndex('p', ['a', 'b']), 1);
}

// State is independent per provider id.
{
	const r = new m.KeyRotator();
	r.rotate('openrouter', ['x', 'y']);
	assert.equal(r.activeIndex('openrouter', ['x', 'y']), 1);
	assert.equal(r.activeIndex('mistral', ['x', 'y']), 0);
}

// activeIndex clamps to the current key list length — a key removed from settings
// after it became active must not crash or return an out-of-range index.
{
	const r = new m.KeyRotator();
	r.rotate('p', ['a', 'b', 'c']); // active -> index 1
	assert.equal(r.activeIndex('p', ['a', 'b', 'c']), 1);
	assert.equal(r.activeIndex('p', ['only-one-left']), 0);
}

console.log('All keyRotation assertions passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/openvs-chat/scripts/test-key-rotation.mjs`
Expected: FAIL — `Cannot find module '.../out/providers/keyRotation.js'`

- [ ] **Step 3: Write the implementation**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Round-robins a provider's stored API keys away from ones that just failed, so a free-tier
 * user with several accounts' keys spreads load across them instead of every 429 stopping the
 * conversation cold. Ported from the same idea in a batch-scraper's provider dispatcher
 * (`ProviderManager.api_key_rotate` in a companion Python project) but kept session-scoped and
 * in-memory, matching {@link RateLimitTracker}'s convention: a stale rotation is worth at most
 * one wasted request, since {@link ProviderRegistry.getApiKeys} re-reads the stored list fresh
 * on every call and a key that was only ever temporarily rate-limited is trusted again the next
 * time the extension reloads.
 */
export class KeyRotator {
	private readonly activeIndexByProvider = new Map<string, number>();
	private readonly erroredByProvider = new Map<string, Set<number>>();

	private errored(id: string): Set<number> {
		let set = this.erroredByProvider.get(id);
		if (!set) {
			set = new Set();
			this.erroredByProvider.set(id, set);
		}
		return set;
	}

	/**
	 * Index into `keys` that is currently active for `id`. Clamped to the list's current
	 * length so a key removed from settings after becoming active can't leave a stale
	 * out-of-range index around.
	 */
	activeIndex(id: string, keys: readonly string[]): number {
		const current = this.activeIndexByProvider.get(id) ?? 0;
		if (current >= keys.length) {
			this.activeIndexByProvider.set(id, 0);
			return 0;
		}
		return current;
	}

	/**
	 * Marks `id`'s currently active key as errored and advances to the next non-errored
	 * key. When every key has now failed, the errored set is reset and rotation restarts
	 * — matching `ProviderManager.api_key_rotate`'s "all keys errored -> reset and start
	 * over from index 0" behaviour, so a transient outage across every key doesn't
	 * permanently strand the provider once the outage clears.
	 *
	 * Returns false (no-op) for a single-key list — there is nothing to rotate to, and the
	 * caller should treat the failure as final rather than retrying with the same key.
	 */
	rotate(id: string, keys: readonly string[]): boolean {
		if (keys.length <= 1) {
			return false;
		}
		const current = this.activeIndex(id, keys);
		const errored = this.errored(id);
		errored.add(current);

		let available = keys.map((_, i) => i).filter(i => !errored.has(i));
		if (!available.length) {
			errored.clear();
			available = keys.map((_, i) => i);
		}
		const next = available.find(i => i !== current) ?? available[0];
		this.activeIndexByProvider.set(id, next);
		return next !== current;
	}

	/** Drops `id`'s errored-key history after a successful call, so a key that only failed
	 * transiently is trusted again immediately rather than staying skipped until it's the
	 * last one left. Does not change which key is currently active. */
	clear(id: string): void {
		this.erroredByProvider.get(id)?.clear();
	}
}
```

- [ ] **Step 4: Compile and run the test**

Run:
```bash
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-key-rotation.mjs
```
Expected: `All keyRotation assertions passed.`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/providers/keyRotation.ts extensions/openvs-chat/scripts/test-key-rotation.mjs
git commit -m "feat(openvs-chat): add KeyRotator for multi-API-key round-robin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `CooldownTracker`

**Files:**
- Create: `extensions/openvs-chat/src/providers/cooldown.ts`
- Test: `extensions/openvs-chat/scripts/test-cooldown.mjs`

**Interfaces:**
- Produces: `CooldownTracker` (see Interfaces above).

- [ ] **Step 1: Write the failing test**

```js
// extensions/openvs-chat/scripts/test-cooldown.mjs
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/cooldown.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-cooldown.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/cooldown.js', import.meta.url));

// Plain rate limit -> short cooldown; not cooling before it, cooling during, clear after.
{
	const c = new m.CooldownTracker();
	const now = 1_000_000;
	assert.equal(c.isCoolingDown('groq', 'llama', now), false);
	const until = c.markCooldown('groq', 'llama', 'HTTP 429 rate limited, try again in 2s', now);
	assert.equal(until, now + 60_000, 'plain rate limit parks for 60s');
	assert.equal(c.isCoolingDown('groq', 'llama', now + 1), true);
	assert.equal(c.isCoolingDown('groq', 'llama', now + 60_001), false, 'cooldown expires');
}

// Daily/monthly exhaustion markers earn the much longer cooldown.
{
	const c = new m.CooldownTracker();
	const now = 0;
	const daily = [
		'exceeded your current quota, please check your plan (per day)',
		'RESOURCE_EXHAUSTED',
		'insufficient_quota',
		'You have run out of credits',
		'Payment required to access this resource',
		'unable to verify your membership benefits', // Kimi-style subscription refusal
	];
	for (const detail of daily) {
		const c2 = new m.CooldownTracker();
		const until = c2.markCooldown('p', 'm', detail, now);
		assert.equal(until, 900_000, `"${detail}" should earn the daily cooldown, got ${until}ms`);
	}
	// Sanity: markCooldown is case-insensitive.
	const until = c.markCooldown('p', 'm', 'RESOURCE_EXHAUSTED', now);
	assert.equal(until, 900_000);
}

// clear() ends a cooldown early, e.g. after a successful call on a different key.
{
	const c = new m.CooldownTracker();
	c.markCooldown('p', 'm', '429', 0);
	assert.equal(c.isCoolingDown('p', 'm', 1), true);
	c.clear('p', 'm');
	assert.equal(c.isCoolingDown('p', 'm', 1), false);
}

// Cooldowns are keyed by (provider, model) pair — cooling one model must not cool a
// sibling model on the same provider, since a per-model free-tier quota is common
// (e.g. Groq metering `qwen/qwen3.6-27b` separately from `llama-3.3-70b`).
{
	const c = new m.CooldownTracker();
	c.markCooldown('groq', 'model-a', '429', 0);
	assert.equal(c.isCoolingDown('groq', 'model-a', 1), true);
	assert.equal(c.isCoolingDown('groq', 'model-b', 1), false);
}

// remainingMs never goes negative and is 0 once expired or never set.
{
	const c = new m.CooldownTracker();
	assert.equal(c.remainingMs('p', 'm', 0), 0);
	c.markCooldown('p', 'm', '429', 0);
	assert.equal(c.remainingMs('p', 'm', 60_001), 0);
	assert.ok(c.remainingMs('p', 'm', 30_000) > 0);
}

console.log('All cooldown assertions passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/openvs-chat/scripts/test-cooldown.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parks a (provider, model) pair for a while after a quota failure, so Auto mode and the
 * plain chat path don't immediately re-select a model that just told us it has nothing left.
 * Ported from `ProviderManager.mark_quota_cooldown` in a companion Python batch-dispatcher
 * project, with the same two-tier duration: a plain rate limit clears in under a minute, but a
 * daily/monthly exhaustion or a billing refusal will not, and re-probing it every request for
 * the rest of the day wastes a request each time for nothing.
 *
 * Session-scoped and in-memory, same convention as {@link RateLimitTracker} — persisting this
 * would let a stale cooldown outlive a plan upgrade or a fresh API key.
 */
export class CooldownTracker {
	private readonly until = new Map<string, number>();

	private static key(providerId: string, model: string): string {
		return `${providerId} ${model}`;
	}

	/** A 429 usually means "too fast" — the window reopens in seconds. */
	static readonly COOLDOWN_MS = 60_000;
	/** A daily/monthly allowance is gone; seconds do not help. */
	static readonly DAILY_COOLDOWN_MS = 900_000;

	/**
	 * Substrings marking a quota error as a daily/monthly exhaustion or a billing/entitlement
	 * refusal rather than a momentary rate limit, matched case-insensitively. A billing refusal
	 * ("payment required", "membership") is grouped in here rather than treated as permanent,
	 * because {@link CooldownTracker} has no concept of "never retry" — 15 minutes is simply
	 * long enough that a session re-probes it at most a few times a day instead of on every
	 * message.
	 */
	private static readonly DAILY_MARKERS = [
		'per day', 'daily', 'per-day', 'requests per day', 'rpd',
		'quota exceeded', 'resource_exhausted', 'insufficient_quota',
		'out of credits', 'insufficient credits', 'monthly', 'run out of credits',
		'payment required', 'payment_required', 'billing', 'membership',
	];

	/**
	 * Parks `providerId`/`model` after a quota failure. `detail` is the provider's error
	 * text (typically the message from {@link describeHttpError}); a daily-exhaustion
	 * message earns {@link DAILY_COOLDOWN_MS} instead of {@link COOLDOWN_MS}. Returns the
	 * cooldown deadline (epoch ms).
	 */
	markCooldown(providerId: string, model: string, detail: string, now = Date.now()): number {
		const blob = (detail || '').toLowerCase();
		const daily = CooldownTracker.DAILY_MARKERS.some(marker => blob.includes(marker));
		const ms = daily ? CooldownTracker.DAILY_COOLDOWN_MS : CooldownTracker.COOLDOWN_MS;
		const deadline = now + ms;
		this.until.set(CooldownTracker.key(providerId, model), deadline);
		return deadline;
	}

	isCoolingDown(providerId: string, model: string, now = Date.now()): boolean {
		const deadline = this.until.get(CooldownTracker.key(providerId, model));
		return deadline !== undefined && deadline > now;
	}

	remainingMs(providerId: string, model: string, now = Date.now()): number {
		const deadline = this.until.get(CooldownTracker.key(providerId, model)) ?? 0;
		return Math.max(0, deadline - now);
	}

	/** Ends a cooldown early — call after a successful response for this pair. */
	clear(providerId: string, model: string): void {
		this.until.delete(CooldownTracker.key(providerId, model));
	}
}
```

- [ ] **Step 4: Compile and run the test**

Run:
```bash
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-cooldown.mjs
```
Expected: `All cooldown assertions passed.`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/providers/cooldown.ts extensions/openvs-chat/scripts/test-cooldown.mjs
git commit -m "feat(openvs-chat): add CooldownTracker for per-model quota parking

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire `ProviderRegistry` for multi-key storage + rotation + cooldowns

**Files:**
- Modify: `extensions/openvs-chat/src/providers/registry.ts`
- Test: extend `extensions/openvs-chat/scripts/test-key-rotation.mjs` is NOT the right place (that file tests the pure `KeyRotator`) — instead add a new block to a new file below, since `ProviderRegistry` needs the `vscode` module stub every other host-touching test uses.

**Interfaces:**
- Consumes: `KeyRotator` from Task 1 (`./keyRotation`), `CooldownTracker` from Task 2 (`./cooldown`).
- Produces: `getApiKeys`, `rotateApiKey`, `noteApiKeySuccess`, `getExtraApiKeys`, `setExtraApiKeys`, `readonly cooldowns` on `ProviderRegistry` (exact signatures under Interfaces above). Task 4 and Task 6 consume these.

- [ ] **Step 1: Add the imports and the two new fields**

In `extensions/openvs-chat/src/providers/registry.ts`, add near the top (after the existing `import { OAuthTokenStore } from '../oauth';` line):

```ts
import { CooldownTracker } from './cooldown';
import { KeyRotator } from './keyRotation';
```

Add the extra-keys secret prefix next to `SECRET_PREFIX` (`registry.ts:22`):

```ts
const SECRET_PREFIX = 'openvsChat.apiKey.';
/** Backup keys for a provider, stored as a JSON string array. Rotated in on a 401/403/429
 * against the primary key — see {@link ProviderRegistry.rotateApiKey}. */
const EXTRA_KEY_PREFIX = 'openvsChat.apiKeysExtra.';
```

Add two fields to the `ProviderRegistry` class, next to `readonly oauth: OAuthTokenStore;` (`registry.ts:95`):

```ts
/** Round-robins each provider's stored keys away from ones that just 401/403/429'd. */
private readonly keyRotator = new KeyRotator();
/** Per (provider, model) quota parking — see {@link CooldownTracker}. Public so
 * `auto/router.ts` and `chatViewProvider.ts` can consult it without a registry method
 * per call site. */
readonly cooldowns = new CooldownTracker();
```

- [ ] **Step 2: Add `getExtraApiKeys` / `setExtraApiKeys`**

Add after the existing `clearApiKey` method (`registry.ts:243-246`):

```ts
/** The provider's backup key pool, beyond the primary key — see {@link EXTRA_KEY_PREFIX}. */
async getExtraApiKeys(id: string): Promise<string[]> {
	const raw = await this.secrets.get(EXTRA_KEY_PREFIX + id);
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && k.trim().length > 0) : [];
	} catch {
		return [];
	}
}

/** Replaces the provider's backup key pool. An empty list clears the stored secret entirely
 * rather than persisting an empty array, so `hasExtraApiKeys`-style checks stay simple. */
async setExtraApiKeys(id: string, keys: string[]): Promise<void> {
	const cleaned = keys.map(k => k.trim()).filter(k => k.length > 0);
	if (cleaned.length) {
		await this.secrets.store(EXTRA_KEY_PREFIX + id, JSON.stringify(cleaned));
	} else {
		await this.secrets.delete(EXTRA_KEY_PREFIX + id);
	}
}
```

- [ ] **Step 3: Add `getApiKeys` and rewrite `getApiKey` to rotate**

Replace the existing `getApiKey` method (`registry.ts:164-177`) with:

```ts
/**
 * All usable keys for `id` in rotation order: the primary stored key first, then any
 * backup keys from {@link getExtraApiKeys}. Empty when the provider authenticates via
 * an environment variable or web sign-in instead of a pasted key — those aren't part of
 * the rotation pool: an env var is a single fixed value, and a web sign-in session already
 * refreshes itself independently of key rotation.
 */
async getApiKeys(id: string): Promise<string[]> {
	const envName = this.envVarName(id);
	if (envName && process.env[envName]) {
		return [];
	}
	const primary = await this.secrets.get(SECRET_PREFIX + id);
	if (!primary) {
		return [];
	}
	const extra = await this.getExtraApiKeys(id);
	return [primary, ...extra];
}

async getApiKey(id: string): Promise<string | undefined> {
	// Environment variables are a convenient escape hatch for power users / CI.
	const envName = this.envVarName(id);
	const fromEnv = envName ? process.env[envName] : undefined;
	if (fromEnv) {
		return fromEnv;
	}
	const keys = await this.getApiKeys(id);
	if (keys.length) {
		return keys[this.keyRotator.activeIndex(id, keys)];
	}
	// Web sign-in session, refreshed transparently when close to expiry.
	return this.oauth.getFreshAccessToken(id);
}

/**
 * Call after a request against `id`'s current key failed with a 401/403/429. Marks that
 * key errored and advances to the next stored key. Returns true when a *different* key is
 * now active — the caller should re-resolve via {@link getApiKey} and retry the same
 * request once. Returns false when there is no spare key (single-key or no-key providers),
 * in which case the caller should treat the failure as final.
 */
async rotateApiKey(id: string): Promise<boolean> {
	const keys = await this.getApiKeys(id);
	return this.keyRotator.rotate(id, keys);
}

/** Drops `id`'s errored-key history after a successful call. See {@link KeyRotator.clear}. */
noteApiKeySuccess(id: string): void {
	this.keyRotator.clear(id);
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --prefix extensions/openvs-chat`
Expected: no errors. (`hasCredentials`/`getAuthKind` at `registry.ts:180-195` already call `this.secrets.get(SECRET_PREFIX + id)` directly rather than through `getApiKey`, so they're unaffected by this change — verify that's still true by re-reading them before editing anything else.)

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/providers/registry.ts
git commit -m "feat(openvs-chat): rotate stored API keys on auth/quota failure

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `withProviderResilience` wrapper

**Files:**
- Create: `extensions/openvs-chat/src/providers/resilience.ts`
- Test: `extensions/openvs-chat/scripts/test-provider-resilience.mjs`

**Interfaces:**
- Consumes: `ProviderRegistry` from Task 3 (`getApiKey`, `rotateApiKey`, `noteApiKeySuccess`, `cooldowns`).
- Produces: `withProviderResilience<T>(registry, providerId, model, fn)` (signature under Interfaces above), consumed by Tasks 6-8.

This test needs the same `vscode` module stub every host-touching test in this project uses (see `test-tools.mjs`'s `Module._load` pattern, referenced in `CLAUDE.md`) because `ProviderRegistry`'s constructor takes a `vscode.SecretStorage`. Rather than stub the whole module, this test builds a minimal fake `SecretStorage` directly and constructs `ProviderRegistry` with it — read `extensions/openvs-chat/src/providers/registry.ts`'s constructor signature (`constructor(private readonly secrets: vscode.SecretStorage)`) and `SecretStorage`'s shape (`get`, `store`, `delete`, `onDidChange`) from the `vscode` type declarations before writing the fake.

- [ ] **Step 1: Write the failing test**

```js
// extensions/openvs-chat/scripts/test-provider-resilience.mjs
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/resilience.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-provider-resilience.mjs
//
// Stubs the `vscode` module the same way test-tools.mjs does, so ProviderRegistry's
// SecretStorage dependency resolves to an in-memory fake instead of the real extension host.
import assert from 'node:assert/strict';
import Module from 'node:module';

/** Minimal in-memory SecretStorage — get/store/delete only, no change events needed here. */
class FakeSecretStorage {
	constructor() { this.map = new Map(); }
	async get(key) { return this.map.get(key); }
	async store(key, value) { this.map.set(key, value); }
	async delete(key) { this.map.delete(key); }
	onDidChange() { return { dispose() {} }; }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return {
			workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) },
			ConfigurationTarget: { Global: 1 },
		};
	}
	return originalLoad(request, parent, isMain);
};

const { ProviderRegistry } = await import(new URL('../out/providers/registry.js', import.meta.url));
const { withProviderResilience } = await import(new URL('../out/providers/resilience.js', import.meta.url));

const PID = 'mistral'; // a real provider id registered by ProviderRegistry's constructor

// Success on the first try: no rotation, cooldown cleared.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'key-1');
	const result = await withProviderResilience(registry, PID, 'model-x', async apiKey => {
		assert.equal(apiKey, 'key-1');
		return 'ok';
	});
	assert.equal(result, 'ok');
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), false);
}

// 429 with a spare key: rotates and retries once, succeeds on the second key.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'key-1');
	await registry.setExtraApiKeys(PID, ['key-2']);
	let calls = 0;
	const result = await withProviderResilience(registry, PID, 'model-x', async apiKey => {
		calls++;
		if (apiKey === 'key-1') {
			throw new Error(`${PID}: rate limited (HTTP 429) — try again shortly.`);
		}
		return `used ${apiKey}`;
	});
	assert.equal(calls, 2);
	assert.equal(result, 'used key-2');
	// The cooldown recorded against the first key's failure is cleared once the RETRY
	// succeeds: the (provider, model) pair is not actually out of capacity — only that
	// one key was — so Auto-mode routing must not skip this pair on the strength of a
	// failure the rotation already recovered from.
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), false);
}

// 429 with no spare key: no rotation possible, the original error propagates and a
// cooldown is still recorded so the next request skips straight past this pair.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'only-key');
	let calls = 0;
	await assert.rejects(
		() => withProviderResilience(registry, PID, 'model-x', async () => {
			calls++;
			throw new Error(`${PID}: rate limited (HTTP 429) — try again shortly.`);
		}),
		/HTTP 429/,
	);
	assert.equal(calls, 1, 'no spare key means no retry');
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), true);
}

// A non-401/403/429 failure (e.g. a 500 or a network error) is never retried with a
// different key — rotating keys cannot fix a backend outage, and doing so anyway would
// silently double the number of requests sent during an incident.
{
	const registry = new ProviderRegistry(new FakeSecretStorage());
	await registry.setApiKey(PID, 'key-1');
	await registry.setExtraApiKeys(PID, ['key-2']);
	let calls = 0;
	await assert.rejects(
		() => withProviderResilience(registry, PID, 'model-x', async () => {
			calls++;
			throw new Error(`${PID}: request failed (HTTP 503). service unavailable`);
		}),
		/HTTP 503/,
	);
	assert.equal(calls, 1);
	assert.equal(registry.cooldowns.isCoolingDown(PID, 'model-x'), false, '503 is not a quota signal');
}

console.log('All provider-resilience assertions passed.');

Module._load = originalLoad;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node extensions/openvs-chat/scripts/test-provider-resilience.mjs`
Expected: FAIL — `resilience.js` module not found.

- [ ] **Step 3: Write the implementation**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ProviderRegistry } from './registry';

/**
 * A 401 (bad/expired key), 403 (forbidden — often a quota/entitlement refusal dressed up as
 * a permission error, e.g. Qwen's `AccessDenied.Unpurchased`) or 429 (rate limit) — the three
 * HTTP statuses {@link describeHttpError} already renders distinctly and that a *different*
 * API key has a real chance of surviving. Matched against the message text rather than a
 * status code because providers throw `Error`, not a typed HTTP failure — see
 * `describeHttpError`'s wording ("authentication failed (HTTP 401", "HTTP 403", "rate limited
 * (HTTP 429") in `providers/types.ts`.
 */
const KEY_FAILURE = /\bhttp (401|403|429)\b/i;

/**
 * Resolves `providerId`'s current API key, calls `fn` with it, and on a 401/403/429 rotates
 * to the next stored key (if one exists) and retries `fn` exactly once with the new key.
 * Every outcome — success, a failure that got a fresh key, or a failure with none left —
 * also records or clears a quota cooldown for the (providerId, model) pair via
 * {@link ProviderRegistry.cooldowns}, so Auto-mode routing and repeated sends both benefit
 * from the same signal without each call site tracking it separately.
 *
 * Precondition: `fn` must not have produced any user-visible output (streamed tokens, partial
 * UI state) before it can throw the failure this reacts to. This holds for every current
 * `ChatProvider` because each implementation checks `response.ok` and throws before it starts
 * reading the SSE stream (see `OpenAICompatibleProvider.streamChat`, `AnthropicProvider`,
 * `AntigravityProvider`) — a 401/403/429 is a rejected request, never a stream that started
 * and then failed mid-token. A future provider that streams before validating the response
 * would break this assumption and must not be wrapped here.
 */
export async function withProviderResilience<T>(
	registry: ProviderRegistry,
	providerId: string,
	model: string,
	fn: (apiKey: string) => Promise<T>,
): Promise<T> {
	const apiKey = (await registry.getApiKey(providerId)) ?? '';
	try {
		const result = await fn(apiKey);
		registry.noteApiKeySuccess(providerId);
		registry.cooldowns.clear(providerId, model);
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!KEY_FAILURE.test(message)) {
			throw err;
		}
		registry.cooldowns.markCooldown(providerId, model, message);
		const rotated = await registry.rotateApiKey(providerId);
		if (!rotated) {
			throw err;
		}
		const nextKey = (await registry.getApiKey(providerId)) ?? '';
		const result = await fn(nextKey);
		registry.noteApiKeySuccess(providerId);
		registry.cooldowns.clear(providerId, model);
		return result;
	}
}
```

- [ ] **Step 4: Compile and run the test**

Run:
```bash
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-provider-resilience.mjs
```
Expected: `All provider-resilience assertions passed.`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/providers/resilience.ts extensions/openvs-chat/scripts/test-provider-resilience.mjs
git commit -m "feat(openvs-chat): add withProviderResilience retry-with-rotation wrapper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Settings-panel UI for additional keys

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts` — add a `setExtraApiKeys` webview message handler next to the existing `setApiKey` handler (`chatViewProvider.ts:1292` and `:1574` — read both sites first; there appear to be two message-handling locations for API keys, so add the new case beside each, or consolidate if they already share a switch statement).
- Modify: `extensions/openvs-chat/src/providers/registry.ts` — `resolveAll()`/`resolve()` (registry.ts:248-286) should expose `extraApiKeyCount: number` on `ResolvedProviderConfig` so the panel can show "+2 backup keys" without a round trip; add the field and populate it via `(await this.getExtraApiKeys(id)).length`.
- Modify: `extensions/openvs-chat/media/main.js` — locate the API-key input rendering (`grep -n "setApiKey" extensions/openvs-chat/media/main.js`) and add a collapsed "Additional API keys" textarea (one key per line) beneath it, sending `{ type: 'setExtraApiKeys', provider: id, keys: text.split('\n') }` on blur/save, mirroring the existing `setApiKey` message shape exactly.
- Modify: `extensions/openvs-chat/media/webview.d.ts` — add the `setExtraApiKeys` message shape to whatever type alias documents `WebviewToHost` (the same one `setApiKey` is declared on).
- Test: extend `extensions/openvs-chat/scripts/test-webview.mjs` (the static host↔webview contract test — CLAUDE.md: "guards the host↔webview contract statically... if you add a message type or an element id, that test catches the half you forgot") with an assertion that `setExtraApiKeys` is handled on the host side and sent from `main.js`.

**Interfaces:**
- Consumes: `setExtraApiKeys`/`getExtraApiKeys` from Task 3.

- [ ] **Step 1: Read both existing `setApiKey` sites and `test-webview.mjs`'s assertion style**

Read `chatViewProvider.ts:1280-1300` and `:1565-1580`, and skim `test-webview.mjs` for how it asserts a message type is both sent and handled, before writing anything — the exact switch-statement shape must be matched, not guessed.

- [ ] **Step 2: Add the host-side handler(s)**

Mirror the existing `setApiKey` case exactly, substituting `registry.setExtraApiKeys(message.provider, message.keys)` (an array field, not a single `key` string).

- [ ] **Step 3: Add the webview UI**

Add the textarea and its save handler in `main.js`, following the existing API-key field's styling/DOM structure in the same panel section.

- [ ] **Step 4: Extend `test-webview.mjs`**

Add the same kind of assertion the existing test uses for `setApiKey` (message-type declared, sent, and handled) for `setExtraApiKeys`.

- [ ] **Step 5: Run the webview + typecheck suite**

Run:
```bash
npm run typecheck --prefix extensions/openvs-chat
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-webview.mjs
```
Expected: all pass.

- [ ] **Step 6: Manual check**

Launch the Extension Development Host (`F5` from the repo root, or `--extensionDevelopmentPath=extensions/openvs-chat`), open the Providers settings panel, add a primary key and two backup keys to any provider, reload the window, and confirm the backup keys are still listed (proves `SecretStorage` round-trips the JSON array correctly).

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts extensions/openvs-chat/src/providers/registry.ts extensions/openvs-chat/media/main.js extensions/openvs-chat/media/webview.d.ts extensions/openvs-chat/scripts/test-webview.mjs
git commit -m "feat(openvs-chat): add Additional API keys field to the Providers panel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire `withProviderResilience` into the plain chat + enhance-prompt paths

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts` — the two call sites at (as read in this plan's research) `handleEnhancePrompt` (around line 1628: `await provider.streamChat({...})`) and the main send handler (around line 1967 onward, wherever `provider.streamChat(...)` / `provider.runAgentStep(...)` is actually invoked using the `apiKey` resolved at line 1947 — read forward from line 1974 to find the actual call before editing).

**Interfaces:**
- Consumes: `withProviderResilience` from Task 4.

- [ ] **Step 1: Wrap `handleEnhancePrompt`'s call**

Replace:
```ts
await provider.streamChat({
	messages: [
		{ role: 'system', content: ENHANCE_SYSTEM },
		{ role: 'user', content: text },
	],
	model: model || this.registry.getModel(providerId),
	apiKey: apiKey ?? '',
	baseUrl: this.registry.getBaseUrl(providerId),
	maxTokens: this.registry.getMaxTokens(),
	signal: controller.signal,
	onToken: delta => { out += delta; },
});
```
with:
```ts
const resolvedModel = model || this.registry.getModel(providerId);
await withProviderResilience(this.registry, providerId, resolvedModel, key => provider.streamChat({
	messages: [
		{ role: 'system', content: ENHANCE_SYSTEM },
		{ role: 'user', content: text },
	],
	model: resolvedModel,
	apiKey: key,
	baseUrl: this.registry.getBaseUrl(providerId),
	maxTokens: this.registry.getMaxTokens(),
	signal: controller.signal,
	onToken: delta => { out += delta; },
}));
```
Add the import: `import { withProviderResilience } from './providers/resilience';` near the top of `chatViewProvider.ts`.

Note: this drops the now-unused `apiKey` local's only remaining use at line 1621 (`if (provider.info.requiresApiKey && !apiKey)`) — that guard stays as-is; only the `streamChat` call itself changes to source its key from `withProviderResilience`'s callback instead of the outer `apiKey` variable.

- [ ] **Step 2: Wrap the main send handler's call**

Read forward from line 1974 (`if (mode === 'agent' && !this.modelToolCapable(...))`) to find where `provider.streamChat(...)` (Ask/Plan mode) and wherever Agent mode's per-step `provider.runAgentStep(...)` call happens (likely delegated into `agentRunner.ts` — if the actual HTTP call for Agent mode is inside `agentRunner.runAgent(...)` rather than in `chatViewProvider.ts` directly, this call site belongs in Task 7 instead; confirm which file owns it before editing either).

Apply the same transformation as Step 1: wrap the call in `withProviderResilience(this.registry, providerId, model, key => provider.streamChat({ ...fields, apiKey: key }))`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --prefix extensions/openvs-chat`
Expected: no errors.

- [ ] **Step 4: Manual verification**

In the Extension Development Host, configure a provider with an intentionally invalid primary key and a valid backup key (`setExtraApiKeys`), send a chat message, and confirm the response still arrives (proves the rotation-and-retry path fires end-to-end, not just in the unit test's fake).

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "feat(openvs-chat): retry chat/enhance requests with a rotated key on 401/403/429

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire `withProviderResilience` into Agent mode's step loop (if not already covered by Task 6)

**Files:**
- Modify: `extensions/openvs-chat/src/agent/agentRunner.ts` — locate the `provider.runAgentStep(...)` call (search for `runAgentStep(` in the file) and the existing transient-retry logic around `isTransientProviderError`/`stepRetries`/`MAX_STEP_RETRIES` (`agentRunner.ts:678` per this plan's research).

**Interfaces:**
- Consumes: `withProviderResilience` from Task 4.

- [ ] **Step 1: Read the existing step-retry loop**

Read `agentRunner.ts` from where `stepRetries` is declared through the `isTransientProviderError` check at line 678, to see exactly how a step is retried today (it already has *a* retry mechanism, for transient errors — this task adds key rotation as a *first* response to a 401/403/429, before that existing transient-retry logic would otherwise just fail the step outright since a bad/quota'd key is not "transient" under `isTransientProviderError`'s `PERMANENT_PATTERNS`).

- [ ] **Step 2: Wrap the `runAgentStep` call**

Apply the same transformation pattern as Task 6: the call becomes
```ts
await withProviderResilience(registry, providerId, model, apiKey => provider.runAgentStep({ ...fields, apiKey }));
```
inside the same try/catch the existing transient-retry logic already wraps it in — `withProviderResilience` handles the 401/403/429 case internally (one retry with a rotated key) and re-throws unchanged for anything else, so the existing `isTransientProviderError`/`stepRetries` logic downstream is untouched for every other failure class.

Note: `agentRunner.ts` needs access to a `ProviderRegistry` instance here — check whether one is already threaded through (as a constructor field or a function parameter) before assuming it needs to be added; if it isn't currently available at this call site, that is itself worth flagging back rather than guessed at, since threading a new dependency through the agent loop is a bigger change than this task's stated scope.

- [ ] **Step 3: Typecheck + run the agent-loop test**

Run:
```bash
npm run typecheck --prefix extensions/openvs-chat
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-agent-loop.mjs
```
Expected: no errors, existing suite still passes (it stubs the tool layer, not the provider, so this change shouldn't affect it unless the stub also fakes `runAgentStep` failures — check).

- [ ] **Step 4: Commit**

```bash
git add extensions/openvs-chat/src/agent/agentRunner.ts
git commit -m "feat(openvs-chat): retry Agent-mode steps with a rotated key on 401/403/429

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire `withProviderResilience` into Auto orchestrator + commit-message generation

**Files:**
- Modify: `extensions/openvs-chat/src/auto/orchestrator.ts` — the call site at line 422 (`return (await this.registry.getApiKey(providerId)) ?? '';`) is itself a small helper feeding some downstream call; read enough surrounding context to find where the value it returns is actually used in a `streamChat`/`runAgentStep` call, and wrap THAT call, not this helper (wrapping the helper alone wouldn't have anywhere to retry).
- Modify: `extensions/openvs-chat/src/git/commitMessage.ts` — the call site at line 143 (`apiKey: (await registry.getApiKey(providerId)) ?? '',`) is inline in a request object literal; read the surrounding function to find the actual `provider.streamChat(...)` call it belongs to and wrap that call.

**Interfaces:**
- Consumes: `withProviderResilience` from Task 4.

- [ ] **Step 1: Fix `orchestrator.ts`**

Read `orchestrator.ts` around line 422 outward until the actual provider call is found; apply the Task 6 transformation there.

- [ ] **Step 2: Fix `commitMessage.ts`**

Read `commitMessage.ts` around line 143; apply the same transformation.

- [ ] **Step 3: Explicitly do NOT touch `inlineProvider.ts`**

`extensions/openvs-chat/src/completions/inlineProvider.ts:188` (`const apiKey = await this.registry.getApiKey(resolved.providerId) ?? '';`) must be left alone. `test-completion-isolation.mjs` statically forbids the completions path from picking up chat-path behavior it shouldn't inherit (see CLAUDE.md's "Non-interference constraints" section on `src/completions/`) — a completion whose cursor position may already be stale must not gain a retry-with-different-key round trip, which is exactly the kind of latency `COMPLETION_FETCH_OPTS`/`noteOnlyOpts` exist to avoid. Confirm `test-completion-isolation.mjs` still passes unmodified after this whole plan lands.

- [ ] **Step 4: Typecheck + run affected suites**

Run:
```bash
npm run typecheck --prefix extensions/openvs-chat
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-auto-router.mjs
node extensions/openvs-chat/scripts/test-commit-message.mjs
node extensions/openvs-chat/scripts/test-completion-isolation.mjs
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/auto/orchestrator.ts extensions/openvs-chat/src/git/commitMessage.ts
git commit -m "feat(openvs-chat): retry Auto-mode and commit-message requests with a rotated key

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Skip a cooling-down candidate in Auto-mode role routing

**Files:**
- Modify: `extensions/openvs-chat/src/auto/router.ts` — the candidate-ranking logic (search for where `NOT_AUTO_SELECTED_MODELS` at `router.ts:77` is applied as a filter — that is the ranking/filtering pass this task adds one more filter step to).
- Test: extend `extensions/openvs-chat/scripts/test-auto-router.mjs`.

**Interfaces:**
- Consumes: `registry.cooldowns.isCoolingDown(providerId, model)` from Task 3.

- [ ] **Step 1: Read the candidate ranking pass**

Read `router.ts` from `NOT_AUTO_SELECTED_MODELS`'s declaration through wherever it's consulted (likely inside `inferredPool()` or the scoring function `resolveRole()` calls) to find the exact filter chain a candidate goes through before `RoleAssignment.ready` is decided.

- [ ] **Step 2: Add the cooldown filter**

In that same filter chain, exclude a candidate `{providerId, model}` when `this.registry.cooldowns.isCoolingDown(providerId, model)` is true — but only when at least one *other* candidate remains after the exclusion. If cooling out every remaining candidate would leave none, keep the best-ranked one anyway rather than reporting `ready: false` — a stale cooldown producing one avoidable 429 is strictly better than Auto mode refusing to answer at all when every provider happens to be cooling down at once (mirrors the source project's own rule: "if every provider is cooling down the call raises... rather than the dispatcher spinning here" — but this codebase's Auto mode has no raise-and-retry loop, so degrading to "try anyway" instead of "refuse" is the right adaptation, not a literal port).

- [ ] **Step 3: Extend the test**

Add a case to `test-auto-router.mjs`: mark a candidate's (providerId, model) pair as cooling via a fake/stub `cooldowns.isCoolingDown`, confirm `resolveRole` picks the next-ranked candidate instead; and a second case where every candidate is cooling, confirming the best-ranked one is still returned with `ready: true` rather than `ready: false`.

- [ ] **Step 4: Run the test**

Run: `node extensions/openvs-chat/scripts/test-auto-router.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/auto/router.ts extensions/openvs-chat/scripts/test-auto-router.mjs
git commit -m "feat(openvs-chat): have Auto mode skip a cooling-down provider/model

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 2: Three new free OpenAI-compatible providers

Each of these three follows the exact shape of `extensions/openvs-chat/src/providers/mistral.ts` — a small subclass of `OpenAICompatibleProvider` declaring only `info` and any narrow override. None needs a new base-class feature; `OpenAICompatibleProvider` (Task-independent of Phase 1) already provides streaming, tool calls, `listModels`, and now (after Phase 1) benefits from key rotation and cooldown automatically, since those wrap the call site, not the provider.

### File Structure

- Create: `extensions/openvs-chat/src/providers/zai.ts`
- Create: `extensions/openvs-chat/src/providers/opencodeZen.ts`
- Create: `extensions/openvs-chat/src/providers/xkiro.ts`
- Modify: `extensions/openvs-chat/src/providers/registry.ts` — import and register all three in the constructor's provider list (`registry.ts:99`), and add their env-var entries to `ENV_VARS` (`registry.ts:30-41`) only if they read a well-known env var (none of the three ai-new sources document one, so skip this for all three — leave them settings/secret-only, matching e.g. `cloudflare`).
- Modify: `extensions/openvs-chat/package.json` — add `<id>.model`, `<id>.baseUrl`, `<id>.authUrl` config entries for each (copy the `mistral`/`kimi` block shape shown in this plan's research).
- Modify: `extensions/openvs-chat/package.nls.json` — matching description strings for each new key.
- Test: `extensions/openvs-chat/scripts/test-provider-messages.mjs` already exercises the OpenAI-compatible wire shape generically — extend it to include these three, OR confirm (read the file first) that it's parameterized over `OpenAICompatibleProvider` subclasses generically and picks up new ones without a per-provider edit.

### Interfaces

- Consumes: `OpenAICompatibleProvider` (existing, `openaiCompatible.ts`), `ModelEntry`/`ProviderInfo`/`shortToolCallId` (existing, `types.ts`/`toolCalls.ts`).
- Produces: `ZaiProvider`, `OpenCodeZenProvider`, `XkiroProvider` — each implementing `ChatProvider` via the base class, registered under ids `'zai'`, `'opencode_zen'`, `'xkiro'`.

---

### Task 10: `ZaiProvider`

**Files:**
- Create: `extensions/openvs-chat/src/providers/zai.ts`

- [ ] **Step 1: Write the provider**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for Z.AI (Zhipu)'s GLM models at `api.z.ai/api/paas/v4`, which speaks the OpenAI
 * Chat Completions shape. The `-flash` line (`glm-4.5-flash`, `glm-4.6-flash`) is free-forever
 * as of 2026, but metered by *concurrency* rather than a token budget — roughly one request in
 * flight at a time before the next earns a 429, which {@link apiFetch}'s rate-limit retry
 * absorbs the same way it does for every other free tier here. Z.AI's own `/models` catalog
 * lists only its paid `glm-4.5`..`glm-5.3` line; the free `-flash` variants are undocumented
 * there, so `suggestedModels` names them explicitly rather than relying on `listModels`
 * to surface them. Create a key at z.ai (console -> API keys).
 */
export class ZaiProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'zai',
		label: 'Z.AI (GLM)',
		suggestedModels: ['glm-4.6-flash', 'glm-4.5-flash', 'glm-4.6', 'glm-4.5'],
		apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
		requiresApiKey: true,
		supportsTools: true,
		// The catalog also serves non-chat GLM variants (embedding/vision-only checkpoints)
		// under names that don't share a common prefix with the chat line, so an empty list
		// (meaning "every model from this provider is assumed tool-capable") is the honest
		// default here rather than a pattern likely to exclude a valid chat model.
		toolModelPatterns: [],
		visionModelPatterns: ['glm-4\\.[5-9]v', 'glm-5'],
	};

	/**
	 * Z.AI's endpoint does not reliably honour `response_format: json_schema` (unverified
	 * beyond the source project's own note that it "does NOT appear" to enforce shape), so
	 * this stays on the base class's default request body rather than opting into a stricter
	 * ask the backend might ignore anyway.
	 */
}
```

- [ ] **Step 2: Register it**

In `registry.ts`, add the import and constructor entry:
```ts
import { ZaiProvider } from './zai';
```
and add `new ZaiProvider()` to the array at `registry.ts:99`.

- [ ] **Step 3: Add settings entries**

In `package.json`'s `contributes.configuration.properties`, add (matching the `kimi`/`mistral` block shape exactly):
```json
"openvsChat.zai.model": {
  "type": "string",
  "default": "glm-4.6-flash",
  "description": "%config.zai.model%"
},
"openvsChat.zai.baseUrl": {
  "type": "string",
  "default": "https://api.z.ai/api/paas/v4",
  "description": "%config.zai.baseUrl%"
},
"openvsChat.zai.authUrl": {
  "type": "string",
  "default": "",
  "description": "%config.authUrl%"
}
```
In `package.nls.json`, add:
```json
"config.zai.model": "Default model for the Z.AI (Zhipu GLM) provider. The -flash line is free-forever as of 2026 but limited to roughly one concurrent request.",
"config.zai.baseUrl": "Base URL for the Z.AI API."
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --prefix extensions/openvs-chat`
Expected: no errors.

- [ ] **Step 5: Manual verification**

In the Extension Development Host, add a Z.AI API key in the Providers panel, send a chat message with `glm-4.6-flash`, confirm a response streams back.

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/providers/zai.ts extensions/openvs-chat/src/providers/registry.ts extensions/openvs-chat/package.json extensions/openvs-chat/package.nls.json
git commit -m "feat(openvs-chat): add Z.AI (GLM) provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: `OpenCodeZenProvider`

**Files:**
- Create: `extensions/openvs-chat/src/providers/opencodeZen.ts`

- [ ] **Step 1: Write the provider**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for OpenCode Zen (`opencode.ai/zen`) — NOT the `opencode` CLI, a plain hosted
 * OpenAI-compatible API reachable with a `sk-` key and no billing setup for its free models.
 * Free-tier catalog membership rotates (a model retired without notice 404s every call until
 * `listModels` is re-checked), so `suggestedModels` names only what a companion project
 * measured as reliably free and complete as of 2026-08, and users should prefer `listModels`'s
 * live catalog over typing a name from memory.
 */
export class OpenCodeZenProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'opencode_zen',
		label: 'OpenCode Zen',
		suggestedModels: ['laguna-s-2.1-free', 'deepseek-v4-flash-free'],
		apiKeyUrl: 'https://opencode.ai/zen',
		requiresApiKey: true,
		supportsTools: true,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};
}
```

- [ ] **Step 2: Register it**

Same pattern as Task 10: import in `registry.ts`, add `new OpenCodeZenProvider()` to the constructor array.

- [ ] **Step 3: Add settings entries**

`package.json`:
```json
"openvsChat.opencode_zen.model": {
  "type": "string",
  "default": "laguna-s-2.1-free",
  "description": "%config.opencode_zen.model%"
},
"openvsChat.opencode_zen.baseUrl": {
  "type": "string",
  "default": "https://opencode.ai/zen/v1",
  "description": "%config.opencode_zen.baseUrl%"
},
"openvsChat.opencode_zen.authUrl": {
  "type": "string",
  "default": "",
  "description": "%config.authUrl%"
}
```
`package.nls.json`:
```json
"config.opencode_zen.model": "Default model for the OpenCode Zen provider. Free-tier catalog membership changes over time — check the live model list.",
"config.opencode_zen.baseUrl": "Base URL for the OpenCode Zen API."
```

- [ ] **Step 4: Typecheck, manual verification, commit** (same shape as Task 10 Steps 4-6)

```bash
git add extensions/openvs-chat/src/providers/opencodeZen.ts extensions/openvs-chat/src/providers/registry.ts extensions/openvs-chat/package.json extensions/openvs-chat/package.nls.json
git commit -m "feat(openvs-chat): add OpenCode Zen provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: `XkiroProvider`

**Files:**
- Create: `extensions/openvs-chat/src/providers/xkiro.ts`

- [ ] **Step 1: Write the provider**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for xkiro.com, a free-tier aggregator gateway speaking the OpenAI Chat Completions
 * shape. Its catalog lists far more models than its free plan actually serves — many answer
 * HTTP 403 ("requires real deposited balance") or HTTP 500 on anything beyond a small prompt —
 * so `suggestedModels` names only what a companion project measured as working at real prompt
 * sizes rather than the catalog's full list.
 */
export class XkiroProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'xkiro',
		label: 'Xkiro',
		suggestedModels: ['mistralai/mistral-medium-3.5'],
		apiKeyUrl: 'https://xkiro.com',
		requiresApiKey: true,
		supportsTools: true,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};
}
```

- [ ] **Step 2: Register it**

Same pattern as Task 10.

- [ ] **Step 3: Add settings entries**

`package.json`:
```json
"openvsChat.xkiro.model": {
  "type": "string",
  "default": "mistralai/mistral-medium-3.5",
  "description": "%config.xkiro.model%"
},
"openvsChat.xkiro.baseUrl": {
  "type": "string",
  "default": "https://xkiro.com/v1",
  "description": "%config.xkiro.baseUrl%"
},
"openvsChat.xkiro.authUrl": {
  "type": "string",
  "default": "",
  "description": "%config.authUrl%"
}
```
`package.nls.json`:
```json
"config.xkiro.model": "Default model for the Xkiro gateway provider. Its catalog lists many models its free plan does not actually serve — check the live model list before switching.",
"config.xkiro.baseUrl": "Base URL for the Xkiro API."
```

- [ ] **Step 4: Typecheck, manual verification, commit** (same shape as Task 10 Steps 4-6)

```bash
git add extensions/openvs-chat/src/providers/xkiro.ts extensions/openvs-chat/src/providers/registry.ts extensions/openvs-chat/package.json extensions/openvs-chat/package.nls.json
git commit -m "feat(openvs-chat): add Xkiro gateway provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Full compile + typecheck**

```bash
npm run typecheck-client
npm run typecheck --prefix extensions/openvs-chat
```
Expected: zero errors.

- [ ] **Step 2: Full test suite**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/run-tests.mjs
```
Expected: every suite passes, including the four new files from this plan and every pre-existing one (especially `test-webview.mjs`, `test-completion-isolation.mjs`, `test-auto-router.mjs`, `test-provider-messages.mjs`, `test-model-axes.mjs`).

- [ ] **Step 3: Manual smoke test in the Extension Development Host**

Launch with `F5`, open Settings → Providers, confirm Z.AI / OpenCode Zen / Xkiro rows render with model picker + API key field + base URL field (proves the generic, data-driven settings panel picked them up with no webview changes needed beyond Task 5's key-rotation UI). Add a key to one, send a chat message, confirm a response streams. Then add a bad primary key + a good backup key to any provider and confirm a send still succeeds via rotation.

- [ ] **Step 4: Update `CLAUDE.md`**

Add the three new provider ids to the bullet list of provider files under "extensions/openvs-chat architecture" → `src/providers/`, and a short mention of `KeyRotator`/`CooldownTracker`/`withProviderResilience` near the existing "Rate limits are not published..." / `RateLimitTracker` paragraph, following that paragraph's own density and style rather than adding a new subsection.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document key rotation, quota cooldown, and three new providers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Design rationale

This plan takes two ideas and three provider integrations from `AutomationScripts/ai/`, a Python multi-provider batch dispatcher for a job-scraper (analyzed in chat on 2026-09-03), and adapts them to `openvs-chat`'s single-session interactive architecture:

- **Taken:** per-provider API key round-robin on 429 (`ProviderManager.api_key_rotate`), and a quota-cooldown timestamp with a longer park for daily/monthly exhaustion (`ProviderManager.mark_quota_cooldown`, `QUOTA_COOLDOWN_SECONDS` / `DAILY_QUOTA_COOLDOWN_SECONDS`). Both are re-implemented in-memory/session-scoped rather than the source's cross-process `~/.qwen/provider_state.json`, because a VS Code extension has no multi-process concurrency problem to solve — that file existed so several scraper processes could agree on which key/cred was already exhausted, which does not apply here.
- **Taken:** three new OpenAI-compatible free-tier providers (Z.AI, OpenCode Zen, Xkiro) that fit the existing `OpenAICompatibleProvider` base with no new plumbing.
- **Deliberately NOT taken:** cross-process slot-lock concurrency (`~/.ai_slots/*.lock`), the sequential fill-up dispatcher (openvs-chat's existing per-request provider selection already serves the same purpose for a single session), and the `response_format` ask+verify schema guard (redundant with the existing tool-call robustness layer in `toolCalls.ts`).
- **Not covered by this plan:** the OAuth-CLI-proxy providers (Copilot, Grok, Kiro) and the Chrome-cookie provider (`web_gemini`) — see the companion plan `2026-09-03-provider-oauth-and-cookie-integrations.md` for those, which carry materially different risk and require a new device-flow authentication mechanism this plan does not build.
