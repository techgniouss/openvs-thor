# Antigravity (Google) Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, experimental `antigravity` chat provider to `openvs-chat` that signs into Google via the Antigravity IDE OAuth client and serves Google's internal CloudCode models (Claude/Gemini/GPT-OSS), with multi-account rotation and full Agent-mode support.

**Architecture:** Mirrors the existing `providers/chatgptBackend.ts` pattern — an OAuth-token transport that transforms a non-OpenAI wire format (Gemini `generateContent`) to/from the internal `ChatMessage` model. A lean multi-account pool (`AntigravityAccountStore`) owns credentials + rotation; a pure `geminiTransform.ts` owns the wire format; `AntigravityProvider` glues them and rotates accounts on HTTP 429. The provider is registered only when an experimental flag is on, and the first sign-in is gated by a modal ToS warning.

**Tech Stack:** TypeScript (VS Code extension), Node `http`/`crypto`, global `fetch`. Tests: `node:test` + `node:assert` run via `tsx`.

## Global Constraints

- Tabs, not spaces. Match the OpenVS copyright header already used in `extensions/openvs-chat/src/*`.
- No `any`/`unknown` unless unavoidable. `async`/`await` over `.then()`.
- Constructor-injected dependencies; never stub globals or `any`-cast fakes in tests.
- Keys/secrets live in VS Code `SecretStorage`, never plaintext `settings.json`.
- Public OAuth values (client_id, endpoints, scopes) may be code constants. `client_secret` resolution order: `ANTIGRAVITY_CLIENT_SECRET` env → SecretStorage → gitignored bundled file `extensions/openvs-chat/.secrets/antigravity.txt` (seeded into SecretStorage once on activation). Never a plaintext `settings.json` value; never committed. Only a `.example` + README are committed.
- `client_id` (public): `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
- Auth URL: `https://accounts.google.com/o/oauth2/v2/auth` · Token URL: `https://oauth2.googleapis.com/token`
- Loopback redirect: `http://localhost:51121/oauth-callback`
- Scopes: `https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs`
- Chat base URL default: `https://cloudcode-pa.googleapis.com`
- Models: `gemini-3-pro-high`, `gemini-3-pro-low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`
- Spoofed request headers: `User-Agent: antigravity/1.18.3 windows/amd64`, `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1`, `Client-Metadata` (JSON), `Authorization: Bearer <access>`, `Accept: text/event-stream`, `Content-Type: application/json`.
- Commit after every task. Do not run tests while there are compile errors.

---

### Task 0: Connectivity probe (build-gate, throwaway)

Verify the archived backend still responds before building anything. This script is **not shipped** and is deleted after the gate passes.

**Files:**
- Create: `extensions/openvs-chat/scripts/antigravity-probe.mjs` (throwaway)

**Interfaces:**
- Produces: nothing importable. A go/no-go decision only.

- [ ] **Step 1: Write the probe script**

```js
// extensions/openvs-chat/scripts/antigravity-probe.mjs
// Throwaway build-gate: proves the Antigravity OAuth + CloudCode endpoints still work.
// Run: ANTIGRAVITY_CLIENT_SECRET=<secret> node scripts/antigravity-probe.mjs
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET;
const REDIRECT = 'http://localhost:51121/oauth-callback';
const SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');
const BASE = 'https://cloudcode-pa.googleapis.com';

if (!SECRET) { console.error('Set ANTIGRAVITY_CLIENT_SECRET'); process.exit(2); }

const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());

function waitForCode() {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			const u = new URL(req.url, 'http://localhost:51121');
			if (u.pathname !== '/oauth-callback') { res.writeHead(404).end(); return; }
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<h2>Received. Return to the terminal.</h2>');
			server.close();
			resolve(u.searchParams.get('code'));
		});
		server.listen(51121, '127.0.0.1', () => {
			const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
			url.searchParams.set('client_id', CLIENT_ID);
			url.searchParams.set('redirect_uri', REDIRECT);
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('scope', SCOPES);
			url.searchParams.set('code_challenge', challenge);
			url.searchParams.set('code_challenge_method', 'S256');
			url.searchParams.set('access_type', 'offline');
			url.searchParams.set('prompt', 'consent');
			console.log('\nOpen this URL, approve, then wait:\n\n' + url.toString() + '\n');
		});
	});
}

const code = await waitForCode();
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		client_id: CLIENT_ID, client_secret: SECRET, code,
		grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: verifier,
	}).toString(),
});
const token = await tokenRes.json();
console.log('token exchange status', tokenRes.status);
if (!token.access_token) { console.error('FAILED at token exchange:', token); process.exit(1); }

const access = token.access_token;
const load = await fetch(`${BASE}/v1internal:loadCodeAssist`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
	body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'WINDOWS', pluginType: 'GEMINI' } }),
});
console.log('loadCodeAssist status', load.status);
const loadJson = await load.json().catch(() => ({}));
const project = typeof loadJson.cloudaicompanionProject === 'string'
	? loadJson.cloudaicompanionProject
	: loadJson.cloudaicompanionProject?.id;
console.log('projectId', project);

const gen = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json', Accept: 'text/event-stream',
		Authorization: `Bearer ${access}`,
		'User-Agent': 'antigravity/1.18.3 windows/amd64',
		'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
	},
	body: JSON.stringify({
		model: 'gemini-3-pro-low',
		project,
		request: {
			contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
		},
	}),
});
console.log('streamGenerateContent status', gen.status);
const text = await gen.text();
console.log('first 800 chars of body:\n', text.slice(0, 800));
process.exit(gen.status === 200 ? 0 : 1);
```

- [ ] **Step 2: Run the probe**

Run (from `extensions/openvs-chat`): `ANTIGRAVITY_CLIENT_SECRET='GOCSPX-…' node scripts/antigravity-probe.mjs`
Approve in the browser.
Expected on success: `streamGenerateContent status 200` and body containing SSE `data:` lines with a candidate.

- [ ] **Step 3: Decision gate**

- If token exchange returns `invalid_client` → the client_secret was revoked. **STOP**, report to the user.
- If `streamGenerateContent` returns 404/410/403 → the backend is gone/blocked. **STOP**, report to the user.
- If 200 with a completion → note the exact request body shape that worked (esp. whether `project` and `request.contents` nesting is required), then proceed. **Adjust Task 1/Task 4 bodies to match what actually worked** if it differs from this plan.

- [ ] **Step 4: Delete the probe and commit the gate result**

```bash
rm extensions/openvs-chat/scripts/antigravity-probe.mjs
git commit --allow-empty -m "chore: antigravity connectivity probe passed (backend live)"
```

---

### Task 1: `geminiTransform.ts` (pure wire-format functions) + tests

**Files:**
- Create: `extensions/openvs-chat/src/providers/geminiTransform.ts`
- Create: `extensions/openvs-chat/src/providers/geminiTransform.test.ts`
- Modify: `extensions/openvs-chat/package.json` (add `tsx` devDep + `test` script)

**Interfaces:**
- Consumes: `ChatMessage`, `ToolSpec`, `ToolCall` from `./types`.
- Produces:
  - `export interface GeminiPart { text?: string; inlineData?: { mimeType: string; data: string }; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> } }`
  - `export interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }`
  - `export interface GeminiRequestBody { contents: GeminiContent[]; systemInstruction?: { parts: GeminiPart[] }; generationConfig: { maxOutputTokens: number }; tools?: [{ functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }] }`
  - `export function toGeminiRequest(messages: ChatMessage[], tools: ToolSpec[] | undefined, maxTokens: number): GeminiRequestBody`
  - `export function parseGeminiCandidate(json: unknown): { text?: string; toolCall?: ToolCall }`

- [ ] **Step 1: Add test tooling to `package.json`**

Add to `devDependencies` (create the block if absent): `"tsx": "^4.19.2"`.
Add to `scripts`: `"test": "tsx --test src/**/*.test.ts"`.

- [ ] **Step 2: Write the failing test**

```ts
// extensions/openvs-chat/src/providers/geminiTransform.test.ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';
import { parseGeminiCandidate, toGeminiRequest } from './geminiTransform';

test('toGeminiRequest maps roles, system, images, tool results and tools', () => {
	const body = toGeminiRequest(
		[
			{ role: 'system', content: 'be terse' },
			{ role: 'user', content: 'hi', images: [{ mimeType: 'image/png', data: 'AAAA' }] },
			{ role: 'assistant', content: 'calling', toolCalls: [{ id: 'c1', name: 'ls', args: { path: '.' } }] },
			{ role: 'tool', content: 'file.txt', toolCallId: 'c1' },
		],
		[{ name: 'ls', description: 'list', parameters: { type: 'object', properties: {} } }],
		2048,
	);
	assert.deepStrictEqual(body, {
		contents: [
			{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { text: 'hi' }] },
			{ role: 'model', parts: [{ text: 'calling' }, { functionCall: { name: 'ls', args: { path: '.' } } }] },
			{ role: 'user', parts: [{ functionResponse: { name: 'ls', response: { output: 'file.txt' } } }] },
		],
		systemInstruction: { parts: [{ text: 'be terse' }] },
		generationConfig: { maxOutputTokens: 2048 },
		tools: [{ functionDeclarations: [{ name: 'ls', description: 'list', parameters: { type: 'object', properties: {} } }] }],
	});
});

test('parseGeminiCandidate extracts text', () => {
	const out = parseGeminiCandidate({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] });
	assert.deepStrictEqual(out, { text: 'hello' });
});

test('parseGeminiCandidate extracts functionCall', () => {
	const out = parseGeminiCandidate({ candidates: [{ content: { parts: [{ functionCall: { name: 'ls', args: { path: '.' } } }] } }] });
	assert.deepStrictEqual(out, { toolCall: { id: 'ls', name: 'ls', args: { path: '.' } } });
});

test('parseGeminiCandidate returns empty on no candidates', () => {
	assert.deepStrictEqual(parseGeminiCandidate({}), {});
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run (from `extensions/openvs-chat`): `npm test`
Expected: FAIL — cannot find module `./geminiTransform` (or exports undefined).

- [ ] **Step 4: Implement `geminiTransform.ts`**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage, ToolCall, ToolSpec } from './types';

/** A single Gemini content part (text, inline image, or a function call/response). */
export interface GeminiPart {
	text?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { name: string; args: Record<string, unknown> };
	functionResponse?: { name: string; response: Record<string, unknown> };
}

/** One turn in the Gemini `contents` array. Gemini uses `model` for assistant turns. */
export interface GeminiContent {
	role: 'user' | 'model';
	parts: GeminiPart[];
}

/** The request body posted to `:streamGenerateContent` (without the model/project envelope). */
export interface GeminiRequestBody {
	contents: GeminiContent[];
	systemInstruction?: { parts: GeminiPart[] };
	generationConfig: { maxOutputTokens: number };
	tools?: [{ functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }];
}

/** Builds Gemini request `contents` (+ systemInstruction/tools) from internal chat messages. */
export function toGeminiRequest(messages: ChatMessage[], tools: ToolSpec[] | undefined, maxTokens: number): GeminiRequestBody {
	const contents: GeminiContent[] = [];
	const systemParts: GeminiPart[] = [];
	for (const m of messages) {
		if (m.role === 'system') {
			if (m.content) {
				systemParts.push({ text: m.content });
			}
			continue;
		}
		if (m.role === 'tool') {
			contents.push({ role: 'user', parts: [{ functionResponse: { name: m.toolCallId ?? '', response: { output: m.content } } }] });
			continue;
		}
		if (m.role === 'assistant') {
			const parts: GeminiPart[] = [];
			if (m.content) {
				parts.push({ text: m.content });
			}
			for (const tc of m.toolCalls ?? []) {
				parts.push({ functionCall: { name: tc.name, args: tc.args } });
			}
			contents.push({ role: 'model', parts });
			continue;
		}
		// user
		const parts: GeminiPart[] = [];
		for (const img of m.images ?? []) {
			parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
		}
		if (m.content) {
			parts.push({ text: m.content });
		}
		contents.push({ role: 'user', parts });
	}

	const body: GeminiRequestBody = {
		contents,
		generationConfig: { maxOutputTokens: maxTokens },
	};
	if (systemParts.length) {
		body.systemInstruction = { parts: systemParts };
	}
	if (tools?.length) {
		body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
	}
	return body;
}

/**
 * Extracts text and/or a tool call from one streamed Gemini chunk. The `functionResponse`
 * name is used as the tool-call id, matching how {@link toGeminiRequest} maps tool results back.
 */
export function parseGeminiCandidate(json: unknown): { text?: string; toolCall?: ToolCall } {
	const parts = (json as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> })?.candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts)) {
		return {};
	}
	let text = '';
	let toolCall: ToolCall | undefined;
	for (const part of parts) {
		if (typeof part.text === 'string') {
			text += part.text;
		} else if (part.functionCall && typeof part.functionCall.name === 'string') {
			toolCall = { id: part.functionCall.name, name: part.functionCall.name, args: part.functionCall.args ?? {} };
		}
	}
	const out: { text?: string; toolCall?: ToolCall } = {};
	if (text) {
		out.text = text;
	}
	if (toolCall) {
		out.toolCall = toolCall;
	}
	return out;
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/providers/geminiTransform.ts extensions/openvs-chat/src/providers/geminiTransform.test.ts extensions/openvs-chat/package.json
git commit -m "feat(antigravity): pure Gemini wire-format transform + tests"
```

---

### Task 2: `AntigravityAccountStore` (accounts.ts) + tests

Lean multi-account pool with sticky rotation and cooldown. Kept free of the `vscode` module (uses a structural `SecretStorageLike`) so it is unit-testable.

**Files:**
- Create: `extensions/openvs-chat/src/antigravity/accounts.ts`
- Create: `extensions/openvs-chat/src/antigravity/accounts.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces:
  - `export interface SecretStorageLike { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; delete(key: string): Thenable<void>; }`
  - `export interface AntigravityAccount { id: string; email: string; refresh: string; projectId: string; access?: string; expires?: number; enabled: boolean; cooldownUntil?: number; cooldownReason?: string; }`
  - `export type RefreshFn = (refresh: string) => Promise<{ access: string; refresh: string; expires: number } | 'invalid'>;`
  - `export class AntigravityAccountStore` with:
    - `constructor(secrets: SecretStorageLike, refreshFn: RefreshFn, now?: () => number)`
    - `list(): Promise<AntigravityAccount[]>`
    - `add(account: Omit<AntigravityAccount, 'enabled'>): Promise<void>` (stored `enabled: true`)
    - `remove(id: string): Promise<void>`
    - `setEnabled(id: string, enabled: boolean): Promise<void>`
    - `current(): Promise<AntigravityAccount | undefined>` (first enabled, non-cooling account; else the soonest-available cooling one)
    - `next(): Promise<AntigravityAccount | undefined>` (advance the sticky pointer past the current account)
    - `markLimited(id: string, reason: string): Promise<void>` (exponential backoff cooldown, see Step 4)
    - `getFreshToken(account: AntigravityAccount): Promise<string>` (refresh via `refreshFn` when expired, re-persist)
    - `allCoolingUntil(): Promise<number | undefined>` (min `cooldownUntil` when every enabled account is cooling)

- [ ] **Step 1: Write the failing test**

```ts
// extensions/openvs-chat/src/antigravity/accounts.test.ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { test } from 'node:test';
import { AntigravityAccountStore, RefreshFn, SecretStorageLike } from './accounts';

function fakeSecrets(): SecretStorageLike {
	const map = new Map<string, string>();
	return {
		get: async k => map.get(k),
		store: async (k, v) => { map.set(k, v); },
		delete: async k => { map.delete(k); },
	};
}

const noRefresh: RefreshFn = async () => 'invalid';

test('add/list/remove round-trips accounts', async () => {
	const store = new AntigravityAccountStore(fakeSecrets(), noRefresh);
	await store.add({ id: 'a', email: 'a@x', refresh: 'r1', projectId: 'p1' });
	await store.add({ id: 'b', email: 'b@x', refresh: 'r2', projectId: 'p2' });
	assert.deepStrictEqual((await store.list()).map(a => a.id), ['a', 'b']);
	await store.remove('a');
	assert.deepStrictEqual((await store.list()).map(a => a.id), ['b']);
});

test('current skips disabled and cooling accounts; next advances', async () => {
	let clock = 1000;
	const store = new AntigravityAccountStore(fakeSecrets(), noRefresh, () => clock);
	await store.add({ id: 'a', email: 'a@x', refresh: 'r1', projectId: 'p1' });
	await store.add({ id: 'b', email: 'b@x', refresh: 'r2', projectId: 'p2' });
	assert.strictEqual((await store.current())?.id, 'a');
	await store.markLimited('a', 'quota');
	assert.strictEqual((await store.current())?.id, 'b');
	await store.setEnabled('b', false);
	// a still cooling, b disabled -> current falls back to soonest-available cooling (a)
	assert.strictEqual((await store.current())?.id, 'a');
});

test('getFreshToken refreshes when expired and re-persists', async () => {
	let clock = 10_000;
	const refreshFn: RefreshFn = async r => ({ access: 'NEW', refresh: r, expires: 999_999 });
	const store = new AntigravityAccountStore(fakeSecrets(), refreshFn, () => clock);
	await store.add({ id: 'a', email: 'a@x', refresh: 'r1', projectId: 'p1', access: 'OLD', expires: 0 });
	const acct = (await store.list())[0];
	assert.strictEqual(await store.getFreshToken(acct), 'NEW');
	assert.strictEqual((await store.list())[0].access, 'NEW');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./accounts`.

- [ ] **Step 3: Implement `accounts.ts`**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The subset of `vscode.SecretStorage` the store needs (kept structural so it is testable). */
export interface SecretStorageLike {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

/** One signed-in Google account in the rotation pool. */
export interface AntigravityAccount {
	id: string;
	email: string;
	refresh: string;
	projectId: string;
	access?: string;
	/** Absolute expiry of `access`, in ms since the epoch. */
	expires?: number;
	enabled: boolean;
	/** Absolute ms until which this account is skipped after a rate-limit/quota error. */
	cooldownUntil?: number;
	cooldownReason?: string;
}

/** Refreshes a Google access token from a refresh token, or reports the grant is dead. */
export type RefreshFn = (refresh: string) => Promise<{ access: string; refresh: string; expires: number } | 'invalid'>;

const STORAGE_KEY = 'openvsChat.antigravity.accounts';
const POINTER_KEY = 'openvsChat.antigravity.active';
/** Refresh when the access token has less than this long left. */
const EXPIRY_SLACK_MS = 60_000;
/** Cooldown backoff bounds for a rate-limited/quota-exhausted account. */
const COOLDOWN_MIN_MS = 30_000;
const COOLDOWN_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * Owns the multi-account pool for the Antigravity provider: persistence, sticky selection,
 * per-account cooldown after rate limits, and transparent token refresh.
 */
export class AntigravityAccountStore {
	constructor(
		private readonly secrets: SecretStorageLike,
		private readonly refreshFn: RefreshFn,
		private readonly now: () => number = () => Date.now(),
	) { }

	private async read(): Promise<AntigravityAccount[]> {
		const raw = await this.secrets.get(STORAGE_KEY);
		if (!raw) {
			return [];
		}
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed as AntigravityAccount[] : [];
		} catch {
			return [];
		}
	}

	private async write(accounts: AntigravityAccount[]): Promise<void> {
		await this.secrets.store(STORAGE_KEY, JSON.stringify(accounts));
	}

	async list(): Promise<AntigravityAccount[]> {
		return this.read();
	}

	async add(account: Omit<AntigravityAccount, 'enabled'>): Promise<void> {
		const accounts = await this.read();
		const existing = accounts.findIndex(a => a.id === account.id || a.email === account.email);
		const record: AntigravityAccount = { ...account, enabled: true };
		if (existing >= 0) {
			accounts[existing] = { ...record, enabled: accounts[existing].enabled };
		} else {
			accounts.push(record);
		}
		await this.write(accounts);
	}

	async remove(id: string): Promise<void> {
		await this.write((await this.read()).filter(a => a.id !== id));
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		const accounts = await this.read();
		const acct = accounts.find(a => a.id === id);
		if (acct) {
			acct.enabled = enabled;
			await this.write(accounts);
		}
	}

	/** Enabled accounts not currently cooling down, in stored order. */
	private healthy(accounts: AntigravityAccount[]): AntigravityAccount[] {
		const t = this.now();
		return accounts.filter(a => a.enabled && !(a.cooldownUntil && a.cooldownUntil > t));
	}

	async current(): Promise<AntigravityAccount | undefined> {
		const accounts = await this.read();
		const healthy = this.healthy(accounts);
		if (healthy.length) {
			const pointer = Number(await this.secrets.get(POINTER_KEY)) || 0;
			return healthy[pointer % healthy.length];
		}
		// Everything is cooling/disabled: fall back to the enabled account that recovers soonest.
		const cooling = accounts.filter(a => a.enabled).sort((x, y) => (x.cooldownUntil ?? 0) - (y.cooldownUntil ?? 0));
		return cooling[0];
	}

	async next(): Promise<AntigravityAccount | undefined> {
		const healthy = this.healthy(await this.read());
		if (!healthy.length) {
			return this.current();
		}
		const pointer = (Number(await this.secrets.get(POINTER_KEY)) || 0) + 1;
		await this.secrets.store(POINTER_KEY, String(pointer));
		return healthy[pointer % healthy.length];
	}

	async markLimited(id: string, reason: string): Promise<void> {
		const accounts = await this.read();
		const acct = accounts.find(a => a.id === id);
		if (!acct) {
			return;
		}
		// Exponential-ish backoff: quota exhaustion cools longer than a transient rate limit.
		const base = reason === 'quota' ? 60_000 : COOLDOWN_MIN_MS;
		const prev = acct.cooldownUntil && acct.cooldownUntil > this.now() ? acct.cooldownUntil - this.now() : 0;
		const wait = Math.min(Math.max(base, prev * 2), COOLDOWN_MAX_MS);
		acct.cooldownUntil = this.now() + wait;
		acct.cooldownReason = reason;
		await this.write(accounts);
	}

	async getFreshToken(account: AntigravityAccount): Promise<string> {
		if (account.access && account.expires && account.expires - EXPIRY_SLACK_MS > this.now()) {
			return account.access;
		}
		const refreshed = await this.refreshFn(account.refresh);
		if (refreshed === 'invalid') {
			throw new Error(`Google sign-in for ${account.email} expired. Re-add the account.`);
		}
		const accounts = await this.read();
		const stored = accounts.find(a => a.id === account.id);
		if (stored) {
			stored.access = refreshed.access;
			stored.refresh = refreshed.refresh;
			stored.expires = refreshed.expires;
			await this.write(accounts);
		}
		return refreshed.access;
	}

	async allCoolingUntil(): Promise<number | undefined> {
		const accounts = (await this.read()).filter(a => a.enabled);
		if (!accounts.length || this.healthy(accounts).length) {
			return undefined;
		}
		return Math.min(...accounts.map(a => a.cooldownUntil ?? 0));
	}
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test`
Expected: PASS (all tests across both files).

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/antigravity/accounts.ts extensions/openvs-chat/src/antigravity/accounts.test.ts
git commit -m "feat(antigravity): multi-account pool with sticky rotation + cooldown"
```

---

### Task 3: `antigravity/auth.ts` — OAuth sign-in + refresh

Interactive sign-in (loopback callback), token exchange, email + projectId resolution, and the `RefreshFn` the store consumes. Network/interactive — verified manually via Task 0's proven shapes, not unit tests.

**Files:**
- Create: `extensions/openvs-chat/src/antigravity/auth.ts`

**Interfaces:**
- Consumes: `AntigravityAccountStore`, `RefreshFn` from `./accounts`.
- Produces:
  - `export const ANTIGRAVITY_CLIENT_ID: string`
  - `export const ANTIGRAVITY_BASE_URL_DEFAULT = 'https://cloudcode-pa.googleapis.com'`
  - `export function makeRefreshFn(clientSecret: string): RefreshFn`
  - `export async function signInAntigravity(store: AntigravityAccountStore, clientSecret: string): Promise<string | undefined>` (returns the email added, or undefined on cancel)

- [ ] **Step 1: Implement `auth.ts`**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomUUID } from 'crypto';
import * as http from 'http';
import * as vscode from 'vscode';
import { AntigravityAccountStore, RefreshFn } from './accounts';

export const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const ANTIGRAVITY_BASE_URL_DEFAULT = 'https://cloudcode-pa.googleapis.com';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const CALLBACK_PORT = 51121;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth-callback`;
const SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const IDE_PLATFORM = process.platform === 'darwin' ? 'MACOS' : process.platform === 'win32' ? 'WINDOWS' : 'LINUX';

function base64url(buffer: Buffer): string {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns a `RefreshFn` bound to the given client secret, for the account store. */
export function makeRefreshFn(clientSecret: string): RefreshFn {
	return async refresh => {
		const res = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: ANTIGRAVITY_CLIENT_ID,
				client_secret: clientSecret,
				refresh_token: refresh,
				grant_type: 'refresh_token',
			}).toString(),
		});
		const json = await res.json().catch(() => ({} as Record<string, unknown>));
		if (res.status === 400 || res.status === 401 || res.status === 403) {
			return 'invalid';
		}
		const access = (json as { access_token?: unknown }).access_token;
		if (typeof access !== 'string') {
			throw new Error(`Could not refresh the Google sign-in (HTTP ${res.status}).`);
		}
		const expiresIn = (json as { expires_in?: number }).expires_in ?? 3600;
		const newRefresh = (json as { refresh_token?: string }).refresh_token ?? refresh;
		return { access, refresh: newRefresh, expires: Date.now() + expiresIn * 1000 };
	};
}

/** Resolves the Cloud AI Companion project id via loadCodeAssist. */
async function resolveProjectId(access: string): Promise<string> {
	const res = await fetch(`${ANTIGRAVITY_BASE_URL_DEFAULT}/v1internal:loadCodeAssist`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
		body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: IDE_PLATFORM, pluginType: 'GEMINI' } }),
	});
	const json = await res.json().catch(() => ({} as Record<string, unknown>));
	const project = (json as { cloudaicompanionProject?: unknown }).cloudaicompanionProject;
	if (typeof project === 'string') {
		return project;
	}
	if (project && typeof project === 'object' && typeof (project as { id?: unknown }).id === 'string') {
		return (project as { id: string }).id;
	}
	throw new Error('Could not resolve a Google Cloud project for this account.');
}

async function fetchEmail(access: string): Promise<string> {
	const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${access}` } });
	const json = await res.json().catch(() => ({} as Record<string, unknown>));
	return (json as { email?: string }).email ?? 'unknown';
}

/**
 * Runs the Google sign-in: opens the consent page, serves the loopback callback on
 * :51121, exchanges the code, resolves email + project id, and adds the account to the pool.
 */
export async function signInAntigravity(store: AntigravityAccountStore, clientSecret: string): Promise<string | undefined> {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	const state = base64url(randomBytes(16));

	const code = await waitForCallback(authorizeUrl(challenge, state), state);
	if (!code) {
		return undefined;
	}

	const tokenRes = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: ANTIGRAVITY_CLIENT_ID,
			client_secret: clientSecret,
			code,
			grant_type: 'authorization_code',
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}).toString(),
	});
	const token = await tokenRes.json().catch(() => ({} as Record<string, unknown>));
	const access = (token as { access_token?: unknown }).access_token;
	const refresh = (token as { refresh_token?: unknown }).refresh_token;
	if (typeof access !== 'string' || typeof refresh !== 'string') {
		throw new Error(`Google sign-in failed (HTTP ${tokenRes.status}): ${JSON.stringify((token as { error?: unknown }).error ?? token).slice(0, 200)}`);
	}
	const expiresIn = (token as { expires_in?: number }).expires_in ?? 3600;

	const [email, projectId] = await Promise.all([fetchEmail(access), resolveProjectId(access)]);
	await store.add({ id: randomUUID(), email, refresh, projectId, access, expires: Date.now() + expiresIn * 1000 });
	return email;
}

function authorizeUrl(challenge: string, state: string): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', SCOPES);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	return url.toString();
}

/** Serves the OAuth redirect on :51121 for one sign-in and resolves with the code. */
function waitForCallback(url: string, expectedState: string): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve, reject) => {
		let settled = false;
		const server = http.createServer((req, res) => {
			const requestUrl = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
			if (requestUrl.pathname !== '/oauth-callback') {
				res.writeHead(404).end();
				return;
			}
			const error = requestUrl.searchParams.get('error');
			const code = requestUrl.searchParams.get('code');
			const state = requestUrl.searchParams.get('state');
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<html><body style="font-family:sans-serif"><h2>Sign-in received</h2><p>You can close this window and return to the editor.</p></body></html>');
			finish(() => {
				if (error) {
					reject(new Error(`Google sign-in was rejected: ${error}`));
				} else if (!code || state !== expectedState) {
					reject(new Error('Google sign-in returned an invalid callback.'));
				} else {
					resolve(code);
				}
			});
		});

		const timer = setTimeout(() => finish(() => reject(new Error('Sign-in timed out. Please try again.'))), SIGN_IN_TIMEOUT_MS);

		function finish(complete: () => void): void {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			server.close();
			complete();
		}

		server.on('error', (err: NodeJS.ErrnoException) => {
			finish(() => reject(err.code === 'EADDRINUSE'
				? new Error(`Port ${CALLBACK_PORT} is in use. Close whatever holds it and try again.`)
				: err));
		});

		server.listen(CALLBACK_PORT, '127.0.0.1', () => {
			vscode.env.openExternal(vscode.Uri.parse(url)).then(opened => {
				if (!opened) {
					finish(() => reject(new Error('Could not open the sign-in page in a browser.')));
				}
			});
		});

		void vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Waiting for Google sign-in in the browser…', cancellable: true },
			(_progress, cancel) => new Promise<void>(done => {
				cancel.onCancellationRequested(() => finish(() => resolve(undefined)));
				const poll = setInterval(() => {
					if (settled) {
						clearInterval(poll);
						done();
					}
				}, 250);
			}),
		);
	});
}
```

- [ ] **Step 2: Type-check the extension**

Run (from repo root): `npm run gulp compile-extensions`
Expected: no TypeScript errors in `openvs-chat`.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/antigravity/auth.ts
git commit -m "feat(antigravity): Google OAuth sign-in, refresh, and project resolution"
```

---

### Task 4: `providers/antigravity.ts` — the provider

Rotation-aware `ChatProvider`. Builds the request envelope, sends spoofed IDE headers, streams SSE, and rotates accounts on 429 before the first token.

**Files:**
- Create: `extensions/openvs-chat/src/providers/antigravity.ts`

**Interfaces:**
- Consumes: `AntigravityAccountStore` (`./antigravity/accounts` → from providers dir: `../antigravity/accounts`), `ANTIGRAVITY_BASE_URL_DEFAULT` from `../antigravity/auth`, `toGeminiRequest`/`parseGeminiCandidate` from `./geminiTransform`, `apiFetch`/`readSSE`/`describeHttpError`/types from `./types`.
- Produces: `export class AntigravityProvider implements ChatProvider` (constructor `(store: AntigravityAccountStore, baseUrlGetter: () => string)`).

- [ ] **Step 1: Implement `antigravity.ts`**

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AntigravityAccount, AntigravityAccountStore } from '../antigravity/accounts';
import { ANTIGRAVITY_BASE_URL_DEFAULT } from '../antigravity/auth';
import { parseGeminiCandidate, toGeminiRequest } from './geminiTransform';
import {
	AgentRequest, AgentStep, ChatProvider, ChatRequest, ModelEntry, ProviderInfo, ToolCall,
	apiFetch, describeHttpError, readSSE,
} from './types';

const MODELS = ['gemini-3-pro-high', 'gemini-3-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];
const IDE_PLATFORM = process.platform === 'darwin' ? 'darwin/arm64' : process.platform === 'win32' ? 'windows/amd64' : 'linux/amd64';
const IDE_VERSION = '1.18.3';

/** Headers that identify the request as the Antigravity IDE, plus auth. */
function ideHeaders(access: string): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'Accept': 'text/event-stream',
		'Authorization': `Bearer ${access}`,
		'User-Agent': `antigravity/${IDE_VERSION} ${IDE_PLATFORM}`,
		'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
		'Client-Metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', ideVersion: IDE_VERSION, pluginType: 'GEMINI' }),
	};
}

/**
 * Provider for Google's Antigravity/CloudCode gateway. Owns account rotation: on a 429 it
 * cools the current account and retries with the next healthy one (before any token is
 * emitted). Uses OAuth tokens from {@link AntigravityAccountStore}, not `request.apiKey`.
 */
export class AntigravityProvider implements ChatProvider {
	readonly info: ProviderInfo = {
		id: 'antigravity',
		label: 'Antigravity (Google)',
		suggestedModels: MODELS,
		apiKeyUrl: 'https://github.com/NoeFabris/opencode-antigravity-auth',
		requiresApiKey: false,
		supportsTools: true,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};

	constructor(
		private readonly store: AntigravityAccountStore,
		private readonly baseUrlGetter: () => string,
	) { }

	async listModels(): Promise<ModelEntry[]> {
		return MODELS.map(id => ({ id, toolCapable: true }));
	}

	async streamChat(request: ChatRequest): Promise<void> {
		const body = toGeminiRequest(request.messages, undefined, request.maxTokens);
		await this.send(request.model, body, request.signal, request.onToken);
	}

	async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		const body = toGeminiRequest(request.messages, request.tools, request.maxTokens);
		let content = '';
		const toolCalls: ToolCall[] = [];
		await this.send(request.model, body, request.signal, delta => { content += delta; request.onToken?.(delta); }, tc => toolCalls.push(tc));
		return { content, toolCalls };
	}

	/** Sends one request, rotating accounts on 429 until the pool is exhausted. */
	private async send(
		model: string,
		requestBody: object,
		signal: AbortSignal,
		onToken?: (delta: string) => void,
		onToolCall?: (tc: ToolCall) => void,
	): Promise<void> {
		const baseUrl = (this.baseUrlGetter() || ANTIGRAVITY_BASE_URL_DEFAULT).replace(/\/+$/, '');
		const url = `${baseUrl}/v1internal:streamGenerateContent?alt=sse`;
		const accounts = await this.store.list();
		const attempts = Math.max(1, accounts.filter(a => a.enabled).length);
		let lastError: unknown;

		for (let i = 0; i < attempts; i++) {
			const account = await this.store.current();
			if (!account) {
				throw new Error('No Google account is signed in. Add one from the OpenVS Thor panel.');
			}
			const until = await this.store.allCoolingUntil();
			if (until) {
				const secs = Math.ceil((until - Date.now()) / 1000);
				throw new Error(`All ${attempts} Antigravity account(s) are rate-limited. Next available in ~${secs}s.`);
			}

			const access = await this.store.getFreshToken(account);
			const envelope = { model, project: account.projectId, request: requestBody };
			const response = await apiFetch(url, {
				method: 'POST',
				headers: ideHeaders(access),
				body: JSON.stringify(envelope),
			}, signal, { retries: 1 });

			if (response.status === 429) {
				await this.store.markLimited(account.id, 'quota');
				await this.store.next();
				lastError = new Error(await describeHttpError(this.info.label, response));
				continue;
			}
			if (response.status === 404 || response.status === 410) {
				throw new Error(`${this.info.label}: the Antigravity backend returned HTTP ${response.status}. Google may have shut this endpoint down.`);
			}
			if (!response.ok) {
				throw new Error(await describeHttpError(this.info.label, response));
			}

			await readSSE(response, data => {
				let json: unknown;
				try {
					json = JSON.parse(data);
				} catch {
					return;
				}
				const { text, toolCall } = parseGeminiCandidate(json);
				if (text) {
					onToken?.(text);
				}
				if (toolCall) {
					onToolCall?.(toolCall);
				}
			}, signal);
			return;
		}
		throw lastError ?? new Error(`${this.info.label}: request failed.`);
	}
}

// Referenced so tsc keeps the type import when only used structurally above.
export type { AntigravityAccount };
```

> Note: if Task 0 found the working request envelope differs (e.g. no `project` field, or `contents` at top level instead of under `request`), adjust the `envelope` object here to match exactly what returned 200.

- [ ] **Step 2: Type-check the extension**

Run (from repo root): `npm run gulp compile-extensions`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/providers/antigravity.ts
git commit -m "feat(antigravity): rotation-aware Gemini/CloudCode chat provider"
```

---

### Task 5: Registry wiring + `package.json`/`package.nls.json` contributions

Register the provider only when enabled, teach the registry the antigravity credential branch, and contribute settings + commands.

**Files:**
- Modify: `extensions/openvs-chat/src/providers/registry.ts`
- Modify: `extensions/openvs-chat/package.json`
- Modify: `extensions/openvs-chat/package.nls.json`

**Interfaces:**
- Consumes: `AntigravityProvider`, `AntigravityAccountStore`, `makeRefreshFn`, `ANTIGRAVITY_BASE_URL_DEFAULT`.
- Produces: `registry.antigravity` (the shared `AntigravityAccountStore`, read `public readonly`), and a `registry.getAntigravityClientSecret(): Promise<string | undefined>` helper reused by `extension.ts`.

- [ ] **Step 1: Add imports + store construction in `registry.ts`**

At the top with the other provider imports:

```ts
import { AntigravityAccountStore } from '../antigravity/accounts';
import { makeRefreshFn, ANTIGRAVITY_BASE_URL_DEFAULT } from '../antigravity/auth';
import { AntigravityProvider } from './antigravity';
```

Add a secret-storage key constant near `SECRET_PREFIX`:

```ts
const ANTIGRAVITY_SECRET_KEY = 'openvsChat.antigravity.clientSecret';
```

- [ ] **Step 2: Build the store + conditionally register the provider**

Replace the constructor body's provider loop with a version that also wires antigravity:

```ts
	readonly antigravity: AntigravityAccountStore;

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.oauth = new OAuthTokenStore(secrets);
		this.antigravity = new AntigravityAccountStore(
			secrets,
			async refresh => {
				const secret = await this.getAntigravityClientSecret();
				if (!secret) {
					return 'invalid';
				}
				return makeRefreshFn(secret)(refresh);
			},
		);
		const providers: ChatProvider[] = [
			new NvidiaProvider(), new OpenAIProvider(), new AnthropicProvider(),
			new OpenRouterProvider(), new KimiProvider(), new QwenProvider(), new CustomProvider(),
		];
		if (vscode.workspace.getConfiguration('openvsChat').get<boolean>('antigravity.enabled')) {
			providers.push(new AntigravityProvider(this.antigravity, () => this.getBaseUrl('antigravity') || ANTIGRAVITY_BASE_URL_DEFAULT));
		}
		for (const provider of providers) {
			this.providers.set(provider.info.id, provider);
		}
	}
```

- [ ] **Step 3: Add the client-secret accessor**

```ts
	/** The Antigravity app-identity secret from env or SecretStorage (never plaintext settings). */
	async getAntigravityClientSecret(): Promise<string | undefined> {
		return process.env.ANTIGRAVITY_CLIENT_SECRET || (await this.secrets.get(ANTIGRAVITY_SECRET_KEY)) || undefined;
	}

	/** Stores the Antigravity client secret securely. */
	async setAntigravityClientSecret(secret: string): Promise<void> {
		await this.secrets.store(ANTIGRAVITY_SECRET_KEY, secret);
	}
```

- [ ] **Step 4: Teach credential methods the antigravity branch**

In `getApiKey`, before the `secrets.get(SECRET_PREFIX + id)` lookup:

```ts
		if (id === 'antigravity') {
			const account = await this.antigravity.current();
			return account ? this.antigravity.getFreshToken(account) : undefined;
		}
```

In `hasCredentials`, at the top:

```ts
		if (id === 'antigravity') {
			return (await this.antigravity.list()).length > 0;
		}
```

In `getAuthKind`, at the top:

```ts
		if (id === 'antigravity') {
			return (await this.antigravity.list()).length > 0 ? 'oauth' : 'none';
		}
```

- [ ] **Step 5: Add settings + commands to `package.json`**

In `contributes.configuration.properties`, add:

```json
        "openvsChat.antigravity.enabled": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "%config.antigravity.enabled%"
        },
        "openvsChat.antigravity.baseUrl": {
          "type": "string",
          "default": "https://cloudcode-pa.googleapis.com",
          "description": "%config.antigravity.baseUrl%"
        },
        "openvsChat.antigravity.model": {
          "type": "string",
          "default": "gemini-3-pro-low",
          "description": "%config.antigravity.model%"
        },
        "openvsChat.antigravity.rotationStrategy": {
          "type": "string",
          "enum": ["sticky"],
          "default": "sticky",
          "description": "%config.antigravity.rotationStrategy%"
        },
```

In `contributes.commands`, add:

```json
      {
        "command": "openvsChat.antigravity.addAccount",
        "title": "%commands.antigravity.addAccount%",
        "category": "OpenVS Thor"
      },
      {
        "command": "openvsChat.antigravity.manageAccounts",
        "title": "%commands.antigravity.manageAccounts%",
        "category": "OpenVS Thor"
      },
```

In `contributes.menus.commandPalette`, add both commands with `"when": "config.openvsChat.antigravity.enabled"`.

- [ ] **Step 6: Add the NLS strings to `package.nls.json`**

```json
  "config.antigravity.enabled": "⚠️ EXPERIMENTAL. Enable the Antigravity (Google) provider, which uses an unofficial Google client to reach Claude/Gemini models. This VIOLATES Google's Terms of Service and can get your Google account suspended. Off by default. Requires a window reload to take effect.",
  "config.antigravity.baseUrl": "Base URL for the Antigravity CloudCode gateway.",
  "config.antigravity.model": "Default Antigravity model.",
  "config.antigravity.rotationStrategy": "How to pick among multiple signed-in Google accounts.",
  "commands.antigravity.addAccount": "Antigravity: Add Google Account",
  "commands.antigravity.manageAccounts": "Antigravity: Manage Google Accounts"
```

- [ ] **Step 7: Type-check + verify settings load**

Run (from repo root): `npm run gulp compile-extensions`
Expected: no errors. (Manual: with the flag off, the provider must not appear; with it on + reload, it appears.)

- [ ] **Step 8: Commit**

```bash
git add extensions/openvs-chat/src/providers/registry.ts extensions/openvs-chat/package.json extensions/openvs-chat/package.nls.json
git commit -m "feat(antigravity): register provider behind experimental flag + contribute settings"
```

---

### Task 6: `extension.ts` — sign-in commands with modal ToS gate

**Files:**
- Modify: `extensions/openvs-chat/src/extension.ts`

**Interfaces:**
- Consumes: `signInAntigravity` from `./antigravity/auth`; `registry` (the `ProviderRegistry` created in `activate`).
- Produces: the registered commands `openvsChat.antigravity.addAccount` and `openvsChat.antigravity.manageAccounts`.

- [ ] **Step 1: Import the sign-in flow**

Add near the other imports (note `fs`/`path` for the seed step):

```ts
import * as fs from 'fs';
import * as path from 'path';
import { signInAntigravity } from './antigravity/auth';
```

- [ ] **Step 1a: Scaffold the gitignored secret file**

```bash
mkdir -p extensions/openvs-chat/.secrets
printf 'GOCSPX-REPLACE-WITH-PUBLIC-VALUE\n' > extensions/openvs-chat/.secrets/antigravity.txt.example
cat > extensions/openvs-chat/.secrets/README.md <<'EOF'
# .secrets

`antigravity.txt` holds the Antigravity Google OAuth client secret used for the
experimental `antigravity` provider. It is **gitignored** — never commit it.

Zero-prompt setup: copy the example and paste the public value:

    cp antigravity.txt.example antigravity.txt
    # edit antigravity.txt to contain the real GOCSPX-… value

On activation the extension seeds this into SecretStorage once, so sign-in never prompts.
The value is a Google *desktop-client* secret (not truly confidential) and is already
public in the archived upstream repo. Keeping it out of git is deliberate.
EOF
```

Append to the repo-root `.gitignore` (create the lines if absent):

```
# openvs-chat experimental antigravity secret (never commit)
extensions/openvs-chat/.secrets/*
!extensions/openvs-chat/.secrets/*.example
!extensions/openvs-chat/.secrets/README.md
```

Also add to `extensions/openvs-chat/.vscodeignore` (so a packaged .vsix never ships it) — create the file if absent:

```
.secrets/antigravity.txt
```

Locally (NOT committed) create the real file so sign-in is zero-prompt in the dev host:

```bash
cp extensions/openvs-chat/.secrets/antigravity.txt.example extensions/openvs-chat/.secrets/antigravity.txt
# then edit antigravity.txt to contain the real GOCSPX-… value
```

Verify it is ignored (must print nothing):

```bash
git status --porcelain extensions/openvs-chat/.secrets/antigravity.txt
```

- [ ] **Step 1b: Seed SecretStorage from the bundled file on activation**

In `activate`, right after the `ProviderRegistry` is created, add:

```ts
	// Zero-prompt Antigravity: seed the client secret from the gitignored bundled file once.
	void (async () => {
		if (await registry.getAntigravityClientSecret()) {
			return;
		}
		try {
			const file = path.join(context.extensionPath, '.secrets', 'antigravity.txt');
			const value = fs.readFileSync(file, 'utf8').trim();
			if (value && !value.startsWith('GOCSPX-REPLACE')) {
				await registry.setAntigravityClientSecret(value);
			}
		} catch {
			// No bundled file: fall back to the one-time prompt in add-account.
		}
	})();
```

- [ ] **Step 2: Register the commands in `activate`**

Add alongside the other `context.subscriptions.push(vscode.commands.registerCommand(...))` calls (use the `registry` variable created in `activate`):

```ts
	context.subscriptions.push(vscode.commands.registerCommand('openvsChat.antigravity.addAccount', async () => {
		const consent = await vscode.window.showWarningMessage(
			'Add a Google account for Antigravity models?',
			{
				modal: true,
				detail: 'This uses an UNOFFICIAL Google client to reach Claude/Gemini models. It VIOLATES Google’s Terms of Service and may get the Google account you sign in with SUSPENDED. The upstream project was archived, so the service may stop working at any time. Only continue if you accept these risks.',
			},
			'I Understand, Continue',
		);
		if (consent !== 'I Understand, Continue') {
			return;
		}

		let secret = await registry.getAntigravityClientSecret();
		if (!secret) {
			const entered = await vscode.window.showInputBox({
				title: 'Antigravity client secret',
				prompt: 'Paste the Antigravity OAuth client secret (the GOCSPX-… value). Stored securely in SecretStorage; never written to settings.',
				password: true,
				ignoreFocusOut: true,
			});
			if (!entered?.trim()) {
				return;
			}
			secret = entered.trim();
			await registry.setAntigravityClientSecret(secret);
		}

		try {
			const email = await signInAntigravity(registry.antigravity, secret);
			if (email) {
				void vscode.window.showInformationMessage(`Added Google account ${email} for Antigravity.`);
			}
		} catch (err) {
			void vscode.window.showErrorMessage(`Antigravity sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('openvsChat.antigravity.manageAccounts', async () => {
		const accounts = await registry.antigravity.list();
		if (!accounts.length) {
			void vscode.window.showInformationMessage('No Google accounts added yet. Run "Antigravity: Add Google Account".');
			return;
		}
		const pick = await vscode.window.showQuickPick(
			accounts.map(a => ({ label: a.email, description: a.enabled ? 'enabled' : 'disabled', id: a.id, enabled: a.enabled })),
			{ title: 'Antigravity accounts — pick one to toggle or remove' },
		);
		if (!pick) {
			return;
		}
		const action = await vscode.window.showQuickPick(
			[pick.enabled ? 'Disable' : 'Enable', 'Remove'],
			{ title: pick.label },
		);
		if (action === 'Remove') {
			await registry.antigravity.remove(pick.id);
		} else if (action === 'Enable') {
			await registry.antigravity.setEnabled(pick.id, true);
		} else if (action === 'Disable') {
			await registry.antigravity.setEnabled(pick.id, false);
		}
	}));
```

> If `registry` is not the variable name used in `activate`, use whatever the `ProviderRegistry` instance is called there (check the top of `activate`).

- [ ] **Step 3: Type-check the extension**

Run (from repo root): `npm run gulp compile-extensions`
Expected: no errors.

- [ ] **Step 4: Manual verification (Extension Development Host)**

1. Set `openvsChat.antigravity.enabled: true`, reload the window.
2. Run "Antigravity: Add Google Account" → confirm the modal warning appears and blocks until consent.
3. Consent → enter the client secret → complete Google sign-in → see the "Added …" toast.
4. Select the `antigravity` provider, pick `gemini-3-pro-low`, send a chat → tokens stream.
5. Switch to Agent mode → confirm a tool call round-trips.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/extension.ts
git commit -m "feat(antigravity): add-account (modal ToS gate) and manage-accounts commands"
```

---

### Task 7: Webview panel integration (account UI + caution banner)

Surface account management in the settings panel and show the risk banner. This integrates with the large existing webview; follow the established provider-row pattern rather than inventing new UI.

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts`
- Modify: `extensions/openvs-chat/media/main.js`

**Interfaces:**
- Consumes: the existing webview message protocol (host ↔ `media/main.js`) and `registry.antigravity`.
- Produces: two new inbound webview messages handled by the host — `{ type: 'antigravityAddAccount' }` and `{ type: 'antigravityManageAccounts' }` — plus account data included in the settings payload.

- [ ] **Step 1: Read the existing settings/provider-row rendering**

Before editing, read these to learn the exact pattern and message names:
- In `chatViewProvider.ts`: the handler that builds the settings payload (search for `resolveAll` and where provider config is posted to the webview), and the inbound `onDidReceiveMessage` switch (search for existing `type ===` cases like `signIn` / `clearKey`).
- In `media/main.js`: how a provider row and its buttons (e.g. the existing "Sign in") are rendered and how they `postMessage` back.

- [ ] **Step 2: Include antigravity account data in the settings payload**

Where the host posts resolved provider configs to the webview, when `antigravity` is among them, attach the account list. Add to that payload object:

```ts
	// alongside the existing provider config payload
	antigravityAccounts: (await this.registry.antigravity.list()).map(a => ({ email: a.email, enabled: a.enabled, id: a.id })),
	antigravityEnabled: vscode.workspace.getConfiguration('openvsChat').get<boolean>('antigravity.enabled') ?? false,
```

- [ ] **Step 3: Handle the two new inbound messages**

In the `onDidReceiveMessage` switch, add cases that delegate to the commands from Task 6 (so the modal + flow live in one place), then refresh the settings payload:

```ts
			case 'antigravityAddAccount':
				await vscode.commands.executeCommand('openvsChat.antigravity.addAccount');
				await this.postSettings(); // use whatever method re-posts the settings payload
				break;
			case 'antigravityManageAccounts':
				await vscode.commands.executeCommand('openvsChat.antigravity.manageAccounts');
				await this.postSettings();
				break;
```

> Replace `this.postSettings()` with the actual method that re-sends settings to the webview (found in Step 1).

- [ ] **Step 4: Render the account UI + banner in `media/main.js`**

In the antigravity provider row (only when `antigravityEnabled`), render below the model picker:

```js
// caution banner
const banner = document.createElement('div');
banner.className = 'antigravity-warning';
banner.textContent = '⚠ Unofficial Google access — violates Google’s ToS and can get your account suspended.';

// add-account button
const addBtn = document.createElement('button');
addBtn.textContent = '＋ Add Google account';
addBtn.addEventListener('click', () => vscode.postMessage({ type: 'antigravityAddAccount' }));

// account list
const list = document.createElement('div');
for (const acct of (settings.antigravityAccounts || [])) {
	const row = document.createElement('div');
	row.textContent = `${acct.email} — ${acct.enabled ? 'enabled' : 'disabled'}`;
	list.appendChild(row);
}

// manage button
const manageBtn = document.createElement('button');
manageBtn.textContent = 'Manage accounts';
manageBtn.addEventListener('click', () => vscode.postMessage({ type: 'antigravityManageAccounts' }));
```

Add a minimal style for `.antigravity-warning` (reuse an existing warning/error CSS class in `media/` if one exists — check first):

```css
.antigravity-warning { color: var(--vscode-errorForeground); font-size: 0.85em; margin: 4px 0; }
```

- [ ] **Step 5: Type-check + manual verification**

Run (from repo root): `npm run gulp compile-extensions`
Expected: no errors.
Manual (Extension Development Host, flag on): open the settings panel → the antigravity row shows the banner, "＋ Add Google account", the account list, and "Manage accounts"; clicking them drives the Task 6 flows and the list refreshes.

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts extensions/openvs-chat/media/main.js
git commit -m "feat(antigravity): account management UI + ToS caution banner in panel"
```

---

## Self-Review

**Spec coverage:**
- Credential handling (env/SecretStorage, no plaintext) → Task 5 Step 3, Task 6 Step 2. ✓
- Multi-account rotation → Task 2 (store) + Task 4 (rotation on 429). ✓
- Agent mode → Task 1 tools transform + Task 4 `runAgentStep`. ✓
- OAuth flow (loopback :51121, PKCE, exchange, projectId) → Task 3. ✓
- Gated registration + modal warning + banner → Task 5 / Task 6 / Task 7. ✓
- Static model list → Task 4 `listModels`. ✓
- Error handling (invalid_client, 404/410, all-cooling) → Task 3 refresh, Task 4 `send`, Task 2 `allCoolingUntil`. ✓
- Connectivity probe build-gate → Task 0. ✓
- Testing (transform + store units, manual for network/UI) → Task 1, Task 2, manual steps in 3/4/6/7. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Two explicit "adjust to what Task 0 found" notes are deliberate (the wire envelope is empirically confirmed by the probe) — not placeholders.

**Type consistency:** `AntigravityAccount`, `RefreshFn`, `SecretStorageLike` defined in Task 2 and consumed unchanged in Tasks 3–5. `toGeminiRequest`/`parseGeminiCandidate` signatures defined in Task 1, consumed in Task 4. `getAntigravityClientSecret`/`setAntigravityClientSecret`/`registry.antigravity` defined in Task 5, consumed in Task 6. Provider `info.id = 'antigravity'` matches every registry branch and the settings/command keys. ✓
