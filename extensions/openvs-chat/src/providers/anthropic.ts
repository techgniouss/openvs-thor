/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentRequest, AgentStep, ChatMessage, ChatProvider, ChatRequest, FinishReason, ModelEntry,
	ProviderInfo, STREAM_FETCH_OPTS, StreamChatResult, ToolCall, apiFetch, describeHttpError,
	normalizeFinishReason, readSSE, retryNotice,
} from './types';

const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';
/**
 * Subscription (Claude account) OAuth tokens are only served when the request
 * identifies as Anthropic's first-party CLI, which requires this exact text as the
 * first system block.
 */
const CLAUDE_CODE_SYSTEM = 'You are Claude Code, Anthropic\'s official CLI for Claude.';

/** True when the credential came from the Claude web sign-in (not an API key). */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.startsWith('sk-ant-oat');
}

/**
 * Provider for the Anthropic Messages API (Claude). Anthropic differs from the
 * OpenAI shape: the system prompt is a top-level field, messages carry content
 * blocks, and tool calls arrive as `tool_use` blocks.
 */
export class AnthropicProvider implements ChatProvider {
	readonly info: ProviderInfo = {
		id: 'anthropic',
		label: 'Anthropic (Claude)',
		suggestedModels: [
			'claude-fable-5',
			'claude-sonnet-5',
			'claude-opus-4-8',
			'claude-sonnet-4-5',
			'claude-haiku-4-5',
		],
		apiKeyUrl: 'https://console.anthropic.com/settings/keys',
		requiresApiKey: true,
		supportsTools: true,
		// Every Claude 3+ family model supports tool use (claude-3-*, claude-sonnet-4,
		// claude-opus-4-8, claude-fable-5, claude-mythos-5, future claude-*-6, ...).
		toolModelPatterns: ['claude-3', 'claude-[a-z]+-[4-9]', 'claude-[4-9]'],
		// Every Claude 3+ family model is multimodal.
		visionModelPatterns: ['claude-3', 'claude-[a-z]+-[4-9]', 'claude-[4-9]'],
		// The Messages API continues a trailing assistant turn in place (prefill),
		// which gives seamless auto-continuation after a max-token cutoff.
		supportsAssistantPrefill: true,
	};

	private url(baseUrl: string, path: string): string {
		return `${baseUrl.replace(/\/+$/, '')}${path}`;
	}

	private headers(apiKey: string): Record<string, string> {
		if (isOAuthToken(apiKey)) {
			return {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
				'anthropic-version': ANTHROPIC_VERSION,
				'anthropic-beta': OAUTH_BETA,
			};
		}
		return {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
		};
	}

	async streamChat(request: ChatRequest): Promise<StreamChatResult> {
		const { system, messages } = splitSystem(request.messages);
		const response = await apiFetch(this.url(request.baseUrl, '/messages'), {
			method: 'POST',
			headers: this.headers(request.apiKey),
			body: JSON.stringify({
				model: request.model,
				max_tokens: request.maxTokens,
				system: buildSystem(system, isOAuthToken(request.apiKey)),
				messages: withCacheBreakpoint(toAnthropicMessages(messages)),
				stream: true,
			}),
		}, request.signal, {
			...STREAM_FETCH_OPTS,
			onRetry: info => request.onNotice?.(retryNotice(this.info.label, info)),
		});

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		let truncated = false;
		let finishReason: FinishReason | undefined;
		await readSSE(response, data => {
			// Parsing is the only thing guarded: a mid-stream `error` event must propagate,
			// not be mistaken for a malformed chunk and swallowed (which used to return the
			// partial answer as if it had completed normally).
			let json: any;
			try {
				json = JSON.parse(data);
			} catch {
				return;
			}
			if (json?.type === 'content_block_delta' && typeof json?.delta?.text === 'string') {
				request.onToken(json.delta.text);
			} else if (json?.type === 'message_delta' && json?.delta?.stop_reason) {
				finishReason = normalizeFinishReason(json.delta.stop_reason);
				truncated = finishReason === 'length';
			} else if (json?.type === 'error') {
				throw new Error(`${this.info.label}: ${json?.error?.message ?? 'stream error'}`);
			}
		}, request.signal, { label: this.info.label, sawTerminal: () => finishReason !== undefined });
		return { truncated, finishReason };
	}

	async listModels(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<ModelEntry[]> {
		const response = await apiFetch(this.url(baseUrl, '/models'), {
			method: 'GET',
			headers: this.headers(apiKey),
		}, signal);
		if (!response.ok) {
			// Subscription tokens are scoped to inference; if the models endpoint
			// rejects them, fall back to the known-good models rather than failing.
			if (isOAuthToken(apiKey) && (response.status === 401 || response.status === 403)) {
				return this.info.suggestedModels.map(id => ({ id }));
			}
			throw new Error(await describeHttpError(this.info.label, response));
		}
		const json = await response.json();
		const ids: string[] = (json?.data ?? [])
			.map((m: { id?: string }) => m?.id)
			.filter((id: unknown): id is string => typeof id === 'string');
		return ids.sort((a, b) => a.localeCompare(b)).map(id => ({ id }));
	}

	async runAgentStep(request: AgentRequest): Promise<AgentStep> {
		const { system, messages } = splitSystem(request.messages);
		const response = await apiFetch(this.url(request.baseUrl, '/messages'), {
			method: 'POST',
			headers: this.headers(request.apiKey),
			body: JSON.stringify({
				model: request.model,
				max_tokens: request.maxTokens,
				system: buildSystem(system, isOAuthToken(request.apiKey)),
				messages: withCacheBreakpoint(toAnthropicMessages(messages)),
				tools: request.tools.map(t => ({
					name: t.name,
					description: t.description,
					input_schema: t.parameters,
				})),
				stream: true,
			}),
		}, request.signal, {
			...STREAM_FETCH_OPTS,
			onRetry: info => request.onNotice?.(retryNotice(this.info.label, info)),
		});

		if (!response.ok) {
			throw new Error(await describeHttpError(this.info.label, response));
		}

		// Accumulate streamed content blocks: text deltas plus tool_use blocks whose JSON
		// input arrives as incremental `input_json_delta` fragments.
		let content = '';
		let truncated = false;
		let finishReason: FinishReason | undefined;
		const blocks = new Map<number, { type?: string; id?: string; name?: string; json: string }>();
		await readSSE(response, data => {
			let event: any;
			try {
				event = JSON.parse(data);
			} catch {
				return;
			}
			if (event?.type === 'message_delta' && event?.delta?.stop_reason) {
				finishReason = normalizeFinishReason(event.delta.stop_reason);
				truncated = finishReason === 'length';
			}
			if (event?.type === 'content_block_start') {
				const cb = event.content_block ?? {};
				blocks.set(event.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
			} else if (event?.type === 'content_block_delta') {
				const d = event.delta ?? {};
				if (d.type === 'text_delta' && typeof d.text === 'string') {
					content += d.text;
					request.onToken?.(d.text);
				} else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
					const b = blocks.get(event.index);
					if (b) { b.json += d.partial_json; }
				}
			} else if (event?.type === 'error') {
				throw new Error(`${this.info.label}: ${event?.error?.message ?? 'stream error'}`);
			}
		}, request.signal, { label: this.info.label, sawTerminal: () => finishReason !== undefined });

		const toolCalls: ToolCall[] = [...blocks.entries()]
			.filter(([, b]) => b.type === 'tool_use')
			.sort((a, b) => a[0] - b[0])
			.map(([, b]) => {
				let input: Record<string, unknown> = {};
				try {
					input = b.json ? JSON.parse(b.json) : {};
				} catch {
					input = { _raw: b.json };
				}
				return { id: b.id ?? '', name: b.name ?? 'unknown', args: input };
			});
		return { content, toolCalls, truncated, finishReason };
	}
}

/**
 * Builds the top-level `system` field. OAuth (subscription) tokens require the
 * first-party CLI identity as the first block, with the real system prompt appended
 * as a second block; API keys skip that identity block. Always returns an array (never
 * a plain string) so the last block can carry a cache breakpoint.
 */
function buildSystem(system: string, oauth: boolean): ({ type: 'text'; text: string } & CacheControl)[] | undefined {
	const blocks: ({ type: 'text'; text: string } & CacheControl)[] = [];
	if (oauth) {
		blocks.push({ type: 'text', text: CLAUDE_CODE_SYSTEM });
	}
	if (system) {
		blocks.push({ type: 'text', text: system });
	}
	if (!blocks.length) {
		return undefined;
	}
	// One breakpoint after the system prompt: tools + system form a stable prefix
	// the API can serve from cache on every subsequent step of a run.
	blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
	return blocks;
}

function splitSystem(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
	const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
	return { system, messages: messages.filter(m => m.role !== 'system') };
}

type CacheControl = { cache_control?: { type: 'ephemeral' } };
type AnthropicBlock = CacheControl & (
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string });
type AnthropicMsg = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

/**
 * Maps internal messages (plain chat *and* tool calls/results) to Anthropic's block
 * format. Anthropic requires strictly alternating user/assistant turns starting with a
 * user turn, so this merges consecutive same-role messages into a single turn — without
 * this, an attached-context user message followed by a history user message would be two
 * consecutive `user` turns and the API would reject the request (HTTP 400).
 */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMsg[] {
	const out: AnthropicMsg[] = [];
	const append = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
		if (!blocks.length) {
			return;
		}
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.content.push(...blocks);
		} else {
			out.push({ role, content: blocks });
		}
	};

	for (const m of messages) {
		if (m.role === 'tool') {
			append('user', [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }]);
		} else if (m.role === 'assistant' && m.toolCalls?.length) {
			const blocks: AnthropicBlock[] = [];
			if (m.content) {
				blocks.push({ type: 'text', text: m.content });
			}
			for (const tc of m.toolCalls) {
				blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
			}
			append('assistant', blocks);
		} else if (m.content || m.images?.length) {
			const blocks: AnthropicBlock[] = (m.images ?? []).map(img => ({
				type: 'image',
				source: { type: 'base64', media_type: img.mimeType, data: img.data },
			}));
			if (m.content) {
				blocks.push({ type: 'text', text: m.content });
			}
			append(m.role === 'assistant' ? 'assistant' : 'user', blocks);
		}
	}

	// Anthropic requires the first turn to be from the user.
	if (out.length && out[0].role === 'assistant') {
		out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
	}
	return out;
}

/**
 * Marks the final content block as a cache breakpoint, so the whole conversation up
 * to this request is a cache hit on the next step (the API caches the longest
 * previously-seen prefix; the moving breakpoint extends it step by step).
 */
function withCacheBreakpoint(msgs: AnthropicMsg[]): AnthropicMsg[] {
	const last = msgs[msgs.length - 1];
	const block = last?.content[last.content.length - 1];
	if (block) {
		block.cache_control = { type: 'ephemeral' };
	}
	return msgs;
}
