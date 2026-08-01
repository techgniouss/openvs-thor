/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolCall } from './types';

/**
 * Marker key for arguments that could not be parsed at all. The tool layer recognizes it
 * and reports the raw text back to the model, which is recoverable; the previous `_raw`
 * key was not — every tool simply saw its required arguments missing and answered with a
 * message ("an empty path was supplied") that never mentioned the real problem.
 */
export const MALFORMED_ARGS = '__malformedArgs';

/**
 * Parses the `arguments` string of a tool call, repairing the malformations non-frontier
 * models routinely emit.
 *
 * Frontier models return clean JSON, so this is a no-op for them. Smaller models — the
 * ones behind NVIDIA NIM, DashScope, Ollama and most gateways — do not: they wrap the JSON
 * in a code fence, use Python literals, leave a trailing comma, or double-encode the whole
 * object as a JSON string. Every one of those used to become an un-actionable tool error
 * and a wasted step, which is the bulk of why a run with a weak model goes nowhere.
 */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> {
	const text = (raw ?? '').trim();
	if (!text) {
		return {};
	}
	const direct = tryParse(text);
	if (direct) {
		return direct;
	}
	for (const candidate of repairs(text)) {
		const parsed = tryParse(candidate);
		if (parsed) {
			return parsed;
		}
	}
	return { [MALFORMED_ARGS]: text };
}

/** Parses to a plain object, unwrapping one level of double-encoding. */
function tryParse(text: string): Record<string, unknown> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	// Some gateways JSON-encode the arguments string a second time, so the first parse
	// yields the original string rather than the object.
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Successively more aggressive rewrites of `text`, each a candidate for re-parsing. */
function* repairs(text: string): Generator<string> {
	const unfenced = stripFence(text);
	if (unfenced !== text) {
		yield unfenced;
	}
	const body = firstObject(unfenced) ?? unfenced;
	if (body !== unfenced) {
		yield body;
	}
	const literals = body
		.replace(/(^|[[{,:]\s*)True(\s*[,}\]]|$)/g, '$1true$2')
		.replace(/(^|[[{,:]\s*)False(\s*[,}\]]|$)/g, '$1false$2')
		.replace(/(^|[[{,:]\s*)(None|NaN|undefined)(\s*[,}\]]|$)/g, '$1null$3');
	const commas = literals.replace(/,\s*([}\]])/g, '$1');
	if (commas !== body) {
		yield commas;
	}
	const closed = closeOpenBrackets(commas);
	if (closed !== commas) {
		yield closed;
	}
}

/** Removes a surrounding ``` fence, with or without a language tag. */
function stripFence(text: string): string {
	const match = /^```[a-zA-Z0-9+#._-]*\s*\n?([\s\S]*?)\n?```$/.exec(text.trim());
	return match ? match[1].trim() : text;
}

/**
 * The first balanced `{…}` in `text`, so a model that narrated around its JSON
 * ("Here are the arguments: {…}") still gets the object read. Quoted braces are ignored.
 */
function firstObject(text: string): string | undefined {
	const start = text.indexOf('{');
	if (start === -1) {
		return undefined;
	}
	const end = objectEnd(text, start);
	return end === -1 ? undefined : text.slice(start, end);
}

/**
 * Index just past the `}` closing the object that starts at `start`, or -1 if it is never
 * closed. Quoted and escaped braces are skipped, so a nested object — or a brace inside a
 * string argument, which `edit_file` calls are full of — does not end the scan early.
 */
function objectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === '\\') {
			escaped = true;
		} else if (ch === '"') {
			inString = !inString;
		} else if (!inString && ch === '{') {
			depth++;
		} else if (!inString && ch === '}' && --depth === 0) {
			return i + 1;
		}
	}
	return -1;
}

/**
 * Closes brackets and a trailing string left open by a reply that was cut off mid-object.
 * A truncated `edit_file` call is still worth recovering: the arguments before the cut are
 * intact, and the tool's own error ("oldText not found") is far more useful to the model
 * than being told its arguments were unreadable.
 */
function closeOpenBrackets(text: string): string {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === '\\') {
			escaped = true;
		} else if (ch === '"') {
			inString = !inString;
		} else if (!inString && (ch === '{' || ch === '[')) {
			stack.push(ch);
		} else if (!inString && (ch === '}' || ch === ']')) {
			stack.pop();
		}
	}
	if (!inString && !stack.length) {
		return text;
	}
	// A dangling `"key":` or `,` would still not parse once the braces are closed.
	let body = text;
	if (inString) {
		body += '"';
	}
	body = body.replace(/[,:]\s*$/, '');
	return body + stack.reverse().map(open => open === '{' ? '}' : ']').join('');
}

/** One tool call recovered from assistant prose, and where it sat in the text. */
interface TextCall {
	readonly call: ToolCall;
	readonly start: number;
	readonly end: number;
}

/**
 * Wrapper syntaxes models emit when they mean to call a tool but the request never became
 * a real `tool_calls` entry: Hermes/Qwen `<tool_call>`, Llama `<function=name>`, and the
 * generic `<function_call>` / `<invoke>` forms. A match here is unambiguous, so the tool
 * name is accepted even if it is not one of ours — the tool layer's "there is no tool
 * called X, here are the ones you have" is a better answer than silently ignoring it.
 */
const WRAPPERS: RegExp[] = [
	/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
	/<function_call>\s*([\s\S]*?)\s*<\/function_call>/g,
	/<\|tool_call\|>\s*([\s\S]*?)\s*(?:<\|\/tool_call\|>|$)/g,
];

/** Llama 3.1's form, where the name is in the tag and the body is bare arguments. */
const NAMED_WRAPPER = /<function=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/function>/g;

/** A fenced `{"name": …, "arguments": …}` block. The fence delimits it, so a regex suffices. */
const FENCED_CALL = /```(?:json|tool_call|tool_code)?\s*\n?(\{[\s\S]*?\})\s*\n?```/g;

/**
 * Start of a bare `{"name": …}` object in the prose. Only the opening is matched here —
 * the extent is found by balanced scan, because a non-greedy regex stops at the first `}`,
 * which for any call with nested arguments is the wrong one and leaves a stray brace
 * behind in the visible text.
 */
const BARE_CALL_START = /\{\s*"(?:name|tool|tool_name|function)"\s*:/g;

/**
 * Recovers tool calls a model wrote into its message text instead of returning through the
 * API's tool-call channel, and returns the text with those blocks removed.
 *
 * This is the difference between "works with any model" and "works with the three models
 * that have solid function calling". A model that emits `<tool_call>{…}</tool_call>` as
 * prose produces a step with text and no tool calls, which the agent loop reads as "it
 * finished and summarized" — so the run ends having done nothing, which is exactly the
 * failure of a run that appears to work and goes nowhere.
 *
 * `known` gates only the ambiguous forms (a bare or fenced JSON object): those also occur
 * in legitimate answers about JSON, so they are accepted only when the name is a tool that
 * really exists this run.
 */
export function extractTextToolCalls(content: string, known: ReadonlySet<string>): { calls: ToolCall[]; text: string } {
	if (!content.includes('{') && !content.includes('<function=')) {
		return { calls: [], text: content };
	}
	const found: TextCall[] = [];

	for (const pattern of WRAPPERS) {
		pattern.lastIndex = 0;
		for (let m = pattern.exec(content); m; m = pattern.exec(content)) {
			const call = toCall(m[1]);
			if (call) {
				found.push({ call, start: m.index, end: m.index + m[0].length });
			}
		}
	}
	NAMED_WRAPPER.lastIndex = 0;
	for (let m = NAMED_WRAPPER.exec(content); m; m = NAMED_WRAPPER.exec(content)) {
		found.push({
			call: { id: '', name: m[1], args: parseToolArgs(m[2]) },
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	FENCED_CALL.lastIndex = 0;
	for (let m = FENCED_CALL.exec(content); m; m = FENCED_CALL.exec(content)) {
		const call = toCall(m[1]);
		if (call && known.has(call.name)) {
			found.push({ call, start: m.index, end: m.index + m[0].length });
		}
	}
	BARE_CALL_START.lastIndex = 0;
	for (let m = BARE_CALL_START.exec(content); m; m = BARE_CALL_START.exec(content)) {
		const end = objectEnd(content, m.index);
		if (end === -1) {
			continue;
		}
		const call = toCall(content.slice(m.index, end));
		if (call && known.has(call.name)) {
			found.push({ call, start: m.index, end });
		}
	}
	if (!found.length) {
		return { calls: [], text: content };
	}

	// Overlaps happen when two patterns match the same block (a `<tool_call>` whose body is
	// also a bare JSON call). Earliest-first, then skip anything inside an accepted span.
	found.sort((a, b) => a.start - b.start);
	const kept: TextCall[] = [];
	let consumed = -1;
	for (const entry of found) {
		if (entry.start >= consumed) {
			kept.push(entry);
			consumed = entry.end;
		}
	}

	let text = '';
	let at = 0;
	for (const entry of kept) {
		text += content.slice(at, entry.start);
		at = entry.end;
	}
	text += content.slice(at);
	return {
		calls: kept.map((entry, i) => ({ ...entry.call, id: entry.call.id || `text_call_${i}` })),
		text: text.trim(),
	};
}

/** Reads a `{name, arguments}` object into a {@link ToolCall}, or undefined if it isn't one. */
function toCall(body: string | undefined): ToolCall | undefined {
	if (!body) {
		return undefined;
	}
	const parsed = parseToolArgs(body);
	if (parsed[MALFORMED_ARGS] !== undefined) {
		return undefined;
	}
	const name = String(parsed.name ?? parsed.tool ?? parsed.tool_name ?? parsed.function ?? '').trim();
	if (!name) {
		return undefined;
	}
	const rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.args ?? parsed.input ?? {};
	const args = typeof rawArgs === 'string'
		? parseToolArgs(rawArgs)
		: (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {});
	return { id: '', name, args };
}
