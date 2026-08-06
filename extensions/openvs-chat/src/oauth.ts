/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Native OAuth sign-in for providers that offer a consumer subscription login
 * (Anthropic "Claude" accounts and OpenAI "ChatGPT" accounts), so users without an
 * API key can authenticate with the account they already pay for. Tokens are stored
 * in VS Code SecretStorage and refreshed transparently before they expire.
 *
 * Note: subscription tokens are intended by the providers for their own first-party
 * tools; both flows below mirror the public PKCE flows used by those tools.
 */

/**
 * Minimal `.env` loader — no external dependency, matching this extension's
 * zero-npm-dependency footprint. Reads `<extensionPath>/.env` (gitignored via the
 * repo's root `.env` / `.env.*` rules; see `.env.example` for the documented,
 * checked-in placeholder) and sets any `KEY=VALUE` pair not already present in
 * `process.env`, so a real OS-level env var still wins. Silent no-op if the file
 * doesn't exist — most users never need one. Call once, early in `activate()`.
 */
export function loadEnvFile(extensionPath: string): void {
	let contents: string;
	try {
		contents = fs.readFileSync(path.join(extensionPath, '.env'), 'utf8');
	} catch {
		return;
	}
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const eq = line.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
			value = value.slice(1, -1);
		}
		if (key && !(key in process.env)) {
			process.env[key] = value;
		}
	}
}

const SECRET_PREFIX = 'openvsChat.oauth.';
/** Refresh when the access token has less than this long left to live. */
const EXPIRY_SLACK_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference';

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_ISSUER = 'https://auth.openai.com';
const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const OPENAI_CALLBACK_PORT = 1455;
const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_CALLBACK_PORT}/auth/callback`;
const OPENAI_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

/** A persisted OAuth session for one provider. */
export interface StoredOAuth {
	readonly type: 'anthropic' | 'openai' | 'antigravity';
	readonly access: string;
	readonly refresh: string;
	/** Absolute expiry time of `access`, in ms since the epoch. */
	readonly expires: number;
	/**
	 * `type: 'openai'` only — the ChatGPT-Account-ID derived from this session's
	 * id_token (see `chatgptAccountId` below). Persisted so it survives an
	 * extension-host restart; the in-process cache alone does not.
	 */
	readonly accountId?: string;
}

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';

/**
 * Google's Antigravity IDE OAuth client (shared with its CLI). Public — ships inside
 * Antigravity's own binary; the redirect-URI restriction is the actual security
 * control, not client_id/client_secret confidentiality. **Antigravity's ToS explicitly
 * bans using this credential through third-party tools**, and Google has already
 * banned paying subscribers for exactly this pattern (naming Claude Code and other
 * third-party agents by name in its own FAQ). Wired up only because it was explicitly
 * requested with a working reference implementation in hand — `GeminiProvider` in
 * `providers/gemini.ts` is the sanctioned alternative (a real AI-Studio API key).
 */
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANTIGRAVITY_CALLBACK_PORT = 51121;
const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}/oauth-callback`;
const ANTIGRAVITY_SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

/**
 * Google's token endpoint requires a client_secret on this client's exchanges even
 * though it's a public "Desktop app" client. Kept out of source (unlike
 * `ANTHROPIC_CLIENT_ID`, which has no secret) because the literal value matches
 * secret-scanner patterns (`GOCSPX-...`) — set it via this environment variable
 * instead of hardcoding it here.
 */
function antigravityClientSecret(): string {
	const secret = process.env['ANTIGRAVITY_CLIENT_SECRET'];
	if (!secret) {
		throw new Error('Google Antigravity sign-in needs ANTIGRAVITY_CLIENT_SECRET. Copy extensions/openvs-chat/.env.example '
			+ 'to .env in the same folder, fill in the value, then reload the window (Developer: Reload Window).');
	}
	return secret;
}

/** Which providers have a built-in web sign-in (no `authUrl` setting needed). */
export function supportsNativeSignIn(providerId: string): boolean {
	return providerId === 'anthropic' || providerId === 'openai' || providerId === 'openrouter' || providerId === 'antigravity';
}

interface Pkce {
	readonly verifier: string;
	readonly challenge: string;
}

function base64url(buffer: Buffer): string {
	return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkce(): Pkce {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}

/** Decodes the (unverified) claims of a JWT, or undefined when it isn't one. */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
}

/**
 * The Codex backend needs a `ChatGPT-Account-ID` header on every request, decoded
 * from the `https://api.openai.com/auth` claim. `providers/codex.py` (the reference
 * this mirrors) decodes that claim from the sign-in's `id_token`, not the
 * `access_token` — so it's derived here (where `id_token` is available, right after
 * the code exchange / each refresh) and looked up by `chatgptBackend.ts` keyed on the
 * access token that goes out on the wire, since that module only ever sees that
 * single string (see `ChatProvider`'s "self-contained, fetch only" contract in
 * `providers/types.ts`).
 *
 * Cached in-process AND persisted on `StoredOAuth.accountId` (see below): the
 * in-process map alone doesn't survive an extension-host restart, and a still-valid
 * access token (the common case — restarting the editor doesn't expire a token with
 * time left) would otherwise skip both sign-in and refresh, the only two places that
 * used to derive it, and fail every request with "missing the account id" on an
 * otherwise perfectly good session.
 */
const chatgptAccountIds = new Map<string, string>();

/** Decodes `chatgpt_account_id` from a ChatGPT sign-in's id_token, if present. */
function deriveChatGptAccountId(idToken: unknown): string | undefined {
	if (typeof idToken !== 'string') {
		return undefined;
	}
	const auth = decodeJwtClaims(idToken)?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
	const id = auth?.['chatgpt_account_id'];
	return typeof id === 'string' && id ? id : undefined;
}

function cacheChatGptAccountId(accessToken: string, id: string | undefined): void {
	if (id) {
		chatgptAccountIds.set(accessToken, id);
	}
}

/** Looks up an account id cached by {@link cacheChatGptAccountId}, if any. */
export function chatgptAccountId(accessToken: string): string | undefined {
	return chatgptAccountIds.get(accessToken);
}

/**
 * Persists and refreshes OAuth sessions. Owns no UI: the interactive sign-in flows
 * live in the exported `signIn*` functions below and write into this store.
 */
export class OAuthTokenStore {
	constructor(private readonly secrets: vscode.SecretStorage) { }

	private key(id: string): string {
		return SECRET_PREFIX + id;
	}

	async get(id: string): Promise<StoredOAuth | undefined> {
		const raw = await this.secrets.get(this.key(id));
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed?.access === 'string' && typeof parsed?.refresh === 'string') {
				return parsed as StoredOAuth;
			}
		} catch {
			// Corrupt record: treat as signed out.
		}
		return undefined;
	}

	async set(id: string, record: StoredOAuth): Promise<void> {
		await this.secrets.store(this.key(id), JSON.stringify(record));
	}

	async clear(id: string): Promise<void> {
		await this.secrets.delete(this.key(id));
	}

	/**
	 * Returns a valid access token for the provider, refreshing (and re-persisting)
	 * it when it is about to expire. Returns undefined when the user never signed in;
	 * throws when the session exists but can no longer be refreshed.
	 */
	async getFreshAccessToken(id: string): Promise<string | undefined> {
		const record = await this.get(id);
		if (!record) {
			return undefined;
		}
		if (record.type === 'openai' && record.accountId) {
			// Warms the in-process cache from the persisted value on every lookup, not
			// just after a fresh sign-in/refresh — the only two call sites that used to
			// populate it — so a still-valid token survives an extension-host restart.
			cacheChatGptAccountId(record.access, record.accountId);
		}
		if (record.expires - EXPIRY_SLACK_MS > Date.now()) {
			return record.access;
		}
		const refreshed = record.type === 'anthropic' ? await refreshAnthropic(record.refresh)
			: record.type === 'openai' ? await refreshOpenAI(record.refresh, record.access)
				: await refreshAntigravity(record.refresh);
		if (refreshed === 'invalid') {
			await this.clear(id);
			throw new Error('Your web sign-in session expired. Please sign in again.');
		}
		await this.set(id, refreshed);
		return refreshed.access;
	}
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function postForm(url: string, body: Record<string, string>): Promise<{ status: number; json: any }> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(body).toString(),
	});
	return { status: response.status, json: await response.json().catch(() => ({})) };
}

function toRecord(type: StoredOAuth['type'], json: any, accountId?: string): StoredOAuth {
	return {
		type,
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000,
		accountId,
	};
}

async function refreshAnthropic(refreshToken: string): Promise<StoredOAuth | 'invalid'> {
	const { status, json } = await postJson(ANTHROPIC_TOKEN_URL, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: ANTHROPIC_CLIENT_ID,
	});
	if (status === 400 || status === 401 || status === 403) {
		return 'invalid';
	}
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Could not refresh the Claude sign-in (HTTP ${status}).`);
	}
	return toRecord('anthropic', { ...json, refresh_token: json.refresh_token ?? refreshToken });
}

async function refreshOpenAI(refreshToken: string, previousAccessToken: string): Promise<StoredOAuth | 'invalid'> {
	// Unlike the initial code exchange (form-encoded), OpenAI's refresh grant only
	// accepts a JSON body here — sending it form-encoded, like the code exchange, gets
	// silently ignored fields / auth failures. See providers/codex.py's
	// `_load_and_refresh_token` in the reference implementation this mirrors.
	const { status, json } = await postJson(OPENAI_TOKEN_URL, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: OPENAI_CLIENT_ID,
		scope: 'openid profile email',
	});
	if (status === 400 || status === 401 || status === 403) {
		return 'invalid';
	}
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Could not refresh the ChatGPT sign-in (HTTP ${status}).`);
	}
	// The refresh response doesn't always include a fresh id_token — carry the
	// previously-derived account id forward, same as the reference's
	// `tokens["id_token"] = new.get("id_token") or id_token`.
	const accountId = deriveChatGptAccountId(json.id_token) ?? chatgptAccountId(previousAccessToken);
	cacheChatGptAccountId(json.access_token, accountId);
	return toRecord('openai', { ...json, refresh_token: json.refresh_token ?? refreshToken }, accountId);
}

async function refreshAntigravity(refreshToken: string): Promise<StoredOAuth | 'invalid'> {
	const { status, json } = await postForm(ANTIGRAVITY_TOKEN_URL, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: ANTIGRAVITY_CLIENT_ID,
		client_secret: antigravityClientSecret(),
	});
	if (status === 400 || status === 401 || status === 403) {
		return 'invalid';
	}
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Could not refresh the Antigravity sign-in (HTTP ${status}).`);
	}
	return toRecord('antigravity', { ...json, refresh_token: json.refresh_token ?? refreshToken });
}

/**
 * Runs the Claude account sign-in: opens the claude.ai authorization page in the
 * browser and asks the user to paste back the code shown after approving (the flow
 * used by Anthropic's own CLI — no local callback server involved). Returns true
 * when a session was stored, false when the user cancelled.
 */
export async function signInAnthropic(store: OAuthTokenStore): Promise<boolean> {
	const pkce = createPkce();
	const url = new URL(ANTHROPIC_AUTHORIZE_URL);
	url.searchParams.set('code', 'true');
	url.searchParams.set('client_id', ANTHROPIC_CLIENT_ID);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('redirect_uri', ANTHROPIC_REDIRECT_URI);
	url.searchParams.set('scope', ANTHROPIC_SCOPES);
	url.searchParams.set('code_challenge', pkce.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', pkce.verifier);

	await vscode.env.openExternal(vscode.Uri.parse(url.toString()));

	const pasted = await vscode.window.showInputBox({
		title: 'Sign in with Claude',
		prompt: 'Approve access in the browser, then paste the code shown on the confirmation page here.',
		placeHolder: 'Paste authorization code…',
		ignoreFocusOut: true,
	});
	if (!pasted?.trim()) {
		return false;
	}
	const [code, state] = pasted.trim().split('#');
	const { status, json } = await postJson(ANTHROPIC_TOKEN_URL, {
		grant_type: 'authorization_code',
		code,
		state: state ?? pkce.verifier,
		client_id: ANTHROPIC_CLIENT_ID,
		redirect_uri: ANTHROPIC_REDIRECT_URI,
		code_verifier: pkce.verifier,
	});
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Claude sign-in failed (HTTP ${status}): ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
	}
	await store.set('anthropic', toRecord('anthropic', json));
	return true;
}

export interface OpenAISignInResult {
	/** How the session will authenticate: a real API key, or ChatGPT subscription tokens. */
	readonly mode: 'apiKey' | 'chatgpt';
	/** Present when the account had API access and a key could be minted. */
	readonly apiKey?: string;
}

/**
 * Runs the ChatGPT account sign-in: starts a one-shot localhost callback server (the
 * redirect URI registered for OpenAI's public CLI client is fixed to port 1455),
 * opens the browser, and exchanges the returned code. If the account has API access,
 * an API key is minted via token exchange and returned; otherwise the subscription
 * tokens are stored for the ChatGPT backend. Returns undefined when cancelled.
 */
export async function signInOpenAI(store: OAuthTokenStore): Promise<OpenAISignInResult | undefined> {
	const pkce = createPkce();
	const state = base64url(randomBytes(16));
	const url = new URL(`${OPENAI_ISSUER}/oauth/authorize`);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', OPENAI_CLIENT_ID);
	url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI);
	url.searchParams.set('scope', OPENAI_SCOPES);
	url.searchParams.set('code_challenge', pkce.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	url.searchParams.set('id_token_add_organizations', 'true');
	url.searchParams.set('codex_cli_simplified_flow', 'true');
	url.searchParams.set('originator', 'codex_cli_rs');

	const code = await waitForOpenAICallback(url.toString(), state);
	if (!code) {
		return undefined;
	}

	const { status, json } = await postForm(OPENAI_TOKEN_URL, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: OPENAI_REDIRECT_URI,
		client_id: OPENAI_CLIENT_ID,
		code_verifier: pkce.verifier,
	});
	if (typeof json?.access_token !== 'string') {
		throw new Error(`ChatGPT sign-in failed (HTTP ${status}): ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
	}
	const accountId = deriveChatGptAccountId(json.id_token);
	cacheChatGptAccountId(json.access_token, accountId);

	// Accounts with API access can mint a normal API key from the id token; that is
	// the most compatible path (works with every OpenAI endpoint). Subscription-only
	// accounts fall back to the ChatGPT backend using the OAuth access token.
	if (typeof json.id_token === 'string') {
		try {
			const exchanged = await postForm(OPENAI_TOKEN_URL, {
				grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
				client_id: OPENAI_CLIENT_ID,
				requested_token: 'openai-api-key',
				subject_token: json.id_token,
				subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
			});
			const key = exchanged.json?.access_token;
			if (typeof key === 'string' && key.startsWith('sk-')) {
				return { mode: 'apiKey', apiKey: key };
			}
		} catch {
			// No API org / exchange unavailable: use the subscription path below.
		}
	}

	await store.set('openai', toRecord('openai', json, accountId));
	return { mode: 'chatgpt' };
}

/**
 * Serves the OAuth redirect on localhost:1455 for a single sign-in attempt and
 * resolves with the authorization code (or undefined on cancel/timeout).
 */
function waitForOpenAICallback(authorizeUrl: string, expectedState: string): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve, reject) => {
		let settled = false;
		const server = http.createServer((req, res) => {
			const requestUrl = new URL(req.url ?? '/', `http://localhost:${OPENAI_CALLBACK_PORT}`);
			if (requestUrl.pathname !== '/auth/callback') {
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
					reject(new Error(`ChatGPT sign-in was rejected: ${error}`));
				} else if (!code || state !== expectedState) {
					reject(new Error('ChatGPT sign-in returned an invalid callback.'));
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
				? new Error(`Port ${OPENAI_CALLBACK_PORT} is in use (is another sign-in or Codex CLI running?). Close it and try again.`)
				: err));
		});

		server.listen(OPENAI_CALLBACK_PORT, '127.0.0.1', () => {
			vscode.env.openExternal(vscode.Uri.parse(authorizeUrl)).then(opened => {
				if (!opened) {
					finish(() => reject(new Error('Could not open the sign-in page in a browser.')));
				}
			});
		});

		void vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Waiting for ChatGPT sign-in in the browser…', cancellable: true },
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

/**
 * Runs the Google Antigravity sign-in: PKCE + a local callback server on the fixed
 * port Antigravity's own OAuth client is registered against. See the caveat on
 * `ANTIGRAVITY_CLIENT_ID` above before wiring this up anywhere new.
 */
export async function signInAntigravity(store: OAuthTokenStore): Promise<boolean> {
	// Fail before opening a browser tab if the secret isn't configured.
	const clientSecret = antigravityClientSecret();

	const pkce = createPkce();
	const state = base64url(randomBytes(16));
	const url = new URL(ANTIGRAVITY_AUTHORIZE_URL);
	url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI);
	url.searchParams.set('scope', ANTIGRAVITY_SCOPES);
	url.searchParams.set('code_challenge', pkce.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	url.searchParams.set('state', state);

	const code = await waitForAntigravityCallback(url.toString(), state);
	if (!code) {
		return false;
	}

	const { status, json } = await postForm(ANTIGRAVITY_TOKEN_URL, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: ANTIGRAVITY_REDIRECT_URI,
		client_id: ANTIGRAVITY_CLIENT_ID,
		client_secret: clientSecret,
		code_verifier: pkce.verifier,
	});
	if (typeof json?.access_token !== 'string') {
		throw new Error(`Antigravity sign-in failed (HTTP ${status}): ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
	}
	await store.set('antigravity', toRecord('antigravity', json));
	return true;
}

/**
 * Serves the OAuth redirect on localhost:51121 for a single sign-in attempt and
 * resolves with the authorization code (or undefined on cancel/timeout).
 */
function waitForAntigravityCallback(authorizeUrl: string, expectedState: string): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve, reject) => {
		let settled = false;
		const server = http.createServer((req, res) => {
			const requestUrl = new URL(req.url ?? '/', `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}`);
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
					reject(new Error(`Antigravity sign-in was rejected: ${error}`));
				} else if (!code || state !== expectedState) {
					reject(new Error('Antigravity sign-in returned an invalid callback.'));
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
				? new Error(`Port ${ANTIGRAVITY_CALLBACK_PORT} is in use (is another sign-in already running?). Close it and try again.`)
				: err));
		});

		server.listen(ANTIGRAVITY_CALLBACK_PORT, '127.0.0.1', () => {
			vscode.env.openExternal(vscode.Uri.parse(authorizeUrl)).then(opened => {
				if (!opened) {
					finish(() => reject(new Error('Could not open the sign-in page in a browser.')));
				}
			});
		});

		void vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Waiting for Google Antigravity sign-in in the browser…', cancellable: true },
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

/**
 * Runs the OpenRouter one-click sign-in: a PKCE flow against openrouter.ai that ends
 * with OpenRouter minting a user-controlled API key (no expiry, revocable from their
 * dashboard), which we store like a pasted key. Serves the callback on an ephemeral
 * localhost port since OpenRouter accepts any `callback_url`. Returns the key, or
 * undefined when the user cancelled.
 */
export async function signInOpenRouter(): Promise<string | undefined> {
	const pkce = createPkce();
	const code = await waitForOpenRouterCallback(pkce.challenge);
	if (!code) {
		return undefined;
	}
	const { status, json } = await postJson(OPENROUTER_KEYS_URL, {
		code,
		code_verifier: pkce.verifier,
		code_challenge_method: 'S256',
	});
	if (typeof json?.key !== 'string') {
		throw new Error(`OpenRouter sign-in failed (HTTP ${status}): ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
	}
	return json.key;
}

/**
 * Serves the OpenRouter OAuth redirect on an ephemeral localhost port for a single
 * sign-in attempt and resolves with the authorization code (or undefined on cancel).
 */
function waitForOpenRouterCallback(codeChallenge: string): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve, reject) => {
		let settled = false;
		const server = http.createServer((req, res) => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
			if (requestUrl.pathname !== '/callback') {
				res.writeHead(404).end();
				return;
			}
			const error = requestUrl.searchParams.get('error');
			const code = requestUrl.searchParams.get('code');
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<html><body style="font-family:sans-serif"><h2>Sign-in received</h2><p>You can close this window and return to the editor.</p></body></html>');
			finish(() => {
				if (error) {
					reject(new Error(`OpenRouter sign-in was rejected: ${error}`));
				} else if (!code) {
					reject(new Error('OpenRouter sign-in returned an invalid callback.'));
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

		server.on('error', err => finish(() => reject(err)));

		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const url = new URL(OPENROUTER_AUTH_URL);
			url.searchParams.set('callback_url', `http://127.0.0.1:${port}/callback`);
			url.searchParams.set('code_challenge', codeChallenge);
			url.searchParams.set('code_challenge_method', 'S256');
			vscode.env.openExternal(vscode.Uri.parse(url.toString())).then(opened => {
				if (!opened) {
					finish(() => reject(new Error('Could not open the sign-in page in a browser.')));
				}
			});
		});

		void vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Waiting for OpenRouter sign-in in the browser…', cancellable: true },
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

/** A fresh session id per extension host, matching the first-party client's header. */
export const chatgptSessionId = randomUUID();
