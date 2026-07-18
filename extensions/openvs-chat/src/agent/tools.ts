/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'child_process';
import * as vscode from 'vscode';
import { ToolCall, ToolSpec } from '../providers/types';
import { Guardrails, autoApproves, autoApprovesWrites, checkCommand, checkPath, loadGuardrails } from './guardrails';

const MAX_FILE_BYTES = 100_000;

/** The tools exposed to the model in Agent mode. */
export const AGENT_TOOLS: ToolSpec[] = [
	{
		name: 'read_file',
		description: 'Read the contents of a text file in the workspace. Paths are relative to the workspace root.',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
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
		description: 'Edit a text file by replacing an exact existing snippet with new text. Requires user approval. Prefer this over write_file for changes to existing files — it avoids resending the whole file.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative file path.' },
				oldText: { type: 'string', description: 'The exact text to replace. Must appear in the file; include enough surrounding lines to be unique.' },
				newText: { type: 'string', description: 'The replacement text.' },
				replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText instead of requiring it to be unique.' },
			},
			required: ['path', 'oldText', 'newText'],
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
export const READ_ONLY_TOOL_NAMES = ['read_file', 'list_dir', 'search_files'];

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

export interface ToolApprover {
	/** Returns true if the user approves a side-effecting action. */
	confirm(title: string, detail: string): Promise<boolean>;
}

export interface ToolResult {
	readonly result: string;
	readonly isError: boolean;
}

function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function resolve(root: vscode.Uri, relativePath: string): vscode.Uri {
	const clean = relativePath.replace(/^[./\\]+/, '');
	return vscode.Uri.joinPath(root, clean);
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
				return await readFile(root, String(call.args.path ?? ''), g);
			case 'list_dir':
				return await listDir(root, String(call.args.path ?? '.'), g);
			case 'search_files':
				return await searchFiles(root, String(call.args.query ?? ''), !!call.args.isRegex, String(call.args.glob ?? ''), g);
			case 'write_file':
				return await writeFile(root, String(call.args.path ?? ''), String(call.args.content ?? ''), approver, g);
			case 'edit_file':
				return await editFile(root, String(call.args.path ?? ''), String(call.args.oldText ?? ''), String(call.args.newText ?? ''), !!call.args.replaceAll, approver, g);
			case 'run_command':
				return await runCommand(root, String(call.args.command ?? ''), approver, g);
			default:
				return { result: `Unknown tool: ${call.name}`, isError: true };
		}
	} catch (err) {
		return { result: `Tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}

async function readFile(root: vscode.Uri, path: string, g: Guardrails): Promise<ToolResult> {
	const guard = checkPath(root, path, false, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	const uri = resolve(root, path);
	const bytes = await vscode.workspace.fs.readFile(uri);
	if (bytes.byteLength > MAX_FILE_BYTES) {
		const head = new TextDecoder().decode(bytes.slice(0, MAX_FILE_BYTES));
		return { result: `${head}\n\n[truncated at ${MAX_FILE_BYTES} bytes]`, isError: false };
	}
	return { result: new TextDecoder().decode(bytes), isError: false };
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

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Searches workspace files for a pattern, returning `path:line: text` matches. Uses
 * `findFiles` (which honours the user's search/files excludes) and skips protected
 * paths, oversized files and binaries, so it is safe as a read-only tool.
 */
async function searchFiles(root: vscode.Uri, query: string, isRegex: boolean, glob: string, g: Guardrails): Promise<ToolResult> {
	if (!query) {
		return { result: 'search_files requires a non-empty "query".', isError: true };
	}
	let re: RegExp;
	try {
		re = new RegExp(isRegex ? query : escapeRegExp(query), 'i');
	} catch (err) {
		return { result: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
	const uris = await vscode.workspace.findFiles(glob || '**/*', undefined, SEARCH_MAX_FILES);
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
	if (!matches.length) {
		return { result: `No matches for "${query}"${glob ? ` in ${glob}` : ''}.`, isError: false };
	}
	const capped = matches.length >= SEARCH_MAX_MATCHES ? `\n[stopped at ${SEARCH_MAX_MATCHES} matches]` : '';
	return { result: matches.join('\n') + capped, isError: false };
}

async function writeFile(root: vscode.Uri, path: string, content: string, approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	const guard = checkPath(root, path, true, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	const uri = resolve(root, path);
	if (!autoApprovesWrites(g)) {
		const approved = await approver.confirm(
			`Allow the agent to write ${path}?`,
			`The agent wants to create/overwrite this file (${content.length} characters).`,
		);
		if (!approved) {
			return { result: 'User denied the write.', isError: true };
		}
	}
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	return { result: `Wrote ${content.length} characters to ${path}.`, isError: false };
}

async function editFile(root: vscode.Uri, path: string, oldText: string, newText: string, replaceAll: boolean, approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	const guard = checkPath(root, path, true, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	if (!oldText) {
		return { result: 'oldText must not be empty. To create a new file or replace one entirely, use write_file.', isError: true };
	}
	const uri = resolve(root, path);
	const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	const occurrences = current.split(oldText).length - 1;
	if (occurrences === 0) {
		return { result: `oldText was not found in ${path}. Re-read the file and retry with the exact current text.`, isError: true };
	}
	if (occurrences > 1 && !replaceAll) {
		return { result: `oldText appears ${occurrences} times in ${path}. Include more surrounding context to make it unique, or set replaceAll:true.`, isError: true };
	}
	if (!autoApprovesWrites(g)) {
		const approved = await approver.confirm(
			`Allow the agent to edit ${path}?`,
			`The agent wants to replace ${occurrences} occurrence(s) of a ${oldText.length}-character snippet with ${newText.length} characters.`,
		);
		if (!approved) {
			return { result: 'User denied the edit.', isError: true };
		}
	}
	const updated = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
	return { result: `Replaced ${occurrences} occurrence(s) in ${path}.`, isError: false };
}

async function runCommand(root: vscode.Uri, command: string, approver: ToolApprover, g: Guardrails): Promise<ToolResult> {
	if (!command.trim()) {
		return { result: 'Empty command.', isError: true };
	}
	const guard = checkCommand(command, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Command blocked.', isError: true };
	}
	if (!autoApproves(g)) {
		const approved = await approver.confirm('Allow the agent to run a command?', command);
		if (!approved) {
			return { result: 'User denied the command.', isError: true };
		}
	}
	return new Promise<ToolResult>(resolvePromise => {
		exec(command, { cwd: root.fsPath, timeout: g.commandTimeoutMs, maxBuffer: 1_000_000 },
			(error, stdout, stderr) => {
				const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_FILE_BYTES);
				if (error && !stdout && !stderr) {
					resolvePromise({ result: `Command failed: ${error.message}`, isError: true });
				} else {
					resolvePromise({ result: out || '(no output)', isError: !!error });
				}
			});
	});
}
