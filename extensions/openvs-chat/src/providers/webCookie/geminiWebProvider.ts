/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { cookiesToHeader, defaultChromeProfilePath, isPlatformSupported, readCookies } from './chromeCookies';
import { ChatProvider, ChatRequest, ModelEntry, ProviderInfo, StreamChatResult, apiFetch, describeHttpError } from '../types';

/**
 * Provider for `gemini.google.com` via a real, signed-in Chrome profile's own session
 * cookies, read live at call time — no API key, no browser running, and (per the source
 * project this was ported from) genuinely uncapped where it works.
 *
 * ⚠️ **This is categorically different from every other provider in this extension, Copilot/
 * Grok/Kiro included.** Those three call an internal-but-API-*shaped* backend belonging to a
 * developer tool. This one decrypts a real person's live Google account session out of their
 * own browser and replays it against `gemini.google.com`'s **consumer chat UI** — software
 * built for a human clicking a mouse, not a program. The source project's own README states
 * plainly: *"cookie replay against a consumer chat UI is outside Google's terms, the session
 * can be invalidated at any time, and the prompts carry [your] data."* Google can invalidate
 * or flag the account behind this credential at their sole discretion, with no recourse
 * framed around "a program was using my browser's session." Only added because the user
 * asked for it explicitly, fully aware of this — see
 * `docs/superpowers/plans/2026-09-03-provider-oauth-and-cookie-integrations.md`'s Phase 4.
 *
 * **Off by default** (`openvsChat.webGemini.enabled`, checked before every call) — a second,
 * harder gate than merely "has a key" (see also `NOT_AUTO_INFERRED` in `auto/router.ts`),
 * mirroring the source project's `PRODUCTION_ENABLED` master switch: one flag that pulls this
 * out of dispatch *entirely*, not just marks it unavailable.
 *
 * **Windows only.** Chrome's cookie encryption key is DPAPI-wrapped, bound to the Windows
 * user (`chromeCookies.ts`); macOS uses Keychain and Linux a distro-specific keyring or fixed
 * key, neither of which this module implements. `isPlatformSupported()` is checked up front
 * so the failure on another OS says "not supported on this platform," not a confusing
 * lower-level one. Also fails honestly (rather than guessing) against Chrome's newer
 * App-Bound Encryption ("v20"), which cannot be unwrapped outside the browser process at all.
 *
 * **Single-turn.** `gemini.google.com`'s `StreamGenerate` endpoint takes one prompt string,
 * not a `messages` array — there is no server-side conversation state to resume, so only the
 * latest user turn is sent. A real multi-turn conversation is not preserved between calls.
 *
 * **Multi-account** reuses this extension's ordinary key-rotation machinery
 * (`providers/keyRotation.ts`, wired through `withProviderResilience`) rather than
 * reimplementing the source project's own account pool: each "key" here is a Chrome **user
 * data directory** naming one profile/account (the primary key can be left blank for the
 * platform default; additional accounts go in "Additional API keys" the same as any other
 * provider). A 401/403/429 from this account's session rotates to the next configured
 * profile exactly the way a bad API key would for any other provider.
 */
export class GeminiWebProvider implements ChatProvider {
	readonly info: ProviderInfo = {
		id: 'web_gemini',
		label: 'Gemini (Chrome session, unofficial)',
		suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
		apiKeyUrl: '',
		// Not a pasted key at all — see the class doc. `requiresApiKey: false` because the
		// platform-default Chrome profile needs no configuration; a `key` value here (primary
		// or an "additional key") instead NAMES a specific Chrome user-data directory for a
		// second/third Google account.
		requiresApiKey: false,
		supportsTools: false,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};

	private static enabled(): boolean {
		return vscode.workspace.getConfiguration('openvsChat').get<boolean>('webGemini.enabled') ?? false;
	}

	private static requireEnabledAndSupported(): void {
		if (!isPlatformSupported()) {
			throw new Error(
				'Gemini (Chrome session) is only implemented on Windows — Chrome\'s cookie encryption on this ' +
				'platform uses a different, unimplemented mechanism (Keychain on macOS, a distro keyring or ' +
				'fixed key on Linux).',
			);
		}
		if (!GeminiWebProvider.enabled()) {
			throw new Error(
				'Gemini (Chrome session) is disabled by default. Read the risk in the "Gemini (Chrome session, ' +
				'unofficial)" provider\'s description, then enable "openvsChat.webGemini.enabled" in Settings ' +
				'if you still want to use it — replaying your Google session this way is outside Google\'s terms.',
			);
		}
	}

	private profilePath(storedKey: string): string {
		const trimmed = storedKey.trim();
		if (trimmed) {
			return trimmed;
		}
		const fallback = defaultChromeProfilePath();
		if (!fallback) {
			throw new Error('Gemini (Chrome session): no default Chrome profile location for this platform, and no profile path was configured.');
		}
		return fallback;
	}

	private async cookieHeader(storedKey: string): Promise<string> {
		const profileRoot = this.profilePath(storedKey);
		const cookies = await readCookies(profileRoot, ['google.com']);
		const header = cookiesToHeader(cookies, ['__Secure-1PSID', '__Secure-1PSIDTS', '__Secure-1PSIDCC']);
		if (!header) {
			// Phrased to include "HTTP 401" deliberately: an unreadable/unsigned-in profile is
			// functionally the same as this credential being unauthenticated, and phrasing it
			// this way lets `withProviderResilience`'s isKeyFailure regex classify it as a
			// key failure — which is exactly what multi-account support needs here: the next
			// configured Chrome profile (an "Additional API key") should be tried automatically,
			// the same way a bad API key would rotate to the next one for any other provider.
			throw new Error(
				`Gemini (Chrome session): no Google session cookies readable from ${profileRoot} (HTTP 401 — not ` +
				'signed in). Sign in to a Google account in that Chrome profile, or point this provider at a ' +
				'different profile directory.',
			);
		}
		return header;
	}

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		GeminiWebProvider.requireEnabledAndSupported();
		const cookieHeader = await this.cookieHeader(request.apiKey);
		const userAgent = DEFAULT_USER_AGENT;
		const { at, bl } = await scrapeSessionTokens(cookieHeader, userAgent, request.signal);
		const url = `${GENERATE_URL}?bl=${encodeURIComponent(bl)}&_reqid=${Math.floor(10_000 + Math.random() * 90_000)}&rt=c`;
		// [null, "[[<prompt>], null, null]"] — the inner array is a JSON STRING, per Google's
		// batchexecute request shape (not a nested JSON value).
		const fReq = JSON.stringify([null, JSON.stringify([[lastUserText(request)], null, null])]);
		const body = new URLSearchParams({ at, 'f.req': fReq }).toString();
		const response = await apiFetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Cookie': cookieHeader,
				'User-Agent': userAgent,
				'Origin': 'https://gemini.google.com',
				'Referer': 'https://gemini.google.com/',
			},
			body,
		}, request.signal, { timeoutMs: 60_000, retries: 0 });
		if (!response.ok) {
			throw new Error(await describeHttpError('Gemini (Chrome session)', response));
		}
		const text = extractGeminiText(await response.text());
		if (!text) {
			throw new Error('Gemini (Chrome session): the response contained no answer — the session token may be stale; try again.');
		}
		request.onToken(text);
		return { truncated: false };
	}

	// No documented /models endpoint for this consumer surface; the suggested list is
	// already the complete, correct catalog.
	async listModels(): Promise<ModelEntry[]> {
		return this.info.suggestedModels.map(id => ({ id }));
	}
}

const APP_URL = 'https://gemini.google.com/app';
const GENERATE_URL = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

const TOKEN_RE = /"SNlM0e":"(.*?)"/;
const BUILD_RE = /"cfb2h":"(.*?)"/;
/** Only used when cfb2h is absent — a wrong build id is rejected with a 400, a clearer
 * failure than silently guessing a working one. */
const BUILD_FALLBACK_RE = /(boq_assistant-bard-web-server_[\w.]+)/;

const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/** The last user-role turn's text — this upstream takes one prompt string, not a `messages`
 * array (see the class doc's "Single-turn" note). */
function lastUserText(request: ChatRequest): string {
	for (let i = request.messages.length - 1; i >= 0; i--) {
		if (request.messages[i].role === 'user') {
			return request.messages[i].content;
		}
	}
	return request.messages[request.messages.length - 1]?.content ?? '';
}

/**
 * Extracts the per-session request token (`SNlM0e`, sent back as `at`) and front-end build id
 * (`cfb2h`, sent as the `bl` query param) out of the Gemini app shell's HTML. Pure and
 * side-effect-free so it's testable without a real session — the network fetch lives in
 * {@link scrapeSessionTokens}.
 */
export function parseSessionTokens(html: string): { at: string; bl: string } {
	const tokenMatch = TOKEN_RE.exec(html);
	if (!tokenMatch) {
		throw new Error('Gemini (Chrome session): no session token in the app shell — the Google session is not signed in.');
	}
	const buildMatch = BUILD_RE.exec(html) ?? BUILD_FALLBACK_RE.exec(html);
	if (!buildMatch) {
		throw new Error('Gemini (Chrome session): no front-end build id in the app shell.');
	}
	return { at: tokenMatch[1], bl: buildMatch[1] };
}

/**
 * Fetches the Gemini app shell and scrapes the tokens out of it via {@link parseSessionTokens}.
 * Both values rotate and are cheap to re-fetch, so callers should treat a 400 from the
 * generate endpoint as "these are stale" and simply call this again rather than caching
 * either for long.
 */
export async function scrapeSessionTokens(cookieHeader: string, userAgent: string, signal: AbortSignal): Promise<{ at: string; bl: string }> {
	const response = await apiFetch(APP_URL, {
		method: 'GET',
		headers: { 'User-Agent': userAgent, 'Cookie': cookieHeader, 'Accept': 'text/html,application/xhtml+xml' },
	}, signal, { timeoutMs: 30_000, retries: 0 });
	if (!response.ok) {
		throw new Error(`Gemini (Chrome session): app shell returned HTTP ${response.status}`);
	}
	return parseSessionTokens(await response.text());
}

/**
 * Pulls the assistant's answer out of Google's `batchexecute` response format: a `)]}'`
 * guard line, then repeated `<length>\n<json array>` frames. Each frame holding a body is a
 * **cumulative snapshot**, not a delta — concatenating every frame would duplicate the
 * answer, so only the LAST frame that carries one is used. Ported from a companion Python
 * project's `sites/gemini_web.py`'s `extract_gemini`, verified there against a live session.
 */
export function extractGeminiText(rawText: string): string {
	let best: unknown;
	for (const rawLine of (rawText || '').split('\n')) {
		const line = rawLine.trim();
		if (!line.startsWith('[[')) {
			continue;
		}
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		if (!Array.isArray(frame)) {
			continue;
		}
		for (const part of frame) {
			if (!Array.isArray(part) || part[0] !== 'wrb.fr') {
				continue;
			}
			try {
				const inner = JSON.parse(part[2]);
				if (Array.isArray(inner) && inner[4]) {
					best = inner;
				}
			} catch {
				continue;
			}
		}
	}
	if (!Array.isArray(best)) {
		return '';
	}
	try {
		const answer = (best as unknown[])[4] as unknown[];
		const first = (answer[0] as unknown[])[1] as unknown[];
		return typeof first[0] === 'string' ? first[0] : '';
	} catch {
		return '';
	}
}
