/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage, ToolCall, ToolSpec } from '../providers/types';

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

/** Estimated token cost of one message, including its per-message overhead. */
function estimateMessageTokens(m: ChatMessage): number {
	let total = estimateTokens(m.content) + 4;
	for (const call of m.toolCalls ?? []) {
		total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args)) + 4;
	}
	// A base64 image is bulky on the wire; count it so a chat full of screenshots
	// doesn't sail past the budget undetected.
	for (const img of m.images ?? []) {
		total += estimateTokens(img.data);
	}
	return total;
}

/**
 * Estimated token cost of the tool schemas, which every agent request carries alongside
 * the conversation.
 *
 * Counted because they are not free and not small: the built-in set alone serializes to
 * roughly 1.9k tokens, and a connected MCP server can add several times that with no
 * upper bound. Budgeting against the messages alone therefore understated every agent
 * request by a fixed amount — enough, on a 32k-window model, to push a request the budget
 * called safe over the real limit, which costs a wasted round trip on the halve-and-retry
 * path and delays compaction that should already have run.
 */
export function estimateToolsTokens(tools: ToolSpec[]): number {
	let total = 0;
	for (const tool of tools) {
		// Serialized rather than measured field by field: the JSON punctuation of a nested
		// parameter schema is most of its cost, and omitting it would repeat the original
		// mistake at a smaller scale.
		total += estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	}
	return total;
}

/** Estimated token cost of a whole conversation, including per-message overhead. */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
	let total = 0;
	for (const m of messages) {
		total += estimateMessageTokens(m);
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

	// Running total, adjusted by each edit rather than recomputed from scratch.
	//
	// Both passes below used to call `estimateMessagesTokens(trimmed)` per iteration, each
	// walk re-measuring every message (and re-`JSON.stringify`-ing every tool call) in the
	// conversation. That is quadratic in transcript length on a function called before
	// EVERY agent step, so a long run spent an increasing share of each step re-counting
	// characters it had already counted. Tracking the delta is exact — the same helper
	// measures the message before and after — and turns both passes linear.
	let total = estimateMessagesTokens(trimmed);

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
		if (total <= budget) {
			break;
		}
		const before = estimateMessageTokens(trimmed[i]);
		// Keep the head: the start of a file or command output usually identifies it.
		trimmed[i] = { ...trimmed[i], content: `${trimmed[i].content.slice(0, 200)}\n\n${TRIM_MARKER}` };
		total += estimateMessageTokens(trimmed[i]) - before;
	}

	// Pass 2: still too big, so drop whole middle turns oldest-first, leaving one note
	// behind so the model can tell that history was removed rather than never happened.
	if (total > budget) {
		const floor = Math.max(start, trimmed.length - KEEP_RECENT_TURNS);
		let cut = 0;
		// `dropped` mirrors the slice the loop condition used to rebuild and re-measure.
		let dropped = 0;
		while (start + cut < floor && total - dropped > budget) {
			dropped += estimateMessageTokens(trimmed[start + cut]);
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
	// Pass 3: the recent tool output this function normally protects is, at this point, the
	// only thing left over budget — one fresh file read is 24k characters, so on a small
	// budget it can exceed the whole allowance by itself. Protecting it meant returning a
	// conversation that does NOT fit the budget the caller asked for, which the caller then
	// sent and the provider refused. A shortened result the model can ask for again beats a
	// request that is rejected outright, so the protection yields rather than the budget.
	if (total > budget) {
		for (let i = start; i < trimmed.length; i++) {
			if (total <= budget) {
				break;
			}
			if (trimmed[i].role !== 'tool' || trimmed[i].content.length < MIN_TRIMMABLE) {
				continue;
			}
			const before = estimateMessageTokens(trimmed[i]);
			trimmed[i] = { ...trimmed[i], content: `${trimmed[i].content.slice(0, 200)}\n\n${TRIM_MARKER}` };
			total += estimateMessageTokens(trimmed[i]) - before;
		}
	}
	// Final safety net: drop any tool result whose originating assistant tool_call did not
	// survive the trim (e.g. it fell just inside the protected recent tail). An orphaned
	// tool message makes providers reject the whole request with HTTP 400.
	return dropOrphanToolResults(trimmed);
}

/** Left where a tool result was elided because later output replaced it outright. */
export const SUPERSEDED_MARKER = '[superseded by later output in this conversation]';

/** Left where an old tool result was elided to keep each step's prompt small. */
export const DECAY_MARKER = '[older tool output elided to keep each step small — read it again if you need it]';

/** Options for {@link pruneToolOutput}, so this module stays free of the tool layer. */
export interface PruneOptions {
	/** Names of the tools that only read; their results are what may be elided. */
	readTools: readonly string[];
	/** The tool that replaces a file wholesale, making every earlier read of it dead. */
	wholeFileWriteTool: string;
	/** Results are kept verbatim until this many assistant turns have followed them. */
	keepRecentTurns?: number;
	/** Results shorter than this cost more in markers than they save. */
	minChars?: number;
}

/**
 * Elides tool output that the model no longer needs sent, *regardless of budget*.
 *
 * {@link trimMessages} is a correctness guard: it fires only once a request would not fit.
 * That leaves a large-window model re-sending a hundred thousand tokens of dead file dumps
 * on every step, at full price, because they technically fit — an agent step re-sends the
 * whole conversation, so a single 6k-token file read is paid for again on every remaining
 * step of the run. Fitting and being worth sending are different questions, and only the
 * first one was being asked.
 *
 * Three rules, all of which leave the model strictly no worse informed:
 *
 * 1. A read whose *identical* call appears again later — the earlier copy is dominated by
 *    the later one, which is still in the transcript verbatim.
 * 2. A read of a path that a later `write_file` replaced wholesale. The new content is in
 *    that call's own arguments, so nothing is lost. `edit_file` deliberately does **not**
 *    count: a targeted replacement leaves the old dump mostly accurate, and eliding it
 *    would force a re-read that costs more than the elision saved.
 * 3. Anything older than `keepRecentTurns` assistant turns, which is the working-set
 *    boundary the trimming pass already uses.
 *
 * Callers **must** feed the result through {@link elidedToolCallIds} and forget the
 * corresponding reads — see `AgentRunner.forgetElidedReads`. A read whose content no longer
 * reaches the model but which the repeat-read breaker still calls "already read" is a
 * deadlock: the model cannot see the content and is refused the call that would show it.
 */
export function pruneToolOutput(messages: ChatMessage[], options: PruneOptions): ChatMessage[] {
	const minChars = options.minChars ?? MIN_TRIMMABLE;
	const keepRecent = options.keepRecentTurns ?? KEEP_RECENT_TURNS;
	const reads = new Set(options.readTools);

	/** Every tool call in the transcript, by the id its result carries. */
	const callOf = new Map<string, ToolCall>();
	for (const m of messages) {
		for (const call of m.toolCalls ?? []) {
			callOf.set(call.id, call);
		}
	}

	// Last index at which each identical read, and each wholesale write, appears. Both are
	// "what is the newest thing that makes an older message redundant", so one pass fills
	// them and a second compares each message against them.
	const lastRead = new Map<string, number>();
	const lastWrite = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const call = toolCallFor(messages[i], callOf);
		if (!call) {
			continue;
		}
		if (reads.has(call.name)) {
			lastRead.set(callSignature(call), i);
		} else if (call.name === options.wholeFileWriteTool) {
			const path = pathKey(call);
			if (path) {
				lastWrite.set(path, i);
			}
		}
	}

	// The boundary is expressed in assistant turns rather than messages because a step can
	// append any number of tool results; counting messages would protect a different amount
	// of history depending on how many calls the last steps happened to make.
	const ageBoundary = assistantTurnBoundary(messages, keepRecent);

	let changed = false;
	const out = messages.map((m, i) => {
		const call = toolCallFor(m, callOf);
		if (!call || m.content.length < minChars) {
			return m;
		}
		const marker = elisionReason(call, i, { reads, lastRead, lastWrite, ageBoundary });
		if (!marker) {
			return m;
		}
		changed = true;
		// The head is kept for the same reason trimming keeps it: the first line of a file
		// dump or a command's output is usually what identifies it, and a model that can see
		// *what* was elided asks for the right thing back.
		return { ...m, content: `${m.content.slice(0, 200)}\n\n${marker}` };
	});
	return changed ? out : messages;
}

/** Why `call`'s result at `index` need not be sent, or undefined when it must be. */
function elisionReason(
	call: ToolCall,
	index: number,
	ctx: {
		reads: Set<string>;
		lastRead: Map<string, number>;
		lastWrite: Map<string, number>;
		ageBoundary: number;
	},
): string | undefined {
	if (ctx.reads.has(call.name)) {
		const newerRead = ctx.lastRead.get(callSignature(call));
		if (newerRead !== undefined && newerRead > index) {
			return SUPERSEDED_MARKER;
		}
		const path = pathKey(call);
		const newerWrite = path ? ctx.lastWrite.get(path) : undefined;
		if (newerWrite !== undefined && newerWrite > index) {
			return SUPERSEDED_MARKER;
		}
	}
	return index < ctx.ageBoundary ? DECAY_MARKER : undefined;
}

/** The call that produced `m`, when `m` is a tool result whose call is in the transcript. */
function toolCallFor(m: ChatMessage, callOf: Map<string, ToolCall>): ToolCall | undefined {
	return m.role === 'tool' && m.toolCallId ? callOf.get(m.toolCallId) : undefined;
}

/** Identity of a call for "the same call ran again" purposes: name plus sorted arguments. */
function callSignature(call: ToolCall): string {
	const args = Object.keys(call.args).sort().map(k => `${k}=${JSON.stringify(call.args[k])}`).join(',');
	return `${call.name}(${args})`;
}

/**
 * A call's `path` argument, normalized enough to compare two spellings of one file.
 *
 * Deliberately crude — this module cannot reach the editor's real path resolution without
 * taking a dependency on `vscode`. A normalization miss simply fails to elide, which is the
 * safe direction: the cost is tokens, never a message the model needed and didn't get.
 */
function pathKey(call: ToolCall): string | undefined {
	const path = call.args.path;
	return typeof path === 'string' && path ? path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() : undefined;
}

/** Index of the `keepRecent`-th assistant turn counted back from the end, or 0. */
function assistantTurnBoundary(messages: ChatMessage[], keepRecent: number): number {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'assistant' && ++seen >= keepRecent) {
			return i;
		}
	}
	return 0;
}

/**
 * Tool-call ids whose result reached the model differently in `after` than in `before` —
 * shortened, replaced by a marker, or dropped from the conversation altogether.
 *
 * Compared by id and content rather than by position because every pass that shrinks a
 * conversation may also splice it, and an index is meaningless afterwards. Whether the
 * content was elided proactively, trimmed to fit, or dropped wholesale doesn't matter to
 * the caller: in all three cases the model can no longer read it, which is the only fact
 * the repeat-read breaker needs.
 */
export function elidedToolCallIds(before: ChatMessage[], after: ChatMessage[]): string[] {
	const sent = new Map<string, string>();
	for (const m of after) {
		if (m.role === 'tool' && m.toolCallId) {
			sent.set(m.toolCallId, m.content);
		}
	}
	const out: string[] = [];
	for (const m of before) {
		if (m.role === 'tool' && m.toolCallId && sent.get(m.toolCallId) !== m.content) {
			out.push(m.toolCallId);
		}
	}
	return out;
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
 * Whether a failed request was rejected for being too big, as opposed to any other 400.
 *
 * Two different ceilings produce this, and the caller's response to both is the same —
 * send less. The model's context window is the obvious one. The other is a per-request
 * token allowance imposed by the *gateway* rather than the model: Groq's free tier answers
 * HTTP 413 "Request too large … on tokens per minute (TPM): Limit 8000" for a model whose
 * window is 128k, so a budget derived from the window alone overshoots by an order of
 * magnitude on every single step.
 *
 * The 413 phrasings are matched on their own words ("request too large", "reduce your
 * message size") and not on "tokens per minute", which also appears in the HTTP 429 body
 * for the same limit — and a 429 must stay a wait-and-retry rather than becoming a shrink.
 */
export function isContextLengthError(message: string): boolean {
	const m = message.toLowerCase();
	return m.includes('context length')
		|| m.includes('context_length')
		|| m.includes('context window')
		|| m.includes('maximum context')
		|| m.includes('too many tokens')
		|| m.includes('request too large')
		|| m.includes('reduce your message size')
		|| (m.includes('token') && m.includes('exceed'));
}

/** Smallest stated ceiling believed to be a real token budget. */
const MIN_STATED_LIMIT = 1_000;

/**
 * Patterns a backend uses to state, in the rejection itself, how many tokens one request
 * may carry. First hit wins, so the explicit "Limit N" of a gateway allowance is preferred
 * over the model's own window when a message happens to quote both.
 */
const STATED_LIMITS: RegExp[] = [
	/\blimit(?:\s+(?:of|is))?[\s:]+([\d,]{3,9})\b/i,
	/maximum context length is\s+([\d,]{3,9})\b/i,
];

/**
 * The per-request token ceiling a rejection names, when it names one.
 *
 * Worth parsing rather than just halving the budget: halving is blind, and a ceiling two
 * orders of magnitude below the assumed one (8k stated against a 120k budget) survives
 * several halvings, so the run dies having burned a retry on each. The stated number takes
 * the budget to something that fits in a single step.
 *
 * Deliberately conservative — anything under {@link MIN_STATED_LIMIT} is treated as a
 * misparse (a request id, a version, a "limit 3" on something that isn't tokens) rather
 * than as an unusable budget.
 */
export function parseTokenLimit(message: string): number | undefined {
	for (const pattern of STATED_LIMITS) {
		const match = pattern.exec(message);
		const value = match ? Number(match[1].replace(/,/g, '')) : NaN;
		if (Number.isFinite(value) && value >= MIN_STATED_LIMIT) {
			return value;
		}
	}
	return undefined;
}
