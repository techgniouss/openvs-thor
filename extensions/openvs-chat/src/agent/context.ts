/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '../providers/types';

/**
 * Conversation-window management. A long agent run accumulates every file it read and
 * every command it ran, so without trimming the request eventually exceeds the model's
 * context window and the provider rejects it outright — which the user experiences as
 * the chat dying mid-task. These helpers are pure so they can be unit-tested without a
 * provider or the extension host.
 */

/** Marker left in place of content that was dropped, so the model knows it is missing. */
export const TRIM_MARKER = '[earlier tool output trimmed to fit the context window]';

/**
 * How many trailing messages are protected from each pass. Shortening an old file dump
 * is cheap, so only the last couple of turns are off-limits; dropping whole turns loses
 * the model's reasoning trail, so that pass protects a much longer tail.
 */
const KEEP_RECENT_TOOL_OUTPUT = 2;
const KEEP_RECENT_TURNS = 6;

/** Tool results shorter than this aren't worth trimming — the marker costs nearly as much. */
const MIN_TRIMMABLE = 400;

/**
 * Rough token estimate. Deliberately cheap and dependency-free: ~4 characters per token
 * is close enough across English prose, code and JSON to decide *when* to trim, and being
 * approximate is safe because the budget is set well below the real context window.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Estimated token cost of a whole conversation, including per-message overhead. */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
	let total = 0;
	for (const m of messages) {
		total += estimateTokens(m.content) + 4;
		for (const call of m.toolCalls ?? []) {
			total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args)) + 4;
		}
		// A base64 image is bulky on the wire; count it so a chat full of screenshots
		// doesn't sail past the budget undetected.
		for (const img of m.images ?? []) {
			total += estimateTokens(img.data);
		}
	}
	return total;
}

/**
 * Shrinks a conversation to fit `budget` estimated tokens, oldest and bulkiest first.
 *
 * The system prompt, the original request, and the {@link KEEP_RECENT} most recent turns
 * are always preserved — they carry the task and its current state. Everything in between
 * is reduced by shortening old tool results (file dumps, command output), which is where
 * essentially all the weight is. Assistant/user prose is never rewritten, so the model's
 * own reasoning trail stays intact.
 *
 * Returns the original array unchanged when it already fits, so the common case is free.
 */
export function trimMessages(messages: ChatMessage[], budget: number): ChatMessage[] {
	if (budget <= 0 || estimateMessagesTokens(messages) <= budget) {
		return messages;
	}
	const trimmed = [...messages];
	// Never touch the system prompt or the first user turn: they carry the task itself.
	const firstUser = trimmed.findIndex(m => m.role === 'user');
	const start = Math.max(firstUser + 1, trimmed.findIndex(m => m.role !== 'system'));

	// Pass 1: shorten the biggest tool results, newest couple excluded — the model is
	// usually still working with those.
	const candidates = [];
	for (let i = start; i < trimmed.length - KEEP_RECENT_TOOL_OUTPUT; i++) {
		if (trimmed[i].role === 'tool' && trimmed[i].content.length >= MIN_TRIMMABLE) {
			candidates.push(i);
		}
	}
	candidates.sort((a, b) => trimmed[b].content.length - trimmed[a].content.length);
	for (const i of candidates) {
		if (estimateMessagesTokens(trimmed) <= budget) {
			break;
		}
		// Keep the head: the start of a file or command output usually identifies it.
		trimmed[i] = { ...trimmed[i], content: `${trimmed[i].content.slice(0, 200)}\n\n${TRIM_MARKER}` };
	}

	// Pass 2: still too big, so drop whole middle turns oldest-first, leaving one note
	// behind so the model can tell that history was removed rather than never happened.
	if (estimateMessagesTokens(trimmed) > budget) {
		const floor = Math.max(start, trimmed.length - KEEP_RECENT_TURNS);
		let cut = 0;
		while (start + cut < floor && estimateMessagesTokens(trimmed.slice(0, start).concat(trimmed.slice(start + cut))) > budget) {
			cut++;
		}
		// Extend the cut past any tool results left at the boundary: keeping a `tool`
		// message whose assistant tool_call was just dropped is an orphan the API rejects.
		while (start + cut < trimmed.length && trimmed[start + cut].role === 'tool') {
			cut++;
		}
		if (cut > 0) {
			trimmed.splice(start, cut, {
				role: 'user',
				content: `[${cut} earlier message(s) removed to fit the context window — ask again if you need details from them]`,
			});
		}
	}
	// Final safety net: drop any tool result whose originating assistant tool_call did not
	// survive the trim (e.g. it fell just inside the protected recent tail). An orphaned
	// tool message makes providers reject the whole request with HTTP 400.
	return dropOrphanToolResults(trimmed);
}

/** Removes `tool` messages whose matching assistant tool_call id is not present earlier. */
export function dropOrphanToolResults(messages: ChatMessage[]): ChatMessage[] {
	const seen = new Set<string>();
	const out: ChatMessage[] = [];
	for (const m of messages) {
		for (const call of m.toolCalls ?? []) {
			seen.add(call.id);
		}
		if (m.role === 'tool' && m.toolCallId && !seen.has(m.toolCallId)) {
			continue;
		}
		out.push(m);
	}
	return out;
}

/**
 * Whether a failed request was rejected for exceeding the model's context window, as
 * opposed to any other 400. Providers word this differently but all mention the window.
 */
export function isContextLengthError(message: string): boolean {
	const m = message.toLowerCase();
	return m.includes('context length')
		|| m.includes('context_length')
		|| m.includes('context window')
		|| m.includes('maximum context')
		|| m.includes('too many tokens')
		|| (m.includes('token') && m.includes('exceed'));
}
