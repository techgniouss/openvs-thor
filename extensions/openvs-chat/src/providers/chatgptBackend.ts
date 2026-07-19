/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatgptSessionId, decodeJwtClaims } from '../oauth';
import {
	AgentRequest, AgentStep, ChatMessage, ChatRequest, FinishReason, STREAM_FETCH_OPTS,
	StreamChatResult, ToolCall, apiFetch, describeHttpError, readSSE, retryNotice,
} from './types';

/**
 * Transport for ChatGPT subscription sign-ins (no API key): talks to the ChatGPT
 * Codex backend, which speaks the OpenAI Responses API and accepts the OAuth access
 * token from the web sign-in flow. Used by {@link OpenAIProvider} whenever the
 * stored credential is an OAuth token (a JWT) rather than an `sk-` API key.
 */

const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Models the ChatGPT backend accepts (Codex-enabled models only). */
export const CHATGPT_MODELS = ['gpt-5', 'gpt-5-codex', 'codex-mini-latest'];

/** True when the stored OpenAI credential is a ChatGPT OAuth access token. */
export function isChatGptToken(apiKey: string): boolean {
	return apiKey.startsWith('eyJ') && apiKey.split('.').length === 3;
}

function accountId(accessToken: string): string {
	const claims = decodeJwtClaims(accessToken);
	const auth = claims?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
	const id = auth?.['chatgpt_account_id'];
	if (typeof id !== 'string') {
		throw new Error('ChatGPT sign-in token is missing the account id. Please sign in again.');
	}
	return id;
}

function headers(accessToken: string): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'Accept': 'text/event-stream',
		'Authorization': `Bearer ${accessToken}`,
		'chatgpt-account-id': accountId(accessToken),
		'OpenAI-Beta': 'responses=experimental',
		'originator': 'codex_cli_rs',
		'session_id': chatgptSessionId,
	};
}

/** The backend only serves Codex models; map anything else onto the default. */
function normalizeModel(model: string): string {
	return CHATGPT_MODELS.includes(model) ? model : CHATGPT_MODELS[0];
}

type ResponseItem = Record<string, unknown>;

/**
 * Maps internal messages to Responses API input items. System messages are handled
 * separately (they become the request's `instructions`).
 */
function toInputItems(messages: ChatMessage[]): ResponseItem[] {
	const items: ResponseItem[] = [];
	for (const m of messages) {
		if (m.role === 'system') {
			continue;
		}
		if (m.role === 'tool') {
			items.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content });
			continue;
		}
		if (m.role === 'assistant' && m.toolCalls?.length) {
			if (m.content) {
				items.push(textMessage('assistant', m.content));
			}
			for (const tc of m.toolCalls) {
				items.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.args) });
			}
			continue;
		}
		if (m.role === 'user' && m.images?.length) {
			const content: ResponseItem[] = m.images.map(img => ({
				type: 'input_image',
				image_url: `data:${img.mimeType};base64,${img.data}`,
			}));
			if (m.content) {
				content.push({ type: 'input_text', text: m.content });
			}
			items.push({ type: 'message', role: 'user', content });
			continue;
		}
		if (m.content) {
			items.push(textMessage(m.role === 'assistant' ? 'assistant' : 'user', m.content));
		}
	}
	return items;
}

function textMessage(role: 'user' | 'assistant', text: string): ResponseItem {
	return {
		type: 'message',
		role,
		content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
	};
}

function systemText(messages: ChatMessage[]): string {
	return messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
		|| 'You are a helpful coding assistant.';
}

interface StreamResult {
	content: string;
	toolCalls: ToolCall[];
	/** True when the response stopped because it hit the model's output-token ceiling. */
	truncated: boolean;
	/** Normalized stop reason, when the backend reported a terminal event. */
	finishReason?: FinishReason;
}

async function streamResponses(
	label: string,
	accessToken: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
	onToken?: (delta: string) => void,
	onNotice?: (text: string) => void,
): Promise<StreamResult> {
	const response = await apiFetch(CHATGPT_RESPONSES_URL, {
		method: 'POST',
		headers: headers(accessToken),
		body: JSON.stringify(body),
	}, signal, {
		...STREAM_FETCH_OPTS,
		onRetry: info => onNotice?.(retryNotice(label, info)),
	});
	if (!response.ok) {
		throw new Error(await describeHttpError(label, response));
	}

	let content = '';
	let truncated = false;
	let finishReason: FinishReason | undefined;
	const toolCalls: ToolCall[] = [];
	await readSSE(response, data => {
		let event: any;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		switch (event?.type) {
			case 'response.output_text.delta':
				if (typeof event.delta === 'string') {
					content += event.delta;
					onToken?.(event.delta);
				}
				break;
			case 'response.output_item.done': {
				const item = event.item;
				if (item?.type === 'function_call' && typeof item.name === 'string') {
					let args: Record<string, unknown> = {};
					try {
						args = item.arguments ? JSON.parse(item.arguments) : {};
					} catch {
						args = { _raw: item.arguments };
					}
					toolCalls.push({ id: item.call_id ?? item.id ?? '', name: item.name, args });
				}
				break;
			}
			case 'response.completed':
				finishReason = toolCalls.length ? 'tool_calls' : 'stop';
				break;
			case 'response.incomplete': {
				const reason = event?.response?.incomplete_details?.reason;
				truncated = reason === 'max_output_tokens';
				// Any other incomplete reason (content filter, …) is a real stop the user
				// must hear about, not a quietly-shortened answer.
				finishReason = truncated ? 'length' : 'filtered';
				break;
			}
			case 'response.failed':
			case 'error':
				throw new Error(`${label}: ${event?.response?.error?.message ?? event?.message ?? 'stream error'}`);
		}
	}, signal, { label, sawTerminal: () => finishReason !== undefined });
	return { content, toolCalls, truncated, finishReason };
}

export async function chatgptStreamChat(label: string, request: ChatRequest): Promise<StreamChatResult> {
	const { truncated, finishReason } = await streamResponses(label, request.apiKey, {
		model: normalizeModel(request.model),
		instructions: systemText(request.messages),
		input: toInputItems(request.messages),
		max_output_tokens: request.maxTokens,
		store: false,
		stream: true,
	}, request.signal, request.onToken, request.onNotice);
	return { truncated, finishReason };
}

export async function chatgptAgentStep(label: string, request: AgentRequest): Promise<AgentStep> {
	return streamResponses(label, request.apiKey, {
		model: normalizeModel(request.model),
		instructions: systemText(request.messages),
		input: toInputItems(request.messages),
		max_output_tokens: request.maxTokens,
		tools: request.tools.map(t => ({
			type: 'function',
			name: t.name,
			description: t.description,
			strict: false,
			parameters: t.parameters,
		})),
		tool_choice: 'auto',
		parallel_tool_calls: false,
		store: false,
		stream: true,
	}, request.signal, request.onToken, request.onNotice);
}
