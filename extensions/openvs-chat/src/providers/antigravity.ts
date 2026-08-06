/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentRequest, AgentStep, ChatMessage, ChatProvider, ChatRequest, FinishReason, ModelEntry, ProviderInfo,
	RetryInfo, STREAM_FETCH_OPTS, StreamChatResult, ToolCall, apiFetch, describeHttpError, retryNotice,
} from './types';

/**
 * Provider for Google's Antigravity IDE OAuth → Code Assist API (`cloudcode-pa`), the
 * same backend Google's own Antigravity client talks to. Antigravity's ToS restricts
 * this credential to Google's own client, and Google has banned accounts for proxying
 * it through third-party tools — see the sign-in flow in `oauth.ts` for the full
 * caveat. Only wired up because the user asked for it explicitly with a working
 * reference implementation in hand; this is not the sanctioned path (that's
 * `GeminiProvider` in `gemini.ts`, a real AI-Studio API key against Google's official
 * OpenAI-compatible endpoint).
 *
 * Scope of this implementation, kept honest rather than guessed:
 *  - Tool calling (`runAgentStep`) uses the public Gemini API's function-calling wire
 *    shape (`tools: [{ functionDeclarations }]`, response parts carrying
 *    `functionCall: { name, args }`) — this is a best-effort port, NOT verified against
 *    the internal Code Assist API specifically. The inference: every field already
 *    confirmed correct here (`contents`, `generationConfig`, role names) matches the
 *    public API's naming exactly, suggesting they share the same proto schema, but
 *    that's a plausibility argument, not a live test. If tool calls silently fail to
 *    round-trip, this is the first place to look.
 *  - No true token streaming. `generateContent` (non-streaming) is used and the whole
 *    answer is delivered as one `onToken` call; the SSE variant
 *    (`streamGenerateContent?alt=sse`) exists but its event shape isn't verified here.
 *    `maxOutputTokens` and the response's `finishReason` (mapped to the normalized
 *    `FinishReason`) ARE wired through, so a max-token cutoff is still detected and
 *    triggers `streamChatWithContinuation` like every other provider — it just arrives
 *    as one round trip instead of a live stream.
 *  - No image attachments — same "not verified" reasoning.
 */
export class AntigravityProvider implements ChatProvider {
	readonly info: ProviderInfo = {
		id: 'antigravity',
		label: 'Google Antigravity',
		// Curated 2026-08-04 from a live 19-model sweep against the Antigravity IDE's own
		// Code Assist quota pool (same endpoints this provider calls) — 16 passed a strict
		// JSON + ranking test; `gemini-2.5-pro` and `gemini-3.1-pro-high` are known-FAIL
		// (503 / 400) on this tier and deliberately excluded. Ordered default-first, then
		// by measured latency. `listModels()` below replaces this with the live catalog
		// once signed in; this is only the pre-sign-in / fetch-failure fallback.
		suggestedModels: [
			'gemini-2.5-flash',
			'gemini-3.6-flash-high',
			'gemini-3.6-flash-medium',
			'gemini-3.6-flash-low',
			'gemini-3-flash-agent',
			'gemini-3.1-flash-lite',
			'gemini-2.5-flash-lite',
			'claude-sonnet-4-6',
			'claude-opus-4-6-thinking',
			'gemini-pro-agent',
		],
		apiKeyUrl: 'https://antigravity.google',
		requiresApiKey: true,
		supportsTools: true,
		// Every Gemini/Claude model in the catalog is assumed tool-capable; there's no
		// per-model capability flag in `fetchAvailableModels`'s response to key off.
		toolModelPatterns: [],
		// No model id can match a NUL byte — this disables the image-attach UI until the
		// image-part wire shape for this endpoint is verified (see class doc above).
		visionModelPatterns: ['^\\x00$'],
	};

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		const { text, finishReason } = await generateContent(
			request.apiKey, request.model, toContents(request.messages), request.maxTokens, request.signal,
			info => request.onNotice?.(retryNotice(this.info.label, info)),
		);
		request.onToken(text);
		return { truncated: finishReason === 'length', finishReason };
	}

	async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		const tools = request.tools.length
			? [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
			: undefined;
		const { text, toolCalls, finishReason } = await generateContent(
			request.apiKey, request.model, toContents(request.messages), request.maxTokens, request.signal,
			info => request.onNotice?.(retryNotice(this.info.label, info)), tools,
		);
		if (text) {
			request.onToken?.(text);
		}
		return { content: text, toolCalls, truncated: finishReason === 'length', finishReason };
	}

	async listModels(apiKey: string, _baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		if (!apiKey) {
			return this.info.suggestedModels.map(id => ({ id }));
		}
		let lastResponse: Response | undefined;
		for (const base of GENERATE_ENDPOINTS) {
			const response = await apiFetch(`${base}/v1internal:fetchAvailableModels`, {
				method: 'POST',
				headers: antigravityHeaders(apiKey),
				body: JSON.stringify({}),
			}, signal, { timeoutMs: 15_000, retries: 0 });
			if (!response.ok) {
				lastResponse = response;
				continue;
			}
			const json = await response.json();
			const catalog = (json?.models ?? json ?? {}) as Record<string, unknown>;
			const ids = Object.keys(catalog).filter(id => catalog[id] && typeof catalog[id] === 'object');
			return (ids.length ? ids : this.info.suggestedModels).sort((a, b) => a.localeCompare(b)).map(id => ({ id }));
		}
		throw new Error(await describeHttpError(this.info.label, lastResponse!));
	}
}

const ENDPOINT_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';
// The autopush sandbox 403s "Gemini for Google Cloud API (Staging) has not been used…"
// for every model — dead per the reference implementation this was built from. Skipped
// rather than costing every call a wasted round trip.
const GENERATE_ENDPOINTS = [ENDPOINT_DAILY, ENDPOINT_PROD];
const LOAD_ENDPOINTS = [ENDPOINT_PROD, ENDPOINT_DAILY];

const ANTIGRAVITY_VERSION = '1.19.4';

/**
 * Headers that make the Code Assist API accept the request as if it came from the
 * Antigravity IDE itself. Sending the Gemini-CLI User-Agent here instead returns
 * `ineligibleTiers[0].reasonCode == "UNSUPPORTED_CLIENT"` on `loadCodeAssist` — Google
 * keys free-tier eligibility off this exact User-Agent since its 2026-06-18 shutdown of
 * Gemini Code Assist for individuals.
 */
function antigravityHeaders(accessToken: string): Record<string, string> {
	return {
		'Authorization': `Bearer ${accessToken}`,
		'Content-Type': 'application/json',
		'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) `
			+ `Antigravity/${ANTIGRAVITY_VERSION} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
		'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
		'Client-Metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS', pluginType: 'GEMINI' }),
	};
}

interface LoadCodeAssistResponse {
	readonly cloudaicompanionProject?: string | { id?: string };
	readonly currentTier?: { readonly id?: string; readonly userDefinedCloudaicompanionProject?: boolean };
	readonly allowedTiers?: readonly { readonly id?: string; readonly userDefinedCloudaicompanionProject?: boolean }[];
	readonly ineligibleTiers?: readonly { readonly reasonMessage?: string }[];
}

/** Resolved Code Assist project ids, cached per access token for that token's lifetime. */
const projectIdCache = new Map<string, string>();

function projectIdFromField(pid: LoadCodeAssistResponse['cloudaicompanionProject']): string {
	if (typeof pid === 'string') {
		return pid;
	}
	return pid?.id ?? '';
}

/**
 * `loadCodeAssist` → (`onboardUser` if the account is free-tier and unprovisioned) →
 * a usable project id. Never falls back to a hardcoded project id: calling
 * `generateContent` against a project the OAuth identity has no IAM role on returns
 * Google's "Verify your account to continue." 403, which reads like an account problem
 * but is actually a wrong-project problem — see the reference doc's Bug 1.
 */
async function resolveProjectId(accessToken: string, signal: AbortSignal): Promise<string> {
	const cached = projectIdCache.get(accessToken);
	if (cached) {
		return cached;
	}

	const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
	let load: LoadCodeAssistResponse | undefined;
	let lastError = '';
	for (const base of LOAD_ENDPOINTS) {
		try {
			const response = await apiFetch(`${base}/v1internal:loadCodeAssist`, {
				method: 'POST',
				headers: antigravityHeaders(accessToken),
				body: JSON.stringify({ metadata }),
			}, signal, { timeoutMs: 15_000, retries: 0 });
			if (!response.ok) {
				lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
				continue;
			}
			load = await response.json();
			break;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}
	if (!load) {
		throw new Error(`Google Antigravity: could not resolve a Code Assist project (${lastError}).`);
	}

	const provisioned = projectIdFromField(load.cloudaicompanionProject);
	if (provisioned) {
		projectIdCache.set(accessToken, provisioned);
		return provisioned;
	}

	if (load.currentTier?.userDefinedCloudaicompanionProject) {
		throw new Error(`Google Antigravity: this account is on the '${load.currentTier.id}' tier, which requires a `
			+ 'user-defined GCP project. This provider does not yet support supplying one.');
	}

	const freeTier = load.allowedTiers?.find(t => !t.userDefinedCloudaicompanionProject);
	if (freeTier?.id) {
		const onboarded = await onboardUser(accessToken, metadata, freeTier.id, signal);
		if (onboarded) {
			projectIdCache.set(accessToken, onboarded);
			return onboarded;
		}
	}

	const reason = load.ineligibleTiers?.[0]?.reasonMessage;
	throw new Error(`Google Antigravity: account not eligible for Code Assist${reason ? ` — ${reason}` : ''}.`);
}

/** POST `onboardUser` and poll its long-running-operation body until `done`. */
async function onboardUser(
	accessToken: string, metadata: Record<string, string>, tierId: string, signal: AbortSignal,
): Promise<string> {
	const base = LOAD_ENDPOINTS[0];
	for (let attempt = 0; attempt < 8; attempt++) {
		const response = await apiFetch(`${base}/v1internal:onboardUser`, {
			method: 'POST',
			headers: antigravityHeaders(accessToken),
			body: JSON.stringify({ tierId, metadata }),
		}, signal, { timeoutMs: 15_000, retries: 0 });
		if (!response.ok) {
			return '';
		}
		const data = await response.json();
		if (data?.done) {
			return projectIdFromField(data?.response?.cloudaicompanionProject);
		}
		await new Promise(resolve => setTimeout(resolve, 2000));
	}
	return '';
}

interface GenerateContentPart {
	readonly text?: string;
	readonly functionCall?: { readonly name?: string; readonly args?: Record<string, unknown> };
}

interface GenerateContentCandidate {
	readonly content?: { readonly parts?: readonly GenerateContentPart[] };
	/** Google's native finish-reason enum: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `OTHER`, … */
	readonly finishReason?: string;
}

interface GenerateContentResponse {
	readonly response?: { readonly candidates?: readonly GenerateContentCandidate[] };
	readonly candidates?: readonly GenerateContentCandidate[];
}

/** Maps the Code Assist API's native finish-reason enum onto the normalized set. */
function mapFinishReason(raw: string | undefined): FinishReason | undefined {
	switch (raw) {
		case 'MAX_TOKENS':
			return 'length';
		case 'SAFETY':
		case 'RECITATION':
		case 'BLOCKLIST':
		case 'PROHIBITED_CONTENT':
			return 'filtered';
		case 'STOP':
		case 'OTHER':
			return 'stop';
		default:
			return raw ? 'stop' : undefined;
	}
}

function extractResult(body: GenerateContentResponse): { text: string; toolCalls: ToolCall[]; finishReason?: FinishReason } {
	const outer = body.response ?? body;
	const candidate = outer.candidates?.[0];
	const parts = candidate?.content?.parts ?? [];
	const text = parts.filter(p => typeof p.text === 'string').map(p => p.text as string).join('');
	// Gemini's functionCall parts carry no call id of their own — synthesize one, same
	// fallback OpenAICompatibleProvider.runAgentStep uses for a backend that omits it.
	const toolCalls: ToolCall[] = parts
		.filter((p): p is GenerateContentPart & { functionCall: { name: string } } => typeof p.functionCall?.name === 'string')
		.map((p, i) => ({ id: `call_${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }));
	return { text, toolCalls, finishReason: mapFinishReason(candidate?.finishReason) };
}

interface AntigravityPart {
	readonly text?: string;
	readonly functionCall?: { readonly name: string; readonly args: Record<string, unknown> };
	readonly functionResponse?: { readonly name: string; readonly response: Record<string, unknown> };
}

interface AntigravityContent {
	// 'function' carries tool RESULTS back to the model — distinct from 'model', which
	// carries the tool CALLS the model made. Matches the public Gemini API's chat shape.
	readonly role: 'user' | 'model' | 'function';
	readonly parts: AntigravityPart[];
}

/**
 * Maps internal chat messages onto the Code Assist API's native `contents` shape,
 * including tool-call / tool-result turns for Agent mode (see the class doc's caveat
 * on this part being an unverified port of the public Gemini API's shape).
 */
function toContents(messages: ChatMessage[]): AntigravityContent[] {
	const systemLines = messages.filter(m => m.role === 'system' && m.content).map(m => m.content);
	// Tool messages only carry a toolCallId, not the tool's name — recovered from the
	// preceding assistant turn's toolCalls, same as every other provider's history walk.
	const toolNameById = new Map<string, string>();
	for (const m of messages) {
		for (const tc of m.toolCalls ?? []) {
			toolNameById.set(tc.id, tc.name);
		}
	}

	const out: AntigravityContent[] = [];
	const append = (role: AntigravityContent['role'], parts: AntigravityPart[]) => {
		if (!parts.length) {
			return;
		}
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.parts.push(...parts);
		} else {
			out.push({ role, parts });
		}
	};

	for (const m of messages) {
		if (m.role === 'system') {
			continue;
		}
		if (m.role === 'tool') {
			// Multiple consecutive tool results (a batched step's parallel calls) merge into
			// one 'function' turn — the model issued them together, so the response should
			// come back together too.
			append('function', [{ functionResponse: { name: toolNameById.get(m.toolCallId ?? '') ?? 'unknown', response: { content: m.content } } }]);
			continue;
		}
		if (m.role === 'assistant' && m.toolCalls?.length) {
			const parts: AntigravityPart[] = [];
			if (m.content) {
				parts.push({ text: m.content });
			}
			for (const tc of m.toolCalls) {
				parts.push({ functionCall: { name: tc.name, args: tc.args } });
			}
			append('model', parts);
			continue;
		}
		if (m.content) {
			append(m.role === 'assistant' ? 'model' : 'user', [{ text: m.content }]);
		}
	}

	if (systemLines.length) {
		out.unshift({ role: 'user', parts: [{ text: `System instructions:\n${systemLines.join('\n\n')}` }] });
	}
	if (out.length && out[0].role !== 'user') {
		out.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
	}
	return out;
}

async function generateContent(
	accessToken: string, model: string, contents: AntigravityContent[], maxTokens: number, signal: AbortSignal,
	onRetry?: (info: RetryInfo) => void, tools?: { functionDeclarations: Record<string, unknown>[] }[],
): Promise<{ text: string; toolCalls: ToolCall[]; finishReason?: FinishReason }> {
	const projectId = await resolveProjectId(accessToken, signal);
	const payload = {
		model,
		project: projectId,
		request: {
			contents,
			generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
			...(tools ? { tools } : {}),
		},
	};

	let lastResponse: Response | undefined;
	for (const base of GENERATE_ENDPOINTS) {
		const response = await apiFetch(`${base}/v1internal:generateContent`, {
			method: 'POST',
			headers: antigravityHeaders(accessToken),
			body: JSON.stringify(payload),
		}, signal, { ...STREAM_FETCH_OPTS, onRetry });
		if (response.ok) {
			return extractResult(await response.json());
		}
		lastResponse = response;
		// Sandbox capacity/staging errors are endpoint-specific; fall through to the next one.
		if (base !== GENERATE_ENDPOINTS[GENERATE_ENDPOINTS.length - 1] && (response.status === 429 || response.status >= 500)) {
			continue;
		}
		break;
	}
	throw new Error(await describeHttpError('Google Antigravity', lastResponse!));
}
