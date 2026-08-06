/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { MALFORMED_ARGS } from '../providers/toolCalls';
import { ToolCall, ToolSpec, isAbortError } from '../providers/types';
import { Guardrails, WorkspacePath, autoApproves, autoApprovesWrites, checkCommand, checkPath, describeWorkspaceUri, loadGuardrails, normalizeWorkspacePath, resolveWorkspacePath } from './guardrails';
import { resolveAgentShell } from './shell';

/**
 * Most bytes of a file that are decoded for one read_file call. Well above the page cap
 * so any offset the model asks for is reachable, but bounded so a multi-megabyte bundle
 * isn't pulled through the decoder.
 */
const MAX_DECODE_BYTES = 1_000_000;
/**
 * Default character cap for one read_file result — a whole-file dump eats the context
 * budget for the rest of the run.
 *
 * ~6k tokens. The cap is not really about this one result: an agent step re-sends the
 * whole conversation, so a read is paid for again on every later step. Four 48k-char
 * reads used to put ~48k tokens of file text into every subsequent prompt for the rest of
 * the run. Reads are paged rather than lost — each truncated result names the offset to
 * continue from — so the cost of a tighter cap is one extra call on the rare file that
 * genuinely needs reading whole.
 */
const MAX_READ_CHARS = 24_000;

/**
 * Per-call caps the agent loop can tighten below the module defaults.
 *
 * The defaults are sized for a normal context window. They are the wrong size when the
 * backend's per-request token allowance is far smaller than the model's window — Groq's
 * free tier serves a 128k-window model with an 8k allowance, where one read at
 * {@link MAX_READ_CHARS} is ~6k tokens against a conversation budget of ~4k. The result
 * would be elided by trimming before the model could use a line of it, so the read has to
 * be smaller at the source. Reads are paged and each truncated result names the offset to
 * continue from, so a tighter cap costs extra calls rather than information.
 */
export interface ToolLimits {
	/** Characters one `read_file` may return, including the line-number gutter. */
	readonly maxReadChars?: number;
}

/**
 * Width of the line-number gutter prefixed to every line of a read_file result, and the
 * separator that closes it. Reads are numbered so the model can cite `path:line`, aim an
 * offset at a known line, and describe an edit site without re-reading the file to count
 * lines — recounting is the single most common reason a run reads the same file twice.
 *
 * `→` rather than a tab or a colon: it never occurs at that position in real source, so
 * {@link stripLineGutter} can strip it back off an `oldText` the model copied verbatim
 * out of a read result without risking a false positive on genuine file content.
 */
const GUTTER_WIDTH = 6;
const GUTTER_SEPARATOR = '→';
/** Per-line cost of the gutter, charged against {@link MAX_READ_CHARS} so the cap stays honest. */
const GUTTER_COST = GUTTER_WIDTH + GUTTER_SEPARATOR.length;

/** Prefixes `lines` with 1-based line numbers starting at `startLine`. */
function numberLines(lines: string[], startLine: number): string {
	return lines
		.map((line, i) => `${String(startLine + i).padStart(GUTTER_WIDTH, ' ')}${GUTTER_SEPARATOR}${line}`)
		.join('\n');
}

/** Matches the gutter this module writes, so a snippet copied out of a read can be un-numbered. */
const GUTTER_RE = new RegExp(`^ *\\d+${GUTTER_SEPARATOR}`);

/**
 * Removes the read_file line-number gutter from a snippet, or returns undefined when the
 * snippet isn't numbered.
 *
 * Models routinely paste an `oldText` straight out of a numbered read result. Failing that
 * edit with "oldText was not found" teaches them nothing — they re-read the same file and
 * try again — so the gutter is stripped and the edit retried instead. Every non-blank line
 * must carry a gutter, or this isn't numbered output and the text is left alone.
 */
function stripLineGutter(text: string): string | undefined {
	const lines = text.split('\n');
	const numbered = lines.filter(l => l.trim());
	if (!numbered.length || !numbered.every(l => GUTTER_RE.test(l))) {
		return undefined;
	}
	return lines.map(l => l.replace(GUTTER_RE, '')).join('\n');
}

/** The tools exposed to the model in Agent mode. */
export const AGENT_TOOLS: ToolSpec[] = [
	{
		name: 'read_file',
		description: 'Read a text file in the workspace. Paths are relative to the workspace root. Large files are returned in pages — pass offset/limit to read a specific range instead of the whole file. Every line is prefixed with its line number and "→"; that gutter is display only and is NOT part of the file, so never include it in oldText, newText or content.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative file path.' },
				offset: { type: 'number', description: '1-based line number to start reading from. Omit to start at the top.' },
				limit: { type: 'number', description: 'Maximum number of lines to return. Omit for as much as fits.' },
			},
			required: ['path'],
		},
	},
	{
		name: 'list_dir',
		description: 'List the files and folders in a workspace directory. Use "." for the workspace root.',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Workspace-relative directory path.' } },
			required: ['path'],
		},
	},
	{
		name: 'glob_files',
		description: 'Find files by PATH pattern (not by content) and get back matching workspace-relative paths. Use this to locate a file whose name you know — "**/chatViewProvider.ts", "src/**/*.test.ts" — instead of walking directories with list_dir. Build output and dependency folders (node_modules, out, dist, .git, target, vendor, …) are never searched.',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/**/config.*". Matched against workspace-relative paths.' },
				limit: { type: 'number', description: 'Maximum number of paths to return. Defaults to 200.' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'search_files',
		description: 'Search for a text or regex pattern across the files in the workspace and get back matching lines as "path:line: text". Use this to locate relevant code before reading whole files.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The text (or regular expression, with isRegex) to search for. Case-insensitive.' },
				isRegex: { type: 'boolean', description: 'Treat query as a regular expression instead of literal text.' },
				glob: { type: 'string', description: 'Optional glob restricting which files are searched, e.g. "src/**/*.ts". Defaults to all files.' },
			},
			required: ['query'],
		},
	},
	{
		name: 'write_file',
		description: 'Create or overwrite a text file with the given content. Requires user approval. Paths are relative to the workspace root.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative file path.' },
				content: { type: 'string', description: 'The full new content of the file.' },
			},
			required: ['path', 'content'],
		},
	},
	{
		name: 'edit_file',
		description: 'Edit a text file by replacing exact existing snippets with new text. Requires user approval. Prefer this over write_file for changes to existing files — it avoids resending the whole file. Pass several changes to the same file at once in "edits" (applied in order, all or nothing, one approval) instead of calling this repeatedly.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative file path.' },
				oldText: { type: 'string', description: 'The exact text to replace. Must appear in the file; include enough surrounding lines to be unique. Omit when using "edits".' },
				newText: { type: 'string', description: 'The replacement text. Omit when using "edits".' },
				replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText instead of requiring it to be unique.' },
				edits: {
					type: 'array',
					description: 'Several replacements to apply to this file in one call, in order. Each is matched against the file as left by the previous ones. Use this instead of oldText/newText when you have more than one change to make.',
					items: {
						type: 'object',
						properties: {
							oldText: { type: 'string', description: 'The exact text to replace.' },
							newText: { type: 'string', description: 'The replacement text.' },
							replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
						},
						required: ['oldText', 'newText'],
					},
				},
			},
			required: ['path'],
		},
	},
	{
		name: 'run_command',
		description: 'Run a shell command and return its output. Requires user approval. Use for builds, tests, git, etc. Runs in the workspace root unless you pass "cwd".',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The shell command to run.' },
				cwd: { type: 'string', description: 'Workspace-relative directory to run in, e.g. "packages/api". Defaults to the workspace root. In a multi-root workspace, name the folder here to run inside it.' },
			},
			required: ['command'],
		},
	},
];

/** Tools that only inspect the workspace — safe to run in parallel and in read-only sub-agents. */
export const READ_ONLY_TOOL_NAMES = ['read_file', 'list_dir', 'search_files', 'glob_files'];

/**
 * Every name the model can call as a tool, including the ones the agent loop handles
 * itself. {@link runCommand} rejects a command whose executable is one of these.
 *
 * Models do emit `run_command({command: 'list_dir .'})`, and handing that to the shell
 * gets back `'list_dir' is not recognized as an internal or external command` — a message
 * that says nothing about the tool the model already has, so it burns a step and often
 * retries the same call. `update_todos` is spelled out rather than imported to keep this
 * module free of a dependency on the agent loop.
 */
const CALLABLE_TOOL_NAMES = new Set([...AGENT_TOOLS.map(t => t.name), 'ask_user', 'update_todos', 'spawn_subagent']);

/**
 * How many options an {@link ASK_USER_TOOL} call may offer. Two is the minimum for a
 * choice to be a choice; beyond four the card stops being scannable and the model
 * should be narrowing the question instead.
 */
export const MAX_ASK_OPTIONS = 4;

/**
 * Question tool: the only way the agent can put a decision back to the user and wait.
 * Handled by {@link AgentRunner} (not {@link executeTool}) because it resolves through
 * the UI rather than the workspace.
 *
 * Without this the loop had no blocking channel at all — a model that asked a question
 * in prose was pushed onward by the completion nudge, and on its second attempt the run
 * simply ended with the question stranded in the transcript.
 */
export const ASK_USER_TOOL: ToolSpec = {
	name: 'ask_user',
	description:
		'Ask the user a question and WAIT for their answer, which comes back as this tool\'s result. '
		+ 'Use it only when you are genuinely blocked on a decision that is theirs to make — an ambiguous '
		+ 'requirement, a choice between approaches with real trade-offs, or missing information you cannot '
		+ 'discover with your other tools. Do not use it to ask permission to continue work you can just do, '
		+ 'and do not use it for anything you could answer by reading the code. Offer 2-4 concrete options; '
		+ 'the user can also type an answer of their own.',
	parameters: {
		type: 'object',
		properties: {
			question: { type: 'string', description: 'The question, phrased so it can be answered by picking one of the options.' },
			options: {
				type: 'array',
				description: `The choices to offer (2-${MAX_ASK_OPTIONS}). Put your recommendation first.`,
				items: {
					type: 'object',
					properties: {
						label: { type: 'string', description: 'Short label for the choice (1-5 words).' },
						description: { type: 'string', description: 'One line on what picking this means or implies.' },
					},
					required: ['label'],
				},
			},
			multiSelect: { type: 'boolean', description: 'True when the options are not mutually exclusive and the user may pick several.' },
		},
		required: ['question', 'options'],
	},
};

/**
 * Delegation tool: lets the agent spawn a focused sub-agent with its own tool loop. Handled
 * by {@link AgentRunner} (not {@link executeTool}), since it runs a whole nested agent.
 */
export const SPAWN_SUBAGENT_TOOL: ToolSpec = {
	name: 'spawn_subagent',
	description: 'Delegate a focused, self-contained subtask to a sub-agent that has its own tool loop, then get back its summary. Use this to parallelize independent research (set readOnly:true so several can run at once) or to isolate a chunk of work. Give a complete, standalone goal — the sub-agent does not see this conversation.',
	parameters: {
		type: 'object',
		properties: {
			goal: { type: 'string', description: 'A clear, self-contained description of the subtask to accomplish.' },
			readOnly: { type: 'boolean', description: 'True if the sub-agent only needs to read/inspect (no writes or commands). Read-only sub-agents may run in parallel.' },
		},
		required: ['goal'],
	},
};

/** What kind of side effect an approval covers; also the granularity of "always allow". */
export type ApprovalKind = 'write' | 'command' | 'mcp';

/** One request for the user's permission to take a side-effecting action. */
export interface ApprovalRequest {
	readonly kind: ApprovalKind;
	/** One-line question, e.g. `Write src/foo.ts?`. */
	readonly title: string;
	/** Supporting detail rendered under the title. */
	readonly detail: string;
	/**
	 * Optional body rendered as a code block (a diff, the command, the new file
	 * content). Approving a write without seeing what changes is how a truncated
	 * response silently destroys a file.
	 */
	readonly preview?: string;
	/** Fenced-block language for {@link preview} (e.g. `diff`, `shell`). */
	readonly previewLanguage?: string;
	/**
	 * Stable identity for the action, so "always allow" can remember it for the rest of
	 * the run without blanket-approving everything of the same kind (e.g. `run_command:git`).
	 */
	readonly signature: string;
}

/** The user's answer to an {@link ApprovalRequest}. */
export interface ApprovalResult {
	readonly approved: boolean;
	/** Free text the user attached — usually why they said no, or a correction. */
	readonly feedback?: string;
}

/** One selectable answer offered by {@link ASK_USER_TOOL}. */
export interface AskOption {
	readonly label: string;
	readonly description?: string;
}

/** A question put to the user, with the options they may pick from. */
export interface UserQuestion {
	readonly question: string;
	readonly options: AskOption[];
	readonly multiSelect?: boolean;
	/**
	 * A line shown under the question. Used to surface choices that did not fit the
	 * button row, so the user can still type one rather than never learning they existed.
	 */
	readonly detail?: string;
}

/** The UI channel the tool layer uses to reach the user: approvals and questions. */
export interface ToolApprover {
	/** Asks the user to approve a side-effecting action. */
	confirm(request: ApprovalRequest): Promise<ApprovalResult>;
	/** Puts a question to the user and resolves with their answer as plain text. */
	ask(question: UserQuestion): Promise<string>;
}

export interface ToolResult {
	readonly result: string;
	readonly isError: boolean;
}

/**
 * The folder commands run in and non-path probes look at. Commands are workspace-wide and
 * have a single working directory, so in a multi-root workspace they use the first folder —
 * the same one a plain relative path resolves against.
 */
function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** A path resolved and cleared by the guardrails, or the reason it was refused. */
type Located =
	| { readonly ok: true; readonly target: WorkspacePath }
	| { readonly ok: false; readonly error: string };

/**
 * Resolves a model-supplied path onto its workspace folder and runs the guardrail check
 * against that same folder.
 *
 * The single place a path is turned into something the filesystem can touch: resolution and
 * validation happen here together, so there is no way to validate one path and then open
 * another. Callers get a {@link WorkspacePath} and never construct a URI themselves.
 */
function locate(rawPath: string, forWrite: boolean, g: Guardrails): Located {
	const target = resolveWorkspacePath(rawPath);
	if (!target) {
		return {
			ok: false,
			error: rawPath.trim()
				? `Path "${rawPath}" could not be resolved to a workspace folder.`
				: 'An empty path was supplied.',
		};
	}
	const guard = checkPath(target.root, target.relative, forWrite, g);
	if (!guard.ok) {
		return { ok: false, error: guard.reason ?? 'Path blocked.' };
	}
	return { ok: true, target };
}

/**
 * Names other agent products use for the same tools, mapped onto ours.
 *
 * Smaller and non-frontier models have these baked in from training and reach for them by
 * reflex — `bash`, `str_replace_editor`, `view` — no matter what the tool schema says. The
 * call is well-formed and the intent is unambiguous; refusing it with "Unknown tool" spends
 * a step and the model usually repeats itself. Accepting the synonym costs nothing and is
 * the difference between a weak model working and a weak model spinning.
 */
const TOOL_ALIASES: Record<string, string> = {
	bash: 'run_command', shell: 'run_command', terminal: 'run_command', execute_command: 'run_command',
	run_terminal_cmd: 'run_command', run_in_terminal: 'run_command', exec: 'run_command', command: 'run_command',
	view: 'read_file', cat: 'read_file', open_file: 'read_file', read: 'read_file', readfile: 'read_file', get_file: 'read_file',
	str_replace: 'edit_file', str_replace_editor: 'edit_file', str_replace_based_edit_tool: 'edit_file',
	apply_patch: 'edit_file', replace_in_file: 'edit_file', edit: 'edit_file', patch_file: 'edit_file',
	create_file: 'write_file', create: 'write_file', save_file: 'write_file', write: 'write_file', writefile: 'write_file',
	ls: 'list_dir', list_files: 'list_dir', list_directory: 'list_dir', dir: 'list_dir', listdir: 'list_dir',
	grep: 'search_files', grep_search: 'search_files', ripgrep: 'search_files', codebase_search: 'search_files',
	search: 'search_files', find_in_files: 'search_files',
	glob: 'glob_files', find_files: 'glob_files', file_search: 'glob_files', find: 'glob_files',
};

/**
 * Argument names other agent products use, per tool. Same reasoning as {@link TOOL_ALIASES}:
 * a model that sends `file_path` instead of `path` knows exactly which file it wants, and
 * answering "an empty path was supplied" teaches it nothing it can act on.
 */
const ARG_ALIASES: Record<string, Record<string, string>> = {
	read_file: { file_path: 'path', filepath: 'path', filename: 'path', file: 'path', target_file: 'path', start_line: 'offset', line_offset: 'offset', num_lines: 'limit', end_line: 'limit' },
	list_dir: { file_path: 'path', directory: 'path', dir: 'path', target_directory: 'path', relative_workspace_path: 'path' },
	write_file: { file_path: 'path', filepath: 'path', filename: 'path', file: 'path', target_file: 'path', text: 'content', contents: 'content', body: 'content', file_text: 'content' },
	edit_file: { file_path: 'path', filepath: 'path', filename: 'path', file: 'path', target_file: 'path', old_str: 'oldText', new_str: 'newText', old_string: 'oldText', new_string: 'newText', old_text: 'oldText', new_text: 'newText', search: 'oldText', replace: 'newText', replace_all: 'replaceAll' },
	search_files: { pattern: 'query', regex: 'query', search: 'query', q: 'query', text: 'query', include: 'glob', include_pattern: 'glob', is_regex: 'isRegex' },
	glob_files: { glob: 'pattern', query: 'pattern', path: 'pattern', file_pattern: 'pattern', max_results: 'limit' },
	run_command: { cmd: 'command', shell_command: 'command', script: 'command', working_directory: 'cwd', directory: 'cwd', workdir: 'cwd' },
};

/** Names models use for `edit_file`'s batch array. The first one present wins. */
const EDIT_LIST_KEYS = ['edits', 'changes', 'replacements', 'operations', 'diffs', 'edit'];

/** Renames the keys of one object through `aliases`, leaving correctly-spelled keys alone. */
function renameKeys(source: Record<string, unknown>, aliases: Record<string, string>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		const canonical = aliases[key.toLowerCase()] ?? key;
		// A correctly-spelled argument always wins over an alias for the same slot.
		if (out[canonical] === undefined || key === canonical) {
			out[canonical] = value;
		}
	}
	return out;
}

/**
 * Normalizes `edit_file`'s batch: the array's own name, and the keys of each entry inside it.
 *
 * The entries need this as much as the top level does, and for a while did not get it —
 * `edits: [{old_str, new_str}]` (Anthropic's own text-editor vocabulary, which most models
 * have seen far more of than ours) reached {@link parseEdits} unrenamed, every entry read
 * as an empty `oldText`, and the call died on "oldText must not be empty". The model had
 * supplied the anchor all along; only the key was spelled differently.
 */
function normalizeEditArgs(args: Record<string, unknown>): Record<string, unknown> {
	const out = { ...args };
	const key = EDIT_LIST_KEYS.find(k => out[k] !== undefined);
	if (key === undefined) {
		return out;
	}
	const list = out[key];
	if (key !== 'edits') {
		delete out[key];
	}
	// A single edit sent as a bare object rather than a one-element array is accepted too.
	const entries = Array.isArray(list) ? list : [list];
	out.edits = entries.map(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
		? renameKeys(entry as Record<string, unknown>, ARG_ALIASES.edit_file)
		: entry);
	return out;
}

/**
 * Reads an argument the schema declares as a string.
 *
 * JSON has types and a tool schema declares them, but a model-supplied argument is only ever
 * a suggestion: gateways that rebuild tool calls from text, and models that reason about
 * files as lists of lines, both routinely send the wrong one. An array is joined rather than
 * stringified — `String(['a','b'])` is `'a,b'`, which as file content is silent corruption —
 * and a number is accepted as its text, which is what the model meant by it.
 */
export function asString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(asString).join('\n');
	}
	return '';
}

/** Reads an argument the schema declares as a number, accepting the string form of one. */
export function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * Reads an argument the schema declares as a boolean.
 *
 * The string forms matter more than they look: `replaceAll: "true"` read as a strict
 * `=== true` is false, so the flag is dropped, the edit then matches several places, and the
 * model is told to "set replaceAll:true" — which it already did.
 */
export function asBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		return ['true', 'yes', '1', 'y'].includes(value.trim().toLowerCase());
	}
	return value === 1;
}

/**
 * Rewrites a call onto this toolset's vocabulary: a synonym for a tool name, and synonyms
 * for its argument names. Returns the call unchanged when nothing matched, and never
 * overwrites an argument the model already spelled correctly.
 */
export function normalizeToolCall(call: ToolCall): ToolCall {
	const lower = call.name.trim().toLowerCase();
	const name = CALLABLE_TOOL_NAMES.has(lower) ? lower : (TOOL_ALIASES[lower] ?? call.name);
	const aliases = ARG_ALIASES[name];
	if (!aliases) {
		return name === call.name ? call : { ...call, name };
	}
	const renamed = renameKeys(call.args, aliases);
	return { ...call, name, args: name === 'edit_file' ? normalizeEditArgs(renamed) : renamed };
}

/** Executes a single tool call, applying guardrails and prompting for approval on side effects. */
export async function executeTool(rawCall: ToolCall, approver: ToolApprover, guardrails?: Guardrails, limits?: ToolLimits): Promise<ToolResult> {
	const call = normalizeToolCall(rawCall);
	// Arguments that never parsed are reported as such, with the text quoted back. Falling
	// through would run the tool with no arguments at all, and its complaint ("an empty path
	// was supplied") points the model at the wrong problem entirely.
	if (call.args[MALFORMED_ARGS] !== undefined) {
		return {
			result: `The arguments for ${call.name} were not valid JSON, so the call could not be run. `
				+ `Send them again as a plain JSON object matching the tool's schema — no code fence, no comments, no trailing commas. `
				+ `What arrived was:\n${String(call.args[MALFORMED_ARGS]).slice(0, 800)}`,
			isError: true,
		};
	}
	const g = guardrails ?? loadGuardrails();
	const root = workspaceRoot();
	if (!root) {
		return { result: 'No workspace folder is open; file and command tools are unavailable.', isError: true };
	}
	// Side-effecting tools are blocked in untrusted workspaces, regardless of approval.
	if ((call.name === 'write_file' || call.name === 'edit_file' || call.name === 'run_command') && !vscode.workspace.isTrusted) {
		const action = call.name === 'run_command' ? 'run commands' : 'write files';
		return {
			result: `This workspace is not trusted, so the agent can't ${action}. Use "Workspaces: Manage Workspace Trust" to trust it, then retry.`,
			isError: true,
		};
	}
	// Every path-taking tool resolves through the same guarded step, so none of them can
	// reach the filesystem with a path the guardrails did not clear.
	const pathArg = (forWrite: boolean): Located => locate(asString(call.args.path) || (call.name === 'list_dir' ? '.' : ''), forWrite, g);
	try {
		switch (call.name) {
			case 'read_file': {
				const found = pathArg(false);
				return found.ok ? await readFile(found.target, asNumber(call.args.offset), asNumber(call.args.limit), limits?.maxReadChars)
					: { result: found.error, isError: true };
			}
			case 'list_dir': {
				const found = pathArg(false);
				return found.ok ? await listDir(found.target) : { result: found.error, isError: true };
			}
			case 'search_files':
				return await searchFiles(asString(call.args.query), asBoolean(call.args.isRegex), asString(call.args.glob));
			case 'glob_files':
				return await globFiles(asString(call.args.pattern), asNumber(call.args.limit));
			case 'write_file': {
				const found = pathArg(true);
				return found.ok ? await writeFile(found.target, asString(call.args.content), approver, g)
					: { result: found.error, isError: true };
			}
			case 'edit_file': {
				const found = pathArg(true);
				if (!found.ok) {
					return { result: found.error, isError: true };
				}
				const misuse = describeEditMisuse(call.args);
				return misuse
					? { result: misuse, isError: true }
					: await editFile(found.target, parseEdits(call.args), approver, g);
			}
			case 'run_command': {
				// An explicit cwd goes through the same guarded resolution as any other path,
				// so a command cannot be aimed outside the workspace.
				// A command sent as a list of steps is joined with `&&`, not newlines: the shell
				// would run every line regardless of the previous one's exit code, so a failed
				// build would be followed by a "successful" test run against stale output.
				const command = commandTextOf(call.args);
				const raw = asString(call.args.cwd).trim();
				if (!raw) {
					return await runCommand(root, '', command, approver, g);
				}
				const found = locate(raw, false, g);
				return found.ok
					? await runCommand(found.target.uri, found.target.display, command, approver, g)
					: { result: found.error, isError: true };
			}
			default:
				// Naming the real tools matters: a model that invented a name has no way to
				// recover from "Unknown tool" alone and simply calls it again next step.
				return {
					result: `There is no tool called "${rawCall.name}". The tools you have are: ${AGENT_TOOLS.map(t => t.name).join(', ')}. `
						+ 'Call one of those instead — shell programs go through run_command.',
					isError: true,
				};
		}
	} catch (err) {
		// A cancellation is not a tool failure. Reported as one, the loop would hand the
		// model "read_file failed: Aborted", it would pick a different approach, and the
		// run the user just stopped would carry on doing work.
		if (isAbortError(err)) {
			throw err;
		}
		return { result: `Tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}

async function readFile(target: WorkspacePath, offset?: number, limit?: number, maxChars = MAX_READ_CHARS): Promise<ToolResult> {
	const path = target.display;
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(target.uri);
	} catch (err) {
		// Reading a directory otherwise surfaces as a raw `EISDIR`/`FileIsADirectory`, which
		// names no tool the model could use instead — so it retries the same call. Naming
		// list_dir turns a dead end into the next step.
		const code = (err as { code?: string } | undefined)?.code ?? '';
		const message = err instanceof Error ? err.message : String(err);
		if (code === 'FileIsADirectory' || /EISDIR|is a directory/i.test(`${code} ${message}`)) {
			return { result: `${path} is a directory, not a file. Use list_dir to see what is in it.`, isError: true };
		}
		throw err;
	}
	// `stream: true` keeps a multi-byte sequence straddling the cut from decoding as U+FFFD.
	const decodeLimit = Math.max(MAX_DECODE_BYTES, maxChars);
	const partial = bytes.byteLength > decodeLimit;
	const text = new TextDecoder().decode(bytes.slice(0, decodeLimit), { stream: partial });
	const lines = text.split('\n');
	const start = offset && offset > 0 ? Math.min(offset - 1, lines.length) : 0;
	const wanted = limit && limit > 0 ? lines.slice(start, start + limit) : lines.slice(start);

	// Enforce the char cap even inside an explicit range. The gutter is charged too, or a
	// long file of short lines would return well over the cap once numbered.
	const out: string[] = [];
	let chars = 0;
	for (const line of wanted) {
		if (chars + line.length + 1 + GUTTER_COST > maxChars) {
			break;
		}
		out.push(line);
		chars += line.length + 1 + GUTTER_COST;
	}
	const end = start + out.length;
	const whole = start === 0 && end >= lines.length && !partial;
	if (whole) {
		// An empty or whitespace-only file must still say something: an empty tool result
		// is rejected by Anthropic (HTTP 400) and reads as a failure to every model.
		return { result: out.join('').trim() ? numberLines(out, 1) : `(${path} is empty)`, isError: false };
	}
	if (start >= lines.length) {
		const note = `\n\n[file has ${lines.length}${partial ? '+' : ''} lines; offset ${start + 1} is past the end of the file. No more lines to read.]`;
		return { result: numberLines(out, start + 1) + note, isError: false };
	}
	// A single line longer than the cap (minified bundle, lockfile, long data row) fills
	// no lines at all. Return the head of that line and point past it — a note offering
	// the offset just used would send a compliant model round the same call forever.
	if (!out.length) {
		const head = wanted[0].slice(0, maxChars);
		const note = `\n\n[line ${start + 1} is ${wanted[0].length} characters; showing its first ${head.length}. `
			+ (start + 1 < lines.length
				? `Call read_file with offset=${start + 2} to continue past it.]`
				: 'It is the last line of the file.]');
		return { result: numberLines([head], start + 1) + note, isError: false };
	}
	// `partial` means the decode limit cut the file short, so `lines.length` is a lower
	// bound — reaching it is NOT end of file, and saying so would tell the model a large
	// file is fully read when it is not.
	const note = end >= lines.length && !partial
		? `\n\n[file has ${lines.length} lines; showing ${start + 1}–${end}. End of file reached; no more lines to read.]`
		: `\n\n[file has ${lines.length}${partial ? '+' : ''} lines; showing ${start + 1}–${end}. Call read_file with offset=${end + 1} to continue.]`;
	return { result: numberLines(out, start + 1) + note, isError: false };
}

/** Default and hard caps on how many paths one {@link globFiles} call returns. */
const GLOB_DEFAULT_LIMIT = 200;
const GLOB_MAX_LIMIT = 1_000;

/**
 * Finds files by path pattern. Content search already existed; finding a file whose *name*
 * the model knows did not, so it had to walk the tree with `list_dir` one directory at a
 * time — several steps, and a frequent way for a run to stall before it has even located
 * the code it was asked to change.
 */
async function globFiles(pattern: string, limit?: number): Promise<ToolResult> {
	if (!pattern.trim()) {
		return { result: 'glob_files requires a non-empty "pattern".', isError: true };
	}
	const cap = Math.min(limit && limit > 0 ? limit : GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT);
	// One over the cap, so a truncated listing can be reported as truncated.
	const uris = await vscode.workspace.findFiles(toGlobPattern(pattern), SEARCH_EXCLUDE, cap + 1);
	// Rendered in the form read_file accepts — folder-prefixed when several folders are
	// open. Anything outside every folder is dropped; the model could not open it anyway.
	// Protected paths are deliberately not filtered — they are a write blocklist.
	const paths = uris
		.map(u => describeWorkspaceUri(u)?.display)
		.filter((rel): rel is string => rel !== undefined);
	if (!paths.length) {
		return {
			result: `No files match "${pattern}". Patterns are matched against workspace-relative paths — "**/" is needed to match at any depth (e.g. "**/${pattern.replace(/^\*\*\//, '')}").`,
			isError: false,
		};
	}
	const shown = paths.slice(0, cap);
	const more = paths.length > cap ? `\n[more than ${cap} matches — narrow the pattern]` : '';
	return { result: shown.join('\n') + more, isError: false };
}

async function listDir(target: WorkspacePath): Promise<ToolResult> {
	const entries = await vscode.workspace.fs.readDirectory(target.uri);
	const lines = entries.map(([name, type]) =>
		`${type === vscode.FileType.Directory ? 'dir ' : 'file'}  ${name}`);
	// Headed with the directory in the form the other tools accept. The entries are bare
	// names, so without this the model has nothing to join them onto — and in a multi-root
	// workspace it would compose them against the wrong folder, which is exactly the
	// mismatch that made every search result unopenable before.
	const header = `Contents of ${target.display}/ (paths below are relative to it):\n`;
	return { result: entries.length ? header + lines.join('\n') : `${target.display}/ is an empty directory.`, isError: false };
}

const SEARCH_MAX_FILES = 2_000;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_SKIP_FILE_BYTES = 512_000;

/**
 * Directories never worth searching, excluded explicitly.
 *
 * `findFiles(include, undefined, …)` applies only `files.exclude`, whose defaults cover
 * `.git` and little else — so on any JavaScript project the sweep spent its whole
 * 2000-file budget reading `node_modules` and reported "no matches" for code that was
 * right there. The user's own excludes still apply on top of this.
 */
const SEARCH_EXCLUDE = '**/{node_modules,bower_components,.git,.hg,.svn,out,dist,build,target,vendor,coverage,.next,.nuxt,.venv,__pycache__,.gradle,.idea,.cache}/**';

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns a model-supplied glob into one the editor can match, honouring a `folderName/…`
 * prefix the way every other path argument does.
 *
 * A plain string pattern is matched against *each* workspace folder's own relative paths,
 * so with folders `repo` and `api` open, `api/**` looks for an `api` directory inside both
 * of them and matches the folder called `api` never. Every other tool accepts that prefix —
 * the environment snapshot tells the model to use it — so a glob that silently returned
 * nothing was the one place the convention broke, and an empty result is exactly what sends
 * a model round the same search again.
 */
function toGlobPattern(pattern: string): vscode.GlobPattern {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length > 1) {
		const clean = normalizeWorkspacePath(pattern);
		const slash = clean.indexOf('/');
		if (slash > 0) {
			const folder = folders.find(f => f.name === clean.slice(0, slash));
			if (folder) {
				return new vscode.RelativePattern(folder, clean.slice(slash + 1));
			}
		}
	}
	return pattern;
}

/**
 * Searches workspace files for a pattern, returning `path:line: text` matches.
 *
 * Prefers `findTextInFiles`, which runs the editor's own ripgrep: it honours
 * `.gitignore` and the user's search excludes, never reads a file it doesn't have to,
 * and returns in a fraction of the time. Falls back to {@link searchFilesByScan} when
 * the proposed API isn't enabled for this build.
 */
async function searchFiles(query: string, isRegex: boolean, glob: string): Promise<ToolResult> {
	if (!query) {
		return { result: 'search_files requires a non-empty "query".', isError: true };
	}
	if (isRegex) {
		// Validated up front either way: ripgrep would reject it too, but with a message
		// about its own syntax rather than one the model can act on.
		try {
			new RegExp(query);
		} catch (err) {
			return { result: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
	}
	const viaRipgrep = await searchFilesByRipgrep(query, isRegex, glob);
	return viaRipgrep ?? searchFilesByScan(query, isRegex, glob);
}

/**
 * ripgrep-backed search. Returns undefined when `findTextInFiles` is unavailable (the
 * API proposal is not enabled), so the caller can fall back rather than fail.
 */
async function searchFilesByRipgrep(query: string, isRegex: boolean, glob: string): Promise<ToolResult | undefined> {
	// Feature-detected rather than assumed: the proposal is declared in package.json, but
	// a build that strips proposed APIs must degrade to the scan instead of throwing.
	if (typeof vscode.workspace.findTextInFiles !== 'function') {
		return undefined;
	}
	const matches: string[] = [];
	try {
		await vscode.workspace.findTextInFiles(
			{ pattern: query, isRegExp: isRegex, isCaseSensitive: false },
			{ include: glob ? toGlobPattern(glob) : undefined, exclude: SEARCH_EXCLUDE, maxResults: SEARCH_MAX_MATCHES },
			result => {
				// A TextSearchResult is either a match or a surrounding context line, and
				// only a match carries `preview`. Context lines are not results and must
				// not be reported as ones.
				const match = result as vscode.TextSearchMatch;
				if (matches.length >= SEARCH_MAX_MATCHES || match.preview === undefined) {
					return;
				}
				// Reported in the form read_file accepts, folder-prefixed when several are
				// open. A hit outside every workspace folder is dropped rather than offered:
				// the model could not open it, so naming it only costs a wasted step.
				const found = describeWorkspaceUri(match.uri);
				if (!found) {
					return;
				}
				const first = Array.isArray(match.ranges) ? match.ranges[0] : match.ranges;
				const line = (first?.start.line ?? 0) + 1;
				matches.push(`${found.display}:${line}: ${match.preview.text.trim().slice(0, 200)}`);
			},
		);
	} catch {
		// A search-engine failure is not fatal — the scan below still works.
		return undefined;
	}
	if (!matches.length) {
		return { result: `No matches for "${query}"${glob ? ` in ${glob}` : ''}.`, isError: false };
	}
	const capped = matches.length >= SEARCH_MAX_MATCHES ? `\n[stopped at ${SEARCH_MAX_MATCHES} matches]` : '';
	return { result: matches.join('\n') + capped, isError: false };
}

/**
 * Fallback search: enumerate candidate files and scan them here. Slower and bounded by
 * {@link SEARCH_MAX_FILES}, so it says when the sweep was incomplete rather than letting
 * a partial result read as "not used anywhere".
 */
async function searchFilesByScan(query: string, isRegex: boolean, glob: string): Promise<ToolResult> {
	let re: RegExp;
	try {
		re = new RegExp(isRegex ? query : escapeRegExp(query), 'i');
	} catch (err) {
		return { result: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
	const uris = await vscode.workspace.findFiles(glob ? toGlobPattern(glob) : '**/*', SEARCH_EXCLUDE, SEARCH_MAX_FILES);
	const matches: string[] = [];
	const decoder = new TextDecoder();
	// Read in parallel batches — thousands of sequential fs round-trips are painfully
	// slow, especially on remote/virtual workspaces.
	const BATCH = 64;
	for (let start = 0; start < uris.length && matches.length < SEARCH_MAX_MATCHES; start += BATCH) {
		const batch = uris.slice(start, start + BATCH).map(async uri => {
			const found = describeWorkspaceUri(uri);
			if (!found) {
				return undefined;
			}
			try {
				return { rel: found.display, bytes: await vscode.workspace.fs.readFile(uri) };
			} catch {
				return undefined;
			}
		});
		for (const file of await Promise.all(batch)) {
			if (!file || matches.length >= SEARCH_MAX_MATCHES) {
				continue;
			}
			if (file.bytes.byteLength > SEARCH_SKIP_FILE_BYTES || file.bytes.slice(0, 1024).includes(0)) {
				continue; // too big or binary
			}
			const lines = decoder.decode(file.bytes).split('\n');
			for (let i = 0; i < lines.length && matches.length < SEARCH_MAX_MATCHES; i++) {
				if (re.test(lines[i])) {
					matches.push(`${file.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
				}
			}
		}
	}
	// The file sweep is capped too, and silently returning a partial sweep as if it were
	// the whole workspace is how a model concludes something "isn't used anywhere".
	const partialSweep = uris.length >= SEARCH_MAX_FILES
		? `\n[only the first ${SEARCH_MAX_FILES} files were searched — narrow the search with a "glob" to cover the rest]`
		: '';
	if (!matches.length) {
		return { result: `No matches for "${query}"${glob ? ` in ${glob}` : ''}.${partialSweep}`, isError: false };
	}
	const capped = matches.length >= SEARCH_MAX_MATCHES ? `\n[stopped at ${SEARCH_MAX_MATCHES} matches]` : '';
	return { result: matches.join('\n') + capped + partialSweep, isError: false };
}

/** Lines of unchanged context kept either side of a change in {@link renderDiff}. */
const DIFF_CONTEXT_LINES = 2;
/** Cap on the rendered diff — the approval card has to stay readable. */
const DIFF_MAX_LINES = 60;

/**
 * Renders a compact `-`/`+` diff of two texts by trimming their common leading and
 * trailing lines. Not a real LCS diff, but changes in practice are localized, so this
 * shows exactly what moves at a fraction of the cost — and a wrong-but-conservative
 * result (more lines shown) is harmless for a preview.
 */
export function renderDiff(before: string, after: string): string {
	const a = before.split('\n');
	const b = after.split('\n');
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) {
		head++;
	}
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
		tail++;
	}
	const from = Math.max(0, head - DIFF_CONTEXT_LINES);
	const removed = a.slice(head, a.length - tail);
	const added = b.slice(head, b.length - tail);
	if (!removed.length && !added.length) {
		return '(no textual change)';
	}
	const lines = [
		`@@ line ${head + 1} @@`,
		...a.slice(from, head).map(l => ` ${l}`),
		...removed.map(l => `-${l}`),
		...added.map(l => `+${l}`),
		...a.slice(a.length - tail, a.length - tail + DIFF_CONTEXT_LINES).map(l => ` ${l}`),
	];
	if (lines.length > DIFF_MAX_LINES) {
		return `${lines.slice(0, DIFF_MAX_LINES).join('\n')}\n… [${lines.length - DIFF_MAX_LINES} more diff line(s)]`;
	}
	return lines.join('\n');
}

/** Reads a file's current text, or undefined when it doesn't exist yet. */
async function readIfExists(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
}

/**
 * Share of the original size below which an overwrite is treated as suspicious. A
 * response cut off mid-file is the classic way an agent turns a 2000-line source file
 * into a 200-line stub, and `auto-edits` would wave it straight through.
 */
const CLOBBER_RATIO = 0.4;
/** Files smaller than this are too short for the ratio test to mean anything. */
const CLOBBER_MIN_CHARS = 200;

async function writeFile(target: WorkspacePath, content: string, approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	const path = target.display;
	const existing = await readIfExists(target.uri);
	// A drastic shrink is never auto-approved, whatever the policy says: it is the
	// signature of a truncated model response, and the write is not reversible.
	const suspicious = existing !== undefined
		&& existing.length > CLOBBER_MIN_CHARS
		&& content.length < existing.length * CLOBBER_RATIO;

	if (suspicious || !autoApprovesWrites(g)) {
		const shrink = suspicious
			? ` ⚠ This replaces ${existing!.length} characters with ${content.length} `
			+ `(${Math.round(content.length / existing!.length * 100)}% of the original) — that usually means the response was cut off.`
			: '';
		const { approved, feedback } = await approver.confirm({
			kind: 'write',
			// Keyed by the resolved path, so "always allow" cannot be widened by spelling the
			// same file differently on the next call.
			signature: `write_file:${path}`,
			title: existing === undefined ? `Create ${path}?` : `Overwrite ${path}?`,
			detail: existing === undefined
				? `New file, ${content.split('\n').length} line(s).${shrink}`
				: `${existing.split('\n').length} line(s) → ${content.split('\n').length} line(s).${shrink}`,
			preview: existing === undefined ? content.slice(0, 4_000) : renderDiff(existing, content),
			previewLanguage: existing === undefined ? '' : 'diff',
		});
		if (!approved) {
			return { result: denialMessage('write', feedback), isError: true };
		}
	}
	await vscode.workspace.fs.writeFile(target.uri, new TextEncoder().encode(content));
	return { result: `Wrote ${content.length} characters to ${path}.`, isError: false };
}

/** One replacement within an {@link AGENT_TOOLS} `edit_file` call. */
interface FileEdit {
	readonly oldText: string;
	readonly newText: string;
	readonly replaceAll: boolean;
}

/**
 * Normalizes an `edit_file` call's arguments into a list of replacements, accepting both
 * the single `oldText`/`newText` form and the batched `edits` array. Malformed entries are
 * kept rather than dropped so {@link editFile} can name the offending index — silently
 * skipping one would report a partial edit as a complete one.
 */
function parseEdits(args: Record<string, unknown>): FileEdit[] {
	const one = (raw: Record<string, unknown>): FileEdit => ({
		oldText: asString(raw.oldText),
		newText: asString(raw.newText),
		replaceAll: asBoolean(raw.replaceAll),
	});
	if (Array.isArray(args.edits)) {
		return args.edits.map(entry => one(typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}));
	}
	return [one(args)];
}

/**
 * The mistake behind an `edit_file` call that carries no anchor at all, or undefined when
 * the call is worth attempting.
 *
 * Checked before the edit runs so the model is told what it actually did wrong. The generic
 * "oldText must not be empty" is true but unhelpful — it does not distinguish a model that
 * meant `write_file` from one that simply omitted the anchor, so the model tends to retry
 * the same shape. Naming the keys that arrived is what lets it correct itself in one step.
 */
function describeEditMisuse(args: Record<string, unknown>): string | undefined {
	if (Array.isArray(args.edits) ? args.edits.length : asString(args.oldText)) {
		return undefined;
	}
	const supplied = Object.keys(args).filter(k => k !== 'path');
	if (args.content !== undefined) {
		return 'edit_file was called with "content" but no "oldText". "content" belongs to write_file, which replaces a whole file. '
			+ 'Either call write_file with that content, or call edit_file with "oldText" (the exact text to find) and "newText" (its replacement).';
	}
	return 'edit_file needs an anchor: "oldText" (the exact existing text to find) and "newText" (what replaces it), or a non-empty "edits" array of those pairs. '
		+ `This call supplied ${supplied.length ? `only: ${supplied.join(', ')}` : 'no arguments besides the path'}. `
		+ 'To create a file or replace one entirely, use write_file instead.';
}

/** Leading whitespace of a line. */
function indentOf(line: string): string {
	return /^[ \t]*/.exec(line)![0];
}

/** A line as compared by the loose matcher: line ending and surrounding whitespace ignored. */
function normalizeLine(line: string): string {
	return line.replace(/\r$/, '').trim();
}

/**
 * One loose match, as a half-open character range into the file plus the exact text found
 * there.
 *
 * Offsets rather than just the text because the replacement has to be spliced by index.
 * `String.prototype.replace` with a string pattern is wrong twice over here: it treats `$&`,
 * `$'` and `$1` in the *replacement* as substitution patterns (so any snippet containing a
 * `$` is silently corrupted), and with two identical matches the second call re-finds the
 * first — which by then is the text just written.
 */
interface LooseMatch {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/**
 * Finds `oldText` in `current` comparing line by line with indentation, trailing
 * whitespace and line endings ignored, and returns the exact text present in the file for
 * each match.
 *
 * This is the fallback after an exact match fails, and it exists because of how the misses
 * actually look: the model reproduces the right lines but re-indents them, converts CRLF
 * to LF, or drops trailing spaces. Failing those with "oldText was not found" teaches it
 * nothing it can act on, so it re-reads the same file and tries again — the loop the user
 * sees. Matching by line keeps the result exact (the needle comes back out of the file,
 * never out of the model's copy) without the fragility of a fuzzy regex.
 *
 * Returns an empty list when `oldText` is not whole lines — a fragment inside a line either
 * matched exactly or is genuinely absent, and guessing there would be dangerous.
 */
function findLooseMatches(current: string, oldText: string): LooseMatch[] {
	const fileLines = current.split('\n');
	const oldLines = oldText.split('\n');
	// A trailing newline leaves an empty final element that must not be matched against a
	// real (blank) line; it is re-attached to the needle instead.
	const trailingNewline = oldLines.length > 1 && oldLines[oldLines.length - 1] === '';
	if (trailingNewline) {
		oldLines.pop();
	}
	if (!oldLines.some(l => l.trim())) {
		return [];
	}
	const wanted = oldLines.map(normalizeLine);
	// Offset of each line within `current`, so a match can be spliced by index rather than
	// by String.replace — see {@link LooseMatch}.
	const lineStarts: number[] = [];
	for (let i = 0, at = 0; i < fileLines.length; i++) {
		lineStarts.push(at);
		at += fileLines[i].length + 1;
	}
	const matches: LooseMatch[] = [];
	const last = fileLines.length - wanted.length - (trailingNewline ? 1 : 0);
	for (let i = 0; i <= last; i++) {
		let hit = true;
		for (let k = 0; k < wanted.length && hit; k++) {
			hit = normalizeLine(fileLines[i + k]) === wanted[k];
		}
		if (!hit) {
			continue;
		}
		const span = fileLines.slice(i, i + wanted.length).join('\n');
		// Splitting on '\n' leaves each CRLF line's '\r' on the line itself, so a span
		// that stops short of a newline still ends with the first half of one. Keeping it
		// would have the replacement swallow the '\r' and leave a lone '\n' behind — one
		// mixed line ending in the middle of an otherwise CRLF file.
		const text = trailingNewline ? `${span}\n` : span.replace(/\r$/, '');
		const start = lineStarts[i];
		matches.push({ start, end: start + text.length, text });
		// Matches must not overlap, or splicing the second would land inside the first.
		// A repeating block ("})\n})") genuinely can match at consecutive offsets, so the
		// scan resumes after the match rather than one line into it.
		i += wanted.length - 1;
	}
	return matches;
}

/** A uniform indentation adjustment: strip `remove` from the front of each line, then prepend `add`. */
interface IndentShift {
	readonly add: string;
	readonly remove: string;
}

/**
 * The single indentation shift that maps every line of `oldText` onto the corresponding
 * line of the matched `span`, or undefined when no single shift does.
 *
 * The shift has to be uniform across the whole snippet — the whole block moved in or out by
 * the same amount — because that is the only case where the model's *relative* indentation
 * agrees with the file's and the replacement can be placed with confidence. When the deltas
 * disagree (the model nested its lines differently from the file, or indents with spaces
 * where the file uses tabs), returning undefined means the replacement goes in exactly as
 * the model wrote it. That can look untidy; guessing a shift produces code at the wrong
 * nesting depth, which is worse and much harder to spot in a diff.
 */
function indentShift(span: string, oldText: string): IndentShift | undefined {
	const spanLines = span.split('\n');
	const oldLines = oldText.split('\n');
	let shift: IndentShift | undefined;
	for (let i = 0; i < oldLines.length && i < spanLines.length; i++) {
		if (!oldLines[i].trim()) {
			continue;
		}
		const from = indentOf(oldLines[i]);
		const to = indentOf(spanLines[i].replace(/\r$/, ''));
		let here: IndentShift;
		if (to.endsWith(from)) {
			here = { add: to.slice(0, to.length - from.length), remove: '' };
		} else if (from.endsWith(to)) {
			here = { add: '', remove: from.slice(0, from.length - to.length) };
		} else {
			return undefined;
		}
		if (!shift) {
			shift = here;
		} else if (shift.add !== here.add || shift.remove !== here.remove) {
			return undefined;
		}
	}
	return shift;
}

/** Applies an {@link IndentShift} to every non-blank line of `text`. */
function reindent(text: string, shift: IndentShift | undefined): string {
	if (!shift || (!shift.add && !shift.remove)) {
		return text;
	}
	return text.split('\n').map(line => {
		if (!line.trim()) {
			return line;
		}
		const body = shift.remove && line.startsWith(shift.remove) ? line.slice(shift.remove.length) : line;
		return shift.add + body;
	}).join('\n');
}

/**
 * Rewrites `text`'s line endings to match those of `file`.
 *
 * Only used on the loose-match path, where the model's copy of the snippet differed from
 * the file. Splicing its LF replacement into a CRLF file would leave mixed endings through
 * the middle of the edited region — a diff nobody asked for, and on some toolchains a
 * broken file.
 *
 * The sample is the whole file, not the matched span: a span that is a single line carries
 * no line ending at all, so judging by it would strip CRLF out of every multi-line
 * replacement made against a one-line anchor.
 */
function matchLineEndings(text: string, file: string): string {
	return file.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
}

/** How many candidate anchor lines are offered when an edit finds nothing. */
const EDIT_HINT_LINES = 5;

/**
 * Locations in the file that look like where the model meant to edit, quoted as
 * `path:line: text`.
 *
 * A bare "not found" gives the model exactly one move — re-read the whole file — which is
 * both a wasted step and the start of the re-read loop. Pointing at the lines that resemble
 * its own anchor usually lets it retry correctly on the spot.
 */
function editHints(current: string, oldText: string, path: string): string {
	const anchor = oldText.split('\n').map(l => l.trim()).find(l => l.length > 3);
	if (!anchor) {
		return '';
	}
	const lines = current.split('\n');
	// Longest prefix first, shortening until something matches: the model's anchor usually
	// diverges from the file somewhere in the middle (a renamed symbol, a changed literal),
	// so the shared part is a prefix, and the longest one that still hits is the most
	// precise pointer that can be given.
	for (const length of [60, 40, 24, 16, 10, 6]) {
		if (length > anchor.length) {
			continue;
		}
		const probe = anchor.slice(0, length).toLowerCase();
		const hits: string[] = [];
		for (let i = 0; i < lines.length && hits.length < EDIT_HINT_LINES; i++) {
			if (lines[i].toLowerCase().includes(probe)) {
				hits.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
			}
		}
		if (hits.length) {
			return `\nLines that look like your anchor — copy one of these exactly:\n${hits.join('\n')}`;
		}
	}
	return `\nNothing in ${path} resembles "${anchor.slice(0, 40)}" either, so this text may be in a different file — find it with search_files rather than reading this one again.`;
}

/** The result of applying one replacement: the new text, or why it could not be applied. */
type EditOutcome =
	| { readonly ok: true; readonly updated: string; readonly occurrences: number }
	| { readonly ok: false; readonly error: string };

/** Applies one replacement to `current`, or explains why it could not be applied. */
function applyEdit(current: string, edit: FileEdit, path: string, label: string): EditOutcome {
	if (!edit.oldText) {
		return {
			ok: false,
			error: `${label}oldText is empty, so there is nothing to find and replace. Every entry needs "oldText" (the exact existing text) `
				+ 'and "newText" (its replacement). To create a file or replace one entirely, use write_file.',
		};
	}
	// The model copied its anchor straight out of a numbered read result. Strip the gutter
	// and carry on rather than making it read the file again to learn that.
	let oldText = edit.oldText;
	let newText = edit.newText;
	if (!current.includes(oldText)) {
		const ungutted = stripLineGutter(oldText);
		if (ungutted !== undefined && current.includes(ungutted)) {
			oldText = ungutted;
			newText = stripLineGutter(newText) ?? newText;
		}
	}
	if (oldText === newText) {
		return { ok: false, error: `${label}oldText and newText are identical, so this edit would change nothing.` };
	}

	const occurrences = current.split(oldText).length - 1;
	if (occurrences === 0) {
		const loose = findLooseMatches(current, oldText);
		if (!loose.length) {
			return { ok: false, error: `${label}oldText was not found in ${path}.${editHints(current, oldText, path)}` };
		}
		if (loose.length > 1 && !edit.replaceAll) {
			return { ok: false, error: `${label}oldText matches ${loose.length} places in ${path} once indentation is ignored. Include more surrounding context to make it unique, or set replaceAll:true.` };
		}
		// Matched loosely: replace the text the FILE has, and shift the replacement to the
		// indentation the file actually uses. Spliced back to front so each match's offsets
		// are still valid when its turn comes.
		let updated = current;
		for (let i = loose.length - 1; i >= 0; i--) {
			const match = loose[i];
			const replacement = matchLineEndings(reindent(newText, indentShift(match.text, oldText)), current);
			updated = updated.slice(0, match.start) + replacement + updated.slice(match.end);
		}
		return { ok: true, updated, occurrences: loose.length };
	}
	if (occurrences > 1 && !edit.replaceAll) {
		return { ok: false, error: `${label}oldText appears ${occurrences} times in ${path}. Include more surrounding context to make it unique, or set replaceAll:true.` };
	}
	// The snippet matched byte for byte, so it goes in as written — with one correction: a
	// model that writes LF newlines into a CRLF file is making a mistake, not a request, and
	// splicing them in unchanged leaves one stray line ending mid-file.
	const replacement = matchLineEndings(newText, current);
	// Spliced by index rather than via String.replace, which would read `$&`/`$1` in
	// newText as substitution patterns and quietly corrupt any snippet containing a `$`.
	const at = current.indexOf(oldText);
	const updated = edit.replaceAll
		? current.split(oldText).join(replacement)
		: current.slice(0, at) + replacement + current.slice(at + oldText.length);
	return { ok: true, updated, occurrences };
}

async function editFile(target: WorkspacePath, edits: FileEdit[], approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	const path = target.display;
	if (!edits.length) {
		return { result: 'edit_file requires either oldText/newText or a non-empty "edits" array.', isError: true };
	}
	const current = await readIfExists(target.uri);
	if (current === undefined) {
		return { result: `${path} does not exist, so there is nothing to edit. Use write_file to create it.`, isError: true };
	}

	// Applied in memory first: a batch is all-or-nothing, so a bad third edit can't leave
	// the file half-changed and the model reasoning about a state that was never written.
	let updated = current;
	let replacements = 0;
	for (let i = 0; i < edits.length; i++) {
		const label = edits.length > 1 ? `edits[${i}]: ` : '';
		const outcome = applyEdit(updated, edits[i], path, label);
		if (!outcome.ok) {
			const applied = i > 0 ? ` No edits were applied — the ${i} earlier one(s) in this call were discarded too, so the file is unchanged.` : '';
			return { result: outcome.error + applied, isError: true };
		}
		updated = outcome.updated;
		replacements += outcome.occurrences;
	}

	if (!autoApprovesWrites(g)) {
		const { approved, feedback } = await approver.confirm({
			kind: 'write',
			signature: `edit_file:${path}`,
			title: `Edit ${path}?`,
			detail: `Replaces ${replacements} occurrence(s)${edits.length > 1 ? ` across ${edits.length} edits` : ''}; ${current.split('\n').length} line(s) → ${updated.split('\n').length} line(s).`,
			preview: renderDiff(current, updated),
			previewLanguage: 'diff',
		});
		if (!approved) {
			return { result: denialMessage('edit', feedback), isError: true };
		}
	}
	await vscode.workspace.fs.writeFile(target.uri, new TextEncoder().encode(updated));
	return { result: `Replaced ${replacements} occurrence(s) in ${path}.`, isError: false };
}

/**
 * The tool result for a denied action. The user's reason is the important half: without
 * it the model only learns that something was refused, so it either retries the same
 * thing or abandons the task instead of adapting.
 */
function denialMessage(action: string, feedback?: string): string {
	const reason = feedback?.trim();
	return reason
		? `The user denied the ${action} and said: "${reason}". Follow that instruction instead of retrying as-is.`
		: `The user denied the ${action}. Do not retry it unchanged — ask what they would prefer, or take a different approach.`;
}

/** npm script names worth suggesting as a verification step, best first. */
const VERIFY_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'compile', 'build', 'test', 'lint'];

/** Non-npm projects, detected by a marker file at the workspace root. */
const VERIFY_MARKERS: Array<[string, string]> = [
	['Cargo.toml', 'cargo check'],
	['go.mod', 'go build ./...'],
	['pyproject.toml', 'python -m pytest'],
	['Makefile', 'make'],
	['pom.xml', 'mvn -q compile'],
	['build.gradle', 'gradle build'],
	['build.gradle.kts', 'gradle build'],
];

/** A command the workspace offers for checking a change, and where it has to run. */
export interface VerifyCommand {
	readonly command: string;
	/** `run_command`'s `cwd` argument; absent means the workspace root. */
	readonly cwd?: string;
}

/**
 * Commands this workspace actually offers for checking a change, best first.
 *
 * Used by the agent loop's completion gate. An empty result is meaningful: it means
 * there is nothing to run, so pressing the model to "verify" would be nagging it about
 * an impossibility. Every probe fails soft — an unreadable or malformed manifest just
 * contributes nothing.
 *
 * Every workspace folder is probed, not just the first. Commands run in the first folder by
 * default, so a build belonging to another one is returned with the `cwd` the model must
 * pass — otherwise the gate would demand `npm run build` for a change in the second folder
 * and the model would dutifully run the *first* folder's build and call it verified.
 */
export async function detectVerificationCommands(): Promise<VerifyCommand[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const found: VerifyCommand[] = [];
	for (const folder of folders) {
		// The first folder is `run_command`'s default, so it needs no cwd; the others are
		// named the same way every other tool names them.
		const cwd = folder === folders[0] ? undefined : folder.name;
		try {
			const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'package.json')));
			const scripts = JSON.parse(raw)?.scripts;
			if (scripts && typeof scripts === 'object') {
				for (const name of VERIFY_SCRIPTS) {
					if (typeof scripts[name] === 'string') {
						found.push({ command: `npm run ${name}`, cwd });
					}
				}
			}
		} catch {
			// No package.json, or it isn't valid JSON — neither is an error here.
		}
		for (const [marker, command] of VERIFY_MARKERS) {
			try {
				await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, marker));
				found.push({ command, cwd });
			} catch {
				// Marker absent.
			}
		}
	}
	return found;
}

/**
 * Commands that actually check a change, as opposed to merely being a command.
 *
 * The completion gate treats "wrote files, then ran something that exited 0" as verified.
 * Any command satisfying that is a hole the model walks straight through — `ls`, `git
 * status`, `echo done` all clear the flag while proving nothing about the code that was
 * just written. Matching the shape of a real build/test/lint invocation keeps the gate
 * meaningful without demanding a specific command, which would be unenforceable across
 * ecosystems. Deliberately generous: a false positive costs one skipped nudge, a false
 * negative nags the model about work it already did.
 */
/** Test/build/lint runners recognized as the executable of a command. */
const VERIFY_RUNNERS = new Set([
	'pytest', 'mypy', 'ruff', 'flake8', 'pylint', 'eslint', 'stylelint', 'tsc',
	'jest', 'vitest', 'mocha', 'ava', 'rspec', 'phpunit', 'dune', 'ctest',
	'gradle', 'gradlew', 'mvn', 'make', 'cmake',
]);

/** Subcommands that mean "check the code" for each package/build front-end. */
const VERIFY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
	npm: new Set(['test', 'build', 'lint', 'typecheck', 'type-check', 'check-types', 'compile', 'check', 'tsc']),
	cargo: new Set(['check', 'build', 'test', 'clippy']),
	go: new Set(['build', 'test', 'vet']),
	dotnet: new Set(['build', 'test']),
	python: new Set(['pytest', 'unittest', 'compileall', 'mypy', 'ruff']),
	lang: new Set(['build', 'test']),
};

/** Front-ends whose first non-flag argument is looked up in {@link VERIFY_SUBCOMMANDS}. */
const FRONT_ENDS: Record<string, keyof typeof VERIFY_SUBCOMMANDS> = {
	npm: 'npm', pnpm: 'npm', yarn: 'npm', bun: 'npm', deno: 'npm',
	cargo: 'cargo', go: 'go', dotnet: 'dotnet',
	python: 'python', python3: 'python', py: 'python',
	swift: 'lang', zig: 'lang', dart: 'lang', flutter: 'lang', mix: 'lang',
};

/**
 * Whether `command` is plausibly a verification step (build, test, type-check, lint).
 * Used by the agent loop to decide whether a successful command clears the "changed
 * files but never checked them" flag.
 *
 * Matched against the *head* of each shell segment rather than anywhere in the string.
 * A substring test looks equivalent and is not: `make` and `ava` are ordinary English,
 * so `git commit -m "make it work"` read as a passing build and cleared the very gate
 * this function exists to hold shut. Being fooled in that direction is the failure mode
 * that matters — the run then reports success over unverified code.
 */
export function isVerificationCommand(command: string): boolean {
	return command.split(/&&|\|\||[;|\n]/).some(isVerificationSegment);
}

/** Whether one shell segment invokes a verification runner. */
function isVerificationSegment(segment: string): boolean {
	// Leading `FOO=bar` environment assignments are not the command.
	const tokens = segment.trim().split(/\s+/).filter(t => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
	if (!tokens.length) {
		return false;
	}
	// The executable, stripped of any directory prefix and Windows extension, so
	// `./gradlew`, `node_modules/.bin/jest` and `tsc.cmd` all resolve to their name.
	const head = (tokens[0].split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();
	// Flags are dropped so `npm run build --if-present` and `python -m pytest -q` both
	// present their meaningful argument first.
	const args = tokens.slice(1).filter(t => !t.startsWith('-')).map(t => t.toLowerCase());
	if (VERIFY_RUNNERS.has(head)) {
		return true;
	}
	// `npx <runner>` / `pnpm dlx <runner>` delegate to a runner named in the arguments.
	if ((head === 'npx' || head === 'dlx' || head === 'pnpm') && args.length) {
		const delegated = (args[args[0] === 'dlx' ? 1 : 0] ?? '').split(/[\\/]/).pop() ?? '';
		if (VERIFY_RUNNERS.has(delegated)) {
			return true;
		}
	}
	const family = FRONT_ENDS[head];
	if (!family || !args.length) {
		return false;
	}
	// `npm run build` — the subcommand is what follows `run`.
	const subcommand = args[0] === 'run' && args.length > 1 ? args[1] : args[0];
	// A script name like `test:unit` or `build-web` counts as its base verb.
	return VERIFY_SUBCOMMANDS[family].has(subcommand)
		|| VERIFY_SUBCOMMANDS[family].has(subcommand.split(/[:.\-_]/)[0]);
}

/**
 * The command text of a `run_command` call, in the same joined form
 * {@link executeTool} runs. Kept here so the loop's verification bookkeeping and the
 * executor can never disagree about what was actually run.
 */
export function commandTextOf(args: Record<string, unknown>): string {
	return Array.isArray(args.command)
		? args.command.map(asString).filter(Boolean).join(' && ')
		: asString(args.command);
}

const MAX_CMD_OUTPUT = 16_000;
/** Split of that cap: enough head to identify what ran, the rest for the tail where errors land. */
const CMD_HEAD_CHARS = 4_000;
const CMD_TAIL_CHARS = MAX_CMD_OUTPUT - CMD_HEAD_CHARS;

/**
 * Identity of a command for "allow for this run", taken as its first two words.
 *
 * The executable alone is too coarse — approving `npm run build` once would then
 * auto-approve `npm publish` — and the whole command line is too fine to ever match
 * twice. Two words keeps the verb (`npm run`, `git status`, `npx tsc`), which is the
 * level at which a user actually means "yes, that kind of thing is fine".
 */
export function commandSignature(command: string): string {
	const words = command.trim().split(/\s+/).slice(0, 2).join(' ');
	return `run_command:${words.toLowerCase()}`;
}

/**
 * Rolling output collector for one command.
 *
 * Output is streamed and discarded as it goes rather than buffered whole. The previous
 * implementation used `exec`, which holds every byte in memory and kills the child once the
 * buffer is exceeded — so a verbose build (`npm run compile` in a monorepo trips 16MB
 * easily) came back as "killed, exit status unknown" even though it had succeeded. The
 * agent then re-ran it, tripped it again, and the run went nowhere. Nothing here can kill
 * the process, so the exit code is always real.
 *
 * The head is kept whole (what ran, and the first errors), the tail rolls (where a failing
 * build puts its summary), and everything between is counted and dropped.
 */
class OutputCollector {
	private head = '';
	private tail: string[] = [];
	private tailChars = 0;
	private dropped = 0;

	add(chunk: string): void {
		let rest = chunk;
		if (this.head.length < CMD_HEAD_CHARS) {
			const room = CMD_HEAD_CHARS - this.head.length;
			this.head += rest.slice(0, room);
			rest = rest.slice(room);
		}
		if (!rest) {
			return;
		}
		this.tail.push(rest);
		this.tailChars += rest.length;
		while (this.tailChars - this.tail[0].length >= CMD_TAIL_CHARS) {
			this.tailChars -= this.tail[0].length;
			this.dropped += this.tail.shift()!.length;
		}
	}

	/** What the model sees: head, an honest count of what was dropped, then the tail. */
	render(): string {
		const tail = this.tail.join('');
		// The oldest retained chunk may still overshoot the tail budget on its own.
		const trimmed = tail.length > CMD_TAIL_CHARS ? tail.slice(-CMD_TAIL_CHARS) : tail;
		const omitted = this.dropped + (tail.length - trimmed.length);
		if (!omitted) {
			return this.head + trimmed;
		}
		return `${this.head}\n[… ${omitted} chars of output omitted …]\n${trimmed}`;
	}
}

async function runCommand(dir: vscode.Uri, dirLabel: string, command: string, approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	if (!command.trim()) {
		return { result: 'Empty command.', isError: true };
	}
	// Checked before the guardrails and before any approval card: a mistyped tool call is
	// not a command the user should be asked to authorize.
	const executable = command.trim().split(/\s+/)[0].toLowerCase();
	if (CALLABLE_TOOL_NAMES.has(executable) || executable.startsWith('mcp__')) {
		return {
			result: `"${executable}" is one of your tools, not a shell command. Call it directly as a tool with its own arguments — run_command is only for real programs (builds, tests, git, package managers).`,
			isError: true,
		};
	}
	const guard = checkCommand(command, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Command blocked.', isError: true };
	}
	if (!autoApproves(g)) {
		const { approved, feedback } = await approver.confirm({
			kind: 'command',
			// The directory is part of the identity: approving `npm run build` in one folder
			// must not silently pre-approve it in another.
			signature: `${commandSignature(command)}@${dirLabel}`,
			title: 'Run a command?',
			detail: `In ${dir.fsPath} (timeout ${Math.round(g.commandTimeoutMs / 1000)}s).`,
			preview: command,
			previewLanguage: 'shell',
		});
		if (!approved) {
			return { result: denialMessage('command', feedback), isError: true };
		}
	}
	const shell = resolveAgentShell(g.shell);
	return new Promise<ToolResult>(resolvePromise => {
		const collector = new OutputCollector();
		let settled = false;
		const finish = (result: ToolResult) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolvePromise(result);
			}
		};

		let child;
		try {
			child = spawn(command, { cwd: dir.fsPath, shell: shell.path ?? true, windowsHide: true });
		} catch (err) {
			return finish({ result: `Command could not be started: ${err instanceof Error ? err.message : String(err)}`, isError: true });
		}

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, g.commandTimeoutMs);

		child.stdout?.on('data', (chunk: Buffer) => collector.add(chunk.toString()));
		child.stderr?.on('data', (chunk: Buffer) => collector.add(chunk.toString()));
		child.on('error', err => finish({ result: `Command failed to run: ${err.message}`, isError: true }));
		child.on('close', (code, signal) => {
			const out = collector.render();
			// A timeout is the one case where the exit status is meaningless, so it is
			// reported as such rather than as a failing build the model would try to fix.
			if (timedOut) {
				const seconds = Math.round(g.commandTimeoutMs / 1000);
				return finish({
					result: `The command was killed after the ${seconds}s timeout (openvsChat.agent.commandTimeoutMs) — it did NOT fail on its own. `
						+ `Its exit status is unknown. Re-run a faster subset, or raise the timeout.`
						+ (out ? `\n\nOutput before it was killed:\n${out}` : ''),
					isError: true,
				});
			}
			const failed = code !== 0;
			const status = failed ? `\n\n[exit code ${code ?? `killed by ${signal}`}]` : '';
			finish({ result: (out || '(no output)') + status, isError: failed });
		});
	});
}
