/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage, ChatProvider, streamChatWithContinuation } from '../providers/types';
import { isContextLengthError, parseTokenLimit, trimMessages } from './context';
import { budgetsForCeiling } from './contextWindow';

export interface BudgetedStreamRequest {
	readonly messages: ChatMessage[];
	readonly model: string;
	readonly apiKey: string;
	readonly baseUrl: string;
	/** Tokens to reserve for the reply, already clamped to any known allowance. */
	readonly maxTokens: number;
	/** Estimated-token ceiling for the conversation; anything above it is trimmed away. */
	readonly contextBudget: number;
	readonly signal: AbortSignal;
	readonly onToken: (delta: string) => void;
	readonly onNotice: (text: string) => void;
}

/**
 * Streams one reply inside a token budget, retrying once inside the ceiling a backend
 * names when it refuses the request as too large.
 *
 * Both halves matter and neither is optional. Without the trim a long conversation grows
 * until the provider rejects it outright; without the retry the very first message of a
 * session on a backend whose allowance has never been seen fails, because there are no
 * response headers to learn from until a response exists.
 *
 * Shared by the plain streaming path and the Auto pipeline's plan/review phases. Those
 * phases used to send the conversation raw with the unclamped configured reservation,
 * which is why an Auto run on a small per-request allowance (Groq's 8k free tier) died in
 * the planner before the implementer ever started.
 */
export async function streamBudgeted(
	provider: ChatProvider,
	request: BudgetedStreamRequest,
): Promise<{ text: string; truncated: boolean }> {
	const send = (contextBudget: number, maxTokens: number) => streamChatWithContinuation(provider, {
		messages: trimMessages(request.messages, contextBudget),
		model: request.model,
		apiKey: request.apiKey,
		baseUrl: request.baseUrl,
		maxTokens,
		signal: request.signal,
		onToken: request.onToken,
		onNotice: request.onNotice,
	});
	try {
		return await send(request.contextBudget, request.maxTokens);
	} catch (err) {
		const stated = err instanceof Error && isContextLengthError(err.message)
			? parseTokenLimit(err.message)
			: undefined;
		if (!stated) {
			throw err;
		}
		const { reply, conversation } = budgetsForCeiling(stated, request.maxTokens);
		request.onNotice(`${provider.info.label} caps a request at ${stated} tokens — retrying within that limit.`);
		return send(conversation, reply);
	}
}
