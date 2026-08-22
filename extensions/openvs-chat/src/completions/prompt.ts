/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '../providers/types';
import { CompletionWindow } from './types';

/**
 * Stop sequences for the chat fallback. A fence marks the model starting to explain itself;
 * a triple newline marks it having finished the code and moved on to prose.
 */
export const COMPLETION_STOP: string[] = ['```', '\n\n\n'];

/**
 * Stop sequences for a real fill-in-the-middle request. Deliberately not
 * {@link COMPLETION_STOP}: a FIM endpoint is not a chat model, so it never emits a fence —
 * that stop token would simply never fire — and a triple newline is far looser than a
 * ~96-token completion needs. A single blank line is the right bound here.
 */
export const FIM_STOP: string[] = ['\n\n'];

/**
 * Instruction for the chat fallback path.
 *
 * Every prohibition here maps to a repair rule in `sanitize.ts`. Stating them does not make
 * the sanitizer optional — weaker free-tier models ignore the instruction routinely — but it
 * measurably reduces how often the repair is needed, and repair is lossy.
 */
const SYSTEM = [
	'You are a code completion engine. Continue the code at the cursor.',
	'Output only the text to insert. No explanation, no commentary, no markdown, no code fences.',
	'Do not repeat any code that appears before or after the cursor.',
	'Complete the current statement or block only. Stop as soon as it is finished.',
].join(' ');

/**
 * Builds the two-turn prompt for a completion on a backend with no fill-in-the-middle
 * endpoint. Stateless by design: no conversation history, no rules block, no skills. An
 * agent step can afford a large prompt because it runs a handful of times; this runs once
 * per typing pause, and everything in it is paid for again each time.
 */
export function buildChatPrompt(window: CompletionWindow): ChatMessage[] {
	const parts = [
		`Language: ${window.languageId}`,
		`File: ${window.relativePath}`,
	];
	if (window.imports.trim()) {
		parts.push(`Imports in this file:\n${window.imports}`);
	}
	parts.push(
		`Code before the cursor:\n${window.prefix}`,
		`Code after the cursor:\n${window.suffix}`,
		'Insert at the cursor:',
	);
	return [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: parts.join('\n\n') },
	];
}
