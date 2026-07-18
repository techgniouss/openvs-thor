/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentRequest, AgentStep, ApiFetchOptions, ChatMessage, ChatProvider, ChatRequest, ModelEntry,
	ProviderInfo, RetryInfo, StreamChatResult, ToolCall, apiFetch, describeHttpError, readSSE,
} from './types';

/**
 * Base implementation for any backend that speaks the OpenAI Chat Completions API
 * (OpenAI itself, NVIDIA's `integrate.api.nvidia.com`, local gateways, etc.).
 * Subclasses only need to supply `info`.
 */
export abstract class OpenAICompatibleProvider implements ChatProvider {
	abstract readonly info: ProviderInfo;

	/** Extra request body fields (e.g. sampling defaults). Overridable by subclasses. */
	protected extraBody(): Record<string, unknown> {
		return {};
	}

	/** Extra request headers (e.g. OpenRouter's app attribution). Overridable by subclasses. */
	protected extraHeaders(): Record<string, string> {
		return {};
	}

	/**
	 * Whether the backend accepts an assistant history turn that carries BOTH `content`
	 * and `tool_calls`. OpenAI does; some gateways (notably NVIDIA) reject the combination
	 * with HTTP 400 ("Assistant message must have either content or tool_calls, but not
	 * both") — those override this to false and the narration text is dropped from the
	 * serialized turn (it was already streamed to the user; the tool calls drive the loop).
	 */
	protected allowsContentWithToolCalls(): boolean {
		return true;
	}

	protected url(baseUrl: string, path: string): string {
		return `${baseUrl.replace(/\/+$/, '')}${path}`;
	}

	protected authHeaders(apiKey: string): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		// Keyless local endpoints (Ollama, LM Studio, …) don't want an Authorization
		// header at all; providers that require a key are gated before reaching here.
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		return { ...headers, ...this.extraHeaders() };
	}

	/**
	 * Streaming chat POSTs get a longer first-byte window than the 60s default: free
	 * tiers (notably NVIDIA's) queue requests server-side and can take well over a
	 * minute to start responding on busy or cold models. One retry only — retrying a
	 * queued request just re-enters the same queue.
	 */
	private static readonly STREAM_FETCH_OPTS = { timeoutMs: 150_000, retries: 1 } as const;

	/**
	 * Fetch options for a streaming POST, augmented with an `onRetry` hook that streams a
	 * short, transient notice (rate limit / slow start) to the user via `onToken` so an
	 * auto-retry doesn't look like a silent hang. 429 gets its own patient budget inside
	 * {@link apiFetch}.
	 */
	private streamFetchOpts(onToken?: (delta: string) => void): ApiFetchOptions {
		return {
			...OpenAICompatibleProvider.STREAM_FETCH_OPTS,
			onRetry: (info: RetryInfo) => {
				if (!onToken) {
					return;
				}
				const secs = Math.max(1, Math.ceil(info.delayMs / 1000));
				const why = info.reason === 'rate-limit' ? `Rate limited by ${this.info.label}`
					: info.reason === 'timeout' ? `${this.info.label} is slow to start`
						: 'Transient error';
				onToken(`\n\n> ⏳ ${why} — retrying in ${secs}s…\n\n`);
			},
		};
	}

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		const response = await apiFetch(this.url(request.baseUrl, '/chat/completions'), {
			method: 'POST',
			headers: { ...this.authHeaders(request.apiKey), 'Accept': 'text/event-stream' },
			body: JSON.stringify({
				model: request.model,
				messages: request.messages.map(m => serializeMessage(m, this.allowsContentWithToolCalls())),
				max_tokens: request.maxTokens,
				stream: true,
				...this.extraBody(),
			}),
		}, request.signal, this.streamFetchOpts(request.onToken));

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		// Reasoning models (DeepSeek-R1, QwQ, some Nemotrons) stream their chain of
		// thought as `reasoning_content` before any `content`. Dropping it made those
		// models look dead for minutes; surface it, separated from the final answer.
		let phase: 'idle' | 'reasoning' | 'answer' = 'idle';
		let truncated = false;
		await readSSE(response, data => {
			try {
				const json = JSON.parse(data);
				if (json?.choices?.[0]?.finish_reason === 'length') {
					truncated = true;
				}
				const delta = json?.choices?.[0]?.delta;
				const reasoning: string | undefined = delta?.reasoning_content;
				if (typeof reasoning === 'string' && reasoning) {
					if (phase === 'idle') {
						request.onToken('🤔 *Thinking…*\n\n');
						phase = 'reasoning';
					}
					request.onToken(reasoning);
				}
				const content: string | undefined = delta?.content;
				if (typeof content === 'string' && content) {
					if (phase === 'reasoning') {
						request.onToken('\n\n---\n\n');
					}
					phase = 'answer';
					request.onToken(content);
				}
			} catch {
				// Skip malformed chunks.
			}
		}, request.signal);
		return { truncated };
	}

	async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const response = await apiFetch(this.url(baseUrl, '/models'), {
			method: 'GET',
			headers: this.authHeaders(apiKey),
		}, signal);
		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}
		const json = await response.json();
		const ids: string[] = (json?.data ?? [])
			.map((m: { id?: string }) => m?.id)
			.filter((id: unknown): id is string => typeof id === 'string');
		return ids.sort((a, b) => a.localeCompare(b)).map(id => ({ id }));
	}

	async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		const response = await apiFetch(this.url(request.baseUrl, '/chat/completions'), {
			method: 'POST',
			headers: { ...this.authHeaders(request.apiKey), 'Accept': 'text/event-stream' },
			body: JSON.stringify({
				model: request.model,
				messages: request.messages.map(m => serializeMessage(m, this.allowsContentWithToolCalls())),
				max_tokens: request.maxTokens,
				tools: request.tools.map(t => ({
					type: 'function',
					function: { name: t.name, description: t.description, parameters: t.parameters },
				})),
				tool_choice: 'auto',
				stream: true,
				...this.extraBody(),
			}),
		}, request.signal, this.streamFetchOpts(request.onToken));

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		// Accumulate the streamed assistant turn: text deltas plus tool-call fragments
		// (OpenAI streams tool_calls piece-by-piece, keyed by index).
		let content = '';
		let reasoning = '';
		let truncated = false;
		const acc = new Map<number, { id?: string; name?: string; args: string }>();
		await readSSE(response, data => {
			let json: any;
			try {
				json = JSON.parse(data);
			} catch {
				return;
			}
			if (json?.choices?.[0]?.finish_reason === 'length') {
				truncated = true;
			}
			const delta = json?.choices?.[0]?.delta;
			if (!delta) {
				return;
			}
			// Stream reasoning for visibility, but keep it out of the recorded turn.
			if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
				if (!reasoning) {
					request.onToken?.('🤔 *Thinking…*\n\n');
				}
				reasoning += delta.reasoning_content;
				request.onToken?.(delta.reasoning_content);
			}
			if (typeof delta.content === 'string' && delta.content) {
				if (reasoning && !content) {
					request.onToken?.('\n\n---\n\n');
				}
				content += delta.content;
				request.onToken?.(delta.content);
			}
			for (const tc of delta.tool_calls ?? []) {
				const index: number = typeof tc.index === 'number' ? tc.index : 0;
				const cur = acc.get(index) ?? { args: '' };
				if (tc.id) { cur.id = tc.id; }
				if (tc.function?.name) { cur.name = tc.function.name; }
				if (typeof tc.function?.arguments === 'string') { cur.args += tc.function.arguments; }
				acc.set(index, cur);
			}
		}, request.signal);

		const toolCalls: ToolCall[] = [...acc.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([index, tc]) => {
				let args: Record<string, unknown> = {};
				try {
					args = tc.args ? JSON.parse(tc.args) : {};
				} catch {
					args = { _raw: tc.args };
				}
				return { id: tc.id ?? `call_${index}`, name: tc.name ?? 'unknown', args };
			});
		// A reasoning model that produced no answer and no tool calls would otherwise
		// yield an empty step; fall back to its reasoning so the agent loop can react.
		return { content: content || (toolCalls.length ? '' : reasoning), toolCalls, truncated };
	}
}

/** Serializes an internal message into the OpenAI Chat Completions wire format. */
function serializeMessage(m: ChatMessage, contentWithToolCalls: boolean): Record<string, unknown> {
	if (m.role === 'assistant' && m.toolCalls?.length) {
		return {
			role: 'assistant',
			content: contentWithToolCalls ? (m.content || null) : null,
			tool_calls: m.toolCalls.map(tc => ({
				id: tc.id,
				type: 'function',
				function: { name: tc.name, arguments: JSON.stringify(tc.args) },
			})),
		};
	}
	if (m.role === 'tool') {
		return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
	}
	if (m.images?.length) {
		const parts: Record<string, unknown>[] = [];
		if (m.content) {
			parts.push({ type: 'text', text: m.content });
		}
		for (const img of m.images) {
			parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
		}
		return { role: m.role, content: parts };
	}
	return { role: m.role, content: m.content };
}
