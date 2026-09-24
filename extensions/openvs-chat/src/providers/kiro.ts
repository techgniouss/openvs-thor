/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OAuthProxyChatProvider, WireSession } from './oauthProxy';
import { ChatRequest, ModelEntry, ProviderInfo, StreamChatResult, apiFetch, describeHttpError } from './types';

const CONTENT_FRAGMENT = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Pulls assistant text out of a CodeWhisperer `generateAssistantResponse` response, which
 * answers in one of three shapes depending on endpoint/streaming: plain JSON with a
 * `completion`/`content`/`text` field, an `events`/`completionEvents` list each carrying
 * `assistantResponseEvent.content`, or a raw AWS event-stream blob with `{"content":"..."}`
 * fragments embedded in binary framing (handled by scraping those fragments out rather than
 * parsing the framing properly — not worth it for the one field needed). Ported from a
 * companion project's `providers/kiro.py`'s `extract_codewhisperer`.
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
				const piece = (inner as Record<string, unknown> | undefined)?.content;
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

/** The credential this provider stores (as a JSON string via `registry.setApiKey`),
 * populated by `openvsChat.kiroImportCredential` from `~/.aws/sso/cache/kiro-auth-token.json`
 * — the file Kiro's own IDE/CLI already wrote after a normal sign-in there. This provider
 * never implements a sign-in flow of its own, only an import. */
interface KiroCredential {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt: number;
	readonly region?: string;
}

export function parseKiroCredential(stored: string): KiroCredential {
	try {
		const parsed = JSON.parse(stored) as Partial<KiroCredential>;
		if (typeof parsed.accessToken === 'string') {
			return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt ?? 0, region: parsed.region };
		}
	} catch {
		// fall through
	}
	throw new Error('AWS Kiro: stored credential is not a valid Kiro import — re-run "Import Kiro Credential".');
}

const DEFAULT_REGION = 'us-east-1';

/** Public profile ARN used by the Kiro desktop client — ships in the client, the same for
 * every Builder ID user, same kind of "public constant" as `CopilotProvider.CLIENT_ID`. */
const DEFAULT_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK';

/**
 * Provider for AWS Kiro (Amazon Q Developer / CodeWhisperer) using the token file Kiro's own
 * IDE/CLI already wrote after a normal sign-in there — this provider does not implement any
 * sign-in flow, it only imports (`openvsChat.kiroImportCredential`).
 *
 * ⚠️ Calls CodeWhisperer's internal `generateAssistantResponse` endpoint directly rather than
 * a documented public API — the same category of integration as Copilot/Grok above, with the
 * same account-risk caveat. **Unverified end-to-end.**
 *
 * The free AWS Builder ID tier is roughly 50 interactions/MONTH — this exists for pattern
 * completeness and is not meant to carry real traffic; `NOT_AUTO_INFERRED` in `auto/router.ts`
 * excludes it so Auto mode never burns the monthly allowance on the user's behalf.
 *
 * `conversationState.history` is sent empty on every call (matching the reference envelope
 * this was transcribed from) — multi-turn context is NOT preserved between messages. A known,
 * accepted limitation for a 50-interactions/month provider, surfaced via the label rather
 * than silently shipping degraded multi-turn behavior.
 */
export class KiroProvider extends OAuthProxyChatProvider {
	readonly info: ProviderInfo = {
		id: 'kiro',
		label: 'AWS Kiro (single-turn, unofficial)',
		suggestedModels: ['claude-sonnet-4-5'],
		apiKeyUrl: 'https://kiro.dev',
		requiresApiKey: true,
		supportsTools: false,
		toolModelPatterns: [],
		visionModelPatterns: [],
	};

	protected async mintToken(storedCredential: string, signal: AbortSignal): Promise<WireSession> {
		const cred = parseKiroCredential(storedCredential);
		if (cred.accessToken && cred.expiresAt - Date.now() > 5 * 60_000) {
			return { token: cred.accessToken, expiresAt: cred.expiresAt };
		}
		if (!cred.refreshToken) {
			throw new Error('AWS Kiro: credential has no refresh token — re-import from Kiro.');
		}
		const region = cred.region || DEFAULT_REGION;
		const response = await apiFetch(`https://prod.${region}.auth.desktop.kiro.dev/refreshToken`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refreshToken: cred.refreshToken }),
		}, signal, { timeoutMs: 15_000, retries: 0 });
		if (!response.ok) {
			throw new Error(await describeHttpError('AWS Kiro', response));
		}
		const body = await response.json() as { accessToken?: string; expiresAt?: string | number; refreshToken?: string };
		if (!body.accessToken) {
			throw new Error('AWS Kiro: refreshToken returned no accessToken.');
		}
		const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt
			: typeof body.expiresAt === 'string' ? (Date.parse(body.expiresAt) || (Date.now() + 45 * 60_000))
				: Date.now() + 45 * 60_000;
		// Saved back, with a rotated refresh token when one came back — see Grok's `mintToken`.
		const updated: KiroCredential = { accessToken: body.accessToken, refreshToken: body.refreshToken || cred.refreshToken, expiresAt, region: cred.region };
		return { token: body.accessToken, expiresAt, updatedCredential: JSON.stringify(updated) };
	}

	// Not OpenAI-compatible at all — CodeWhisperer's own envelope — so this bypasses
	// OpenAICompatibleProvider's streamChat entirely rather than delegating to `super`.
	override async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		return this.withWireSession(request.apiKey, request.signal, session => this.generate(session.token, request));
	}

	/** One `generateAssistantResponse` call with an already-minted token. */
	private async generate(token: string, request: ChatRequest): Promise<StreamChatResult> {
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
				profileArn: DEFAULT_PROFILE_ARN,
			}),
		}, request.signal, { timeoutMs: 60_000, retries: 0 });
		if (!response.ok) {
			throw new Error(await describeHttpError('AWS Kiro', response));
		}
		const json = await response.json().catch(async () => response.text());
		const text = extractCodeWhispererText(json);
		request.onToken(text);
		return { truncated: false };
	}

	// No documented /models endpoint for this internal API; the suggested list is already
	// the complete, correct catalog for a Builder ID account.
	override async listModels(): Promise<ModelEntry[]> {
		return this.info.suggestedModels.map(id => ({ id }));
	}
}
