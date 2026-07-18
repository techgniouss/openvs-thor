/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolSpec } from '../providers/types';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item of the agent's visible task checklist. */
export interface TodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MAX_ITEMS = 30;
const MAX_CONTENT = 200;

/**
 * Task-checklist tool offered to the top-level agent (TodoWrite semantics: every call
 * replaces the whole list). Mutates chat UI state only — never the workspace — so it
 * is auto-approved and not guarded.
 */
export const UPDATE_TODOS_TOOL: ToolSpec = {
	name: 'update_todos',
	description: 'Replace your visible task checklist. Send the FULL list every time (it overwrites the previous one). Use it at the start of any multi-step task, keep exactly one item in_progress, and update it immediately when an item completes. An empty list clears the checklist.',
	parameters: {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				description: 'The complete, ordered checklist.',
				items: {
					type: 'object',
					properties: {
						content: { type: 'string', description: 'Short, outcome-shaped description of the step.' },
						status: { type: 'string', enum: STATUSES, description: 'Current state of this step.' },
					},
					required: ['content', 'status'],
				},
			},
		},
		required: ['items'],
	},
};

/**
 * Validates an update_todos call's arguments into a clean item list. Returns an
 * error string (for the tool result) instead of throwing on bad model output.
 */
export function parseTodoUpdate(args: Record<string, unknown>): { items: TodoItem[] } | { error: string } {
	const raw = args.items;
	if (!Array.isArray(raw)) {
		return { error: 'update_todos requires an "items" array (send the complete checklist).' };
	}
	if (raw.length > MAX_ITEMS) {
		return { error: `Too many todo items (${raw.length}); keep the checklist under ${MAX_ITEMS}.` };
	}
	const items: TodoItem[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) {
			return { error: 'Each todo item must be an object with "content" and "status".' };
		}
		const content = typeof (entry as Record<string, unknown>).content === 'string'
			? ((entry as Record<string, unknown>).content as string).trim().slice(0, MAX_CONTENT)
			: '';
		const status = (entry as Record<string, unknown>).status;
		if (!content) {
			return { error: 'Todo "content" must be a non-empty string.' };
		}
		if (typeof status !== 'string' || !STATUSES.includes(status as TodoStatus)) {
			return { error: `Todo "status" must be one of: ${STATUSES.join(', ')}.` };
		}
		items.push({ content, status: status as TodoStatus });
	}
	return { items };
}
