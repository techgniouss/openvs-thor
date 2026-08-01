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
 * The outcome of {@link parseTodoUpdate}: either a clean list or the message to hand
 * back to the model. Discriminated on `error` rather than by key presence so callers can
 * narrow with a plain comparison.
 */
export type TodoUpdate =
	| { readonly items: TodoItem[]; readonly error?: undefined }
	| { readonly items?: undefined; readonly error: string };

/** Names models use for the list itself, and for an item's text. */
const LIST_KEYS = ['items', 'todos', 'tasks', 'checklist', 'list', 'steps'];
const CONTENT_KEYS = ['content', 'task', 'title', 'text', 'description', 'name', 'step', 'todo'];

/**
 * Status spellings mapped onto ours. A checklist rejected wholesale because one item said
 * "done" instead of "completed" costs a step and teaches the model nothing about which item
 * was wrong — and the checklist is what the completion gate reads, so losing it turns a
 * tracked run into an untracked one.
 */
const STATUS_ALIASES: Record<string, TodoStatus> = {
	pending: 'pending', todo: 'pending', 'to_do': 'pending', 'to-do': 'pending', open: 'pending',
	not_started: 'pending', notstarted: 'pending', queued: 'pending', waiting: 'pending', new: 'pending',
	in_progress: 'in_progress', 'in-progress': 'in_progress', inprogress: 'in_progress', active: 'in_progress',
	doing: 'in_progress', started: 'in_progress', current: 'in_progress', running: 'in_progress', 'working': 'in_progress',
	completed: 'completed', complete: 'completed', done: 'completed', finished: 'completed',
	closed: 'completed', resolved: 'completed', success: 'completed', cancelled: 'completed', canceled: 'completed',
	skipped: 'completed',
};

/**
 * Validates an update_todos call's arguments into a clean item list. Returns an
 * error string (for the tool result) instead of throwing on bad model output.
 *
 * Deliberately forgiving about shape, strict about substance. The list is the model's own
 * plan and the thing the completion gate checks it against, so the cost of rejecting a
 * usable-but-oddly-spelled call is much higher than the cost of accepting it: the run
 * either loses its checklist or spends steps re-sending it. Only a call with no recoverable
 * item text is refused.
 */
export function parseTodoUpdate(args: Record<string, unknown>): TodoUpdate {
	const key = LIST_KEYS.find(k => Array.isArray(args[k]));
	const raw = key ? args[key] as unknown[] : undefined;
	if (!raw) {
		return { error: `update_todos requires an "items" array (send the complete checklist). Received: ${Object.keys(args).join(', ') || 'no arguments'}.` };
	}
	if (raw.length > MAX_ITEMS) {
		return { error: `Too many todo items (${raw.length}); keep the checklist under ${MAX_ITEMS}.` };
	}
	const items: TodoItem[] = [];
	for (const entry of raw) {
		// A bare string is a complete, unambiguous item — models send them constantly, and
		// the only thing missing is a status, which defaults to the sensible one.
		if (typeof entry === 'string') {
			const content = entry.trim().slice(0, MAX_CONTENT);
			if (content) {
				items.push({ content, status: 'pending' });
			}
			continue;
		}
		if (typeof entry !== 'object' || entry === null) {
			return { error: 'Each todo item must be an object with "content" and "status", or a plain string.' };
		}
		const fields = entry as Record<string, unknown>;
		const contentKey = CONTENT_KEYS.find(k => typeof fields[k] === 'string' && (fields[k] as string).trim());
		const content = contentKey ? (fields[contentKey] as string).trim().slice(0, MAX_CONTENT) : '';
		if (!content) {
			return { error: `Todo "content" must be a non-empty string. One item had only: ${Object.keys(fields).join(', ') || 'no fields'}.` };
		}
		// An unrecognized or missing status defaults to pending rather than failing the call:
		// "pending" is the safe reading, because the completion gate then keeps chasing the
		// item instead of letting the run end with it silently marked done.
		const rawStatus = typeof fields.status === 'string' ? fields.status.trim().toLowerCase() : '';
		items.push({ content, status: STATUS_ALIASES[rawStatus] ?? 'pending' });
	}
	return { items };
}
