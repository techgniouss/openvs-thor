/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as vscode from 'vscode';
import { ToolCall, ToolSpec } from '../providers/types';
import { Guardrails, autoApproves, autoApprovesWrites, checkCommand, checkPath, loadGuardrails, normalizeWorkspacePath } from './guardrails';

/**
 * Most bytes of a file that are decoded for one read_file call. Well above the page cap
 * so any offset the model asks for is reachable, but bounded so a multi-megabyte bundle
 * isn't pulled through the decoder.
 */
const MAX_DECODE_BYTES = 1_000_000;
/** Default character cap for one read_file result — a whole-file dump eats the context budget for the rest of the run. */
const MAX_READ_CHARS = 48_000;

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
		description: 'Find files by PATH pattern (not by content) and get back matching workspace-relative paths, most recently modified first. Use this to locate a file whose name you know — "**/chatViewProvider.ts", "src/**/*.test.ts" — instead of walking directories with list_dir.',
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
		description: 'Run a shell command in the workspace root and return its output. Requires user approval. Use for builds, tests, git, etc.',
		parameters: {
			type: 'object',
			properties: { command: { type: 'string', description: 'The shell command to run.' } },
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

function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Maps a model-supplied workspace path onto a URI. Shares
 * {@link normalizeWorkspacePath} with the guardrail check so the path that is validated
 * is exactly the path that gets touched.
 */
function resolve(root: vscode.Uri, relativePath: string): vscode.Uri {
	return vscode.Uri.joinPath(root, normalizeWorkspacePath(relativePath));
}

/** Executes a single tool call, applying guardrails and prompting for approval on side effects. */
export async function executeTool(call: ToolCall, approver: ToolApprover, guardrails?: Guardrails): Promise<ToolResult> {
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
	try {
		switch (call.name) {
			case 'read_file':
				return await readFile(root, String(call.args.path ?? ''), g,
					typeof call.args.offset === 'number' ? call.args.offset : undefined,
					typeof call.args.limit === 'number' ? call.args.limit : undefined);
			case 'list_dir':
				return await listDir(root, String(call.args.path ?? '.'), g);
			case 'search_files':
				return await searchFiles(root, String(call.args.query ?? ''), !!call.args.isRegex, String(call.args.glob ?? ''), g);
			case 'glob_files':
				return await globFiles(root, String(call.args.pattern ?? ''), g,
					typeof call.args.limit === 'number' ? call.args.limit : undefined);
			case 'write_file':
				return await writeFile(root, String(call.args.path ?? ''), String(call.args.content ?? ''), approver, g);
			case 'edit_file':
				return await editFile(root, String(call.args.path ?? ''), parseEdits(call.args), approver, g);
			case 'run_command':
				return await runCommand(root, String(call.args.command ?? ''), approver, g);
			default:
				return { result: `Unknown tool: ${call.name}`, isError: true };
		}
	} catch (err) {
		return { result: `Tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}

async function readFile(root: vscode.Uri, path: string, g: Guardrails, offset?: number, limit?: number): Promise<ToolResult> {
	const guard = checkPath(root, path, false, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	const uri = resolve(root, path);
	const bytes = await vscode.workspace.fs.readFile(uri);
	// `stream: true` keeps a multi-byte sequence straddling the cut from decoding as U+FFFD.
	const decodeLimit = Math.max(MAX_DECODE_BYTES, MAX_READ_CHARS);
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
		if (chars + line.length + 1 + GUTTER_COST > MAX_READ_CHARS) {
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
		const head = wanted[0].slice(0, MAX_READ_CHARS);
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
async function globFiles(root: vscode.Uri, pattern: string, g: Guardrails, limit?: number): Promise<ToolResult> {
	if (!pattern.trim()) {
		return { result: 'glob_files requires a non-empty "pattern".', isError: true };
	}
	const cap = Math.min(limit && limit > 0 ? limit : GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT);
	// One over the cap, so a truncated listing can be reported as truncated.
	const uris = await vscode.workspace.findFiles(pattern, SEARCH_EXCLUDE, cap + 1);
	const paths = uris
		.map(u => vscode.workspace.asRelativePath(u))
		// The same confinement search applies: a match outside the workspace root (reachable
		// through a symlinked or multi-root folder) is not this workspace's file to offer.
		// Protected paths are deliberately not filtered — they are a write blocklist.
		.filter(rel => checkPath(root, rel, false, g).ok);
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

async function listDir(root: vscode.Uri, path: string, g: Guardrails): Promise<ToolResult> {
	const guard = checkPath(root, path, false, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	const uri = resolve(root, path);
	const entries = await vscode.workspace.fs.readDirectory(uri);
	const lines = entries.map(([name, type]) =>
		`${type === vscode.FileType.Directory ? 'dir ' : 'file'}  ${name}`);
	return { result: lines.length ? lines.join('\n') : '(empty directory)', isError: false };
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
 * Searches workspace files for a pattern, returning `path:line: text` matches.
 *
 * Prefers `findTextInFiles`, which runs the editor's own ripgrep: it honours
 * `.gitignore` and the user's search excludes, never reads a file it doesn't have to,
 * and returns in a fraction of the time. Falls back to {@link searchFilesByScan} when
 * the proposed API isn't enabled for this build.
 */
async function searchFiles(root: vscode.Uri, query: string, isRegex: boolean, glob: string, g: Guardrails): Promise<ToolResult> {
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
	const viaRipgrep = await searchFilesByRipgrep(root, query, isRegex, glob, g);
	return viaRipgrep ?? searchFilesByScan(root, query, isRegex, glob, g);
}

/**
 * ripgrep-backed search. Returns undefined when `findTextInFiles` is unavailable (the
 * API proposal is not enabled), so the caller can fall back rather than fail.
 */
async function searchFilesByRipgrep(
	root: vscode.Uri, query: string, isRegex: boolean, glob: string, g: Guardrails,
): Promise<ToolResult | undefined> {
	// Feature-detected rather than assumed: the proposal is declared in package.json, but
	// a build that strips proposed APIs must degrade to the scan instead of throwing.
	if (typeof vscode.workspace.findTextInFiles !== 'function') {
		return undefined;
	}
	const matches: string[] = [];
	try {
		await vscode.workspace.findTextInFiles(
			{ pattern: query, isRegExp: isRegex, isCaseSensitive: false },
			{ include: glob || undefined, exclude: SEARCH_EXCLUDE, maxResults: SEARCH_MAX_MATCHES },
			result => {
				// A TextSearchResult is either a match or a surrounding context line, and
				// only a match carries `preview`. Context lines are not results and must
				// not be reported as ones.
				const match = result as vscode.TextSearchMatch;
				if (matches.length >= SEARCH_MAX_MATCHES || match.preview === undefined) {
					return;
				}
				const rel = vscode.workspace.asRelativePath(match.uri);
				// A protected path must not leak its contents through search either.
				if (!checkPath(root, rel, false, g).ok) {
					return;
				}
				const first = Array.isArray(match.ranges) ? match.ranges[0] : match.ranges;
				const line = (first?.start.line ?? 0) + 1;
				matches.push(`${rel}:${line}: ${match.preview.text.trim().slice(0, 200)}`);
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
async function searchFilesByScan(root: vscode.Uri, query: string, isRegex: boolean, glob: string, g: Guardrails): Promise<ToolResult> {
	let re: RegExp;
	try {
		re = new RegExp(isRegex ? query : escapeRegExp(query), 'i');
	} catch (err) {
		return { result: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
	const uris = await vscode.workspace.findFiles(glob || '**/*', SEARCH_EXCLUDE, SEARCH_MAX_FILES);
	const matches: string[] = [];
	const decoder = new TextDecoder();
	// Read in parallel batches — thousands of sequential fs round-trips are painfully
	// slow, especially on remote/virtual workspaces.
	const BATCH = 64;
	for (let start = 0; start < uris.length && matches.length < SEARCH_MAX_MATCHES; start += BATCH) {
		const batch = uris.slice(start, start + BATCH).map(async uri => {
			const rel = vscode.workspace.asRelativePath(uri);
			if (!checkPath(root, rel, false, g).ok) {
				return undefined;
			}
			try {
				return { rel, bytes: await vscode.workspace.fs.readFile(uri) };
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

async function writeFile(root: vscode.Uri, path: string, content: string, approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	const guard = checkPath(root, path, true, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	const uri = resolve(root, path);
	const existing = await readIfExists(uri);
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
			signature: `write_file:${normalizeWorkspacePath(path)}`,
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
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
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
		oldText: String(raw.oldText ?? ''),
		newText: String(raw.newText ?? ''),
		replaceAll: raw.replaceAll === true,
	});
	if (Array.isArray(args.edits)) {
		return args.edits.map(entry => one(typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {}));
	}
	return [one(args)];
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
function findLooseMatches(current: string, oldText: string): string[] {
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
	const matches: string[] = [];
	const last = fileLines.length - wanted.length - (trailingNewline ? 1 : 0);
	for (let i = 0; i <= last; i++) {
		let hit = true;
		for (let k = 0; k < wanted.length && hit; k++) {
			hit = normalizeLine(fileLines[i + k]) === wanted[k];
		}
		if (hit) {
			const span = fileLines.slice(i, i + wanted.length).join('\n');
			// Splitting on '\n' leaves each CRLF line's '\r' on the line itself, so a span
			// that stops short of a newline still ends with the first half of one. Keeping it
			// would have the replacement swallow the '\r' and leave a lone '\n' behind — one
			// mixed line ending in the middle of an otherwise CRLF file.
			matches.push(trailingNewline ? `${span}\n` : span.replace(/\r$/, ''));
		}
	}
	return matches;
}

/**
 * Re-indents `text` when a loose match was found at a different indentation than the model
 * supplied, so replacement lines land at the depth the file actually uses. Lines that don't
 * start with the expected indentation are left untouched rather than mangled.
 */
function reindent(text: string, from: string, to: string): string {
	if (from === to) {
		return text;
	}
	return text.split('\n').map(line => {
		if (!line.trim()) {
			return line;
		}
		if (!from) {
			return to + line;
		}
		return line.startsWith(from) ? to + line.slice(from.length) : line;
	}).join('\n');
}

/**
 * Rewrites `text`'s line endings to match `sample`.
 *
 * Only used on the loose-match path, where the model's copy of the snippet differed from
 * the file. Splicing its LF replacement into a CRLF file would leave mixed endings through
 * the middle of the edited region — a diff nobody asked for, and on some toolchains a
 * broken file.
 */
function matchLineEndings(text: string, sample: string): string {
	return sample.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');
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

/** Applies one replacement to `current`, or explains why it could not be applied. */
function applyEdit(current: string, edit: FileEdit, path: string, label: string): { updated: string; occurrences: number } | { error: string } {
	if (!edit.oldText) {
		return { error: `${label}oldText must not be empty. To create a new file or replace one entirely, use write_file.` };
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
		return { error: `${label}oldText and newText are identical, so this edit would change nothing.` };
	}

	const occurrences = current.split(oldText).length - 1;
	if (occurrences === 0) {
		const loose = findLooseMatches(current, oldText);
		if (!loose.length) {
			return { error: `${label}oldText was not found in ${path}.${editHints(current, oldText, path)}` };
		}
		if (loose.length > 1 && !edit.replaceAll) {
			return { error: `${label}oldText matches ${loose.length} places in ${path} once indentation is ignored. Include more surrounding context to make it unique, or set replaceAll:true.` };
		}
		// Matched loosely: replace the text the FILE has, and shift the replacement to the
		// indentation the file actually uses.
		const anchorIndex = oldText.split('\n').findIndex(l => l.trim());
		const from = indentOf(oldText.split('\n')[anchorIndex]);
		let updated = current;
		for (const needle of loose) {
			const to = indentOf(needle.split('\n')[anchorIndex] ?? '');
			updated = updated.replace(needle, matchLineEndings(reindent(newText, from, to), needle));
		}
		return { updated, occurrences: loose.length };
	}
	if (occurrences > 1 && !edit.replaceAll) {
		return { error: `${label}oldText appears ${occurrences} times in ${path}. Include more surrounding context to make it unique, or set replaceAll:true.` };
	}
	const updated = edit.replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
	return { updated, occurrences };
}

async function editFile(root: vscode.Uri, path: string, edits: FileEdit[], approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	const guard = checkPath(root, path, true, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	if (!edits.length) {
		return { result: 'edit_file requires either oldText/newText or a non-empty "edits" array.', isError: true };
	}
	const uri = resolve(root, path);
	const current = await readIfExists(uri);
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
		if ('error' in outcome) {
			const applied = i > 0 ? ` No edits were applied — the ${i} earlier one(s) in this call were discarded too, so the file is unchanged.` : '';
			return { result: outcome.error + applied, isError: true };
		}
		updated = outcome.updated;
		replacements += outcome.occurrences;
	}

	if (!autoApprovesWrites(g)) {
		const { approved, feedback } = await approver.confirm({
			kind: 'write',
			signature: `edit_file:${normalizeWorkspacePath(path)}`,
			title: `Edit ${path}?`,
			detail: `Replaces ${replacements} occurrence(s)${edits.length > 1 ? ` across ${edits.length} edits` : ''}; ${current.split('\n').length} line(s) → ${updated.split('\n').length} line(s).`,
			preview: renderDiff(current, updated),
			previewLanguage: 'diff',
		});
		if (!approved) {
			return { result: denialMessage('edit', feedback), isError: true };
		}
	}
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
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

/**
 * Commands this workspace actually offers for checking a change, best first.
 *
 * Used by the agent loop's completion gate. An empty result is meaningful: it means
 * there is nothing to run, so pressing the model to "verify" would be nagging it about
 * an impossibility. Every probe fails soft — an unreadable or malformed manifest just
 * contributes nothing.
 */
export async function detectVerificationCommands(): Promise<string[]> {
	const root = workspaceRoot();
	if (!root) {
		return [];
	}
	const found: string[] = [];
	try {
		const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'package.json')));
		const scripts = JSON.parse(raw)?.scripts;
		if (scripts && typeof scripts === 'object') {
			for (const name of VERIFY_SCRIPTS) {
				if (typeof scripts[name] === 'string') {
					found.push(`npm run ${name}`);
				}
			}
		}
	} catch {
		// No package.json, or it isn't valid JSON — neither is an error here.
	}
	for (const [marker, command] of VERIFY_MARKERS) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, marker));
			found.push(command);
		} catch {
			// Marker absent.
		}
	}
	return found;
}

const MAX_CMD_OUTPUT = 16_000;
/** Split of that cap: enough head to identify what ran, the rest for the tail where errors land. */
const CMD_HEAD_CHARS = 4_000;
const CMD_TAIL_CHARS = MAX_CMD_OUTPUT - CMD_HEAD_CHARS;

/** Keeps the start (what ran) and the end (where errors land) of long command output. */
function capCommandOutput(out: string): string {
	if (out.length <= MAX_CMD_OUTPUT) {
		return out;
	}
	const head = out.slice(0, CMD_HEAD_CHARS);
	const tail = out.slice(-CMD_TAIL_CHARS);
	return `${head}\n[… ${out.length - head.length - tail.length} chars of output omitted …]\n${tail}`;
}

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
 * Output buffer for one command. Generous because the cap is enforced by killing the
 * process: a verbose build that trips it loses its exit status entirely, turning a green
 * build into an unexplained failure. {@link capCommandOutput} trims what the model sees.
 */
const CMD_MAX_BUFFER = 16 * 1024 * 1024;

async function runCommand(root: vscode.Uri, command: string, approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
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
			signature: commandSignature(command),
			title: 'Run a command?',
			detail: `In ${root.fsPath} (timeout ${Math.round(g.commandTimeoutMs / 1000)}s).`,
			preview: command,
			previewLanguage: 'shell',
		});
		if (!approved) {
			return { result: denialMessage('command', feedback), isError: true };
		}
	}
	return new Promise<ToolResult>(resolvePromise => {
		exec(command, { cwd: root.fsPath, timeout: g.commandTimeoutMs, maxBuffer: CMD_MAX_BUFFER, shell: g.shell || undefined },
			(error, stdout, stderr) => {
				const out = capCommandOutput([stdout, stderr].filter(Boolean).join('\n'));
				const fault = error as (Error & { killed?: boolean; code?: number | string; signal?: string }) | null;
				const partial = out ? `\n\nOutput before it was killed:\n${out}` : '';
				// Both of these kill the child, so `killed` is set either way and the exit
				// status is lost. They must be told apart: reporting an output-flood as a
				// timeout sends the model chasing performance, and reporting either as a
				// plain failure sends it fixing code that never broke.
				if (fault?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
					return resolvePromise({
						result: `The command produced more than ${Math.round(CMD_MAX_BUFFER / 1024 / 1024)}MB of output and was killed — it did NOT fail on its own. `
							+ `Its exit status is unknown. Re-run it quieter (a narrower target, or redirect output to a file and read that).${partial}`,
						isError: true,
					});
				}
				if (fault?.killed) {
					const seconds = Math.round(g.commandTimeoutMs / 1000);
					return resolvePromise({
						result: `The command was killed after the ${seconds}s timeout (openvsChat.agent.commandTimeoutMs) — it did NOT fail on its own. `
							+ `Its exit status is unknown. Re-run a faster subset, or raise the timeout.${partial}`,
						isError: true,
					});
				}
				if (fault && !stdout && !stderr) {
					return resolvePromise({ result: `Command failed: ${fault.message}`, isError: true });
				}
				const status = fault ? `\n\n[exit code ${fault.code ?? 'unknown'}]` : '';
				resolvePromise({ result: (out || '(no output)') + status, isError: !!fault });
			});
	});
}
