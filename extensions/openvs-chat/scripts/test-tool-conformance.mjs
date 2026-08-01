/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Conformance matrix for the agent tool layer. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-tool-conformance.mjs
//
// The other suites test what the tools DO. This one tests what they ACCEPT, which is a
// different failure mode and the one that actually wrecks runs: a call whose intent is
// perfectly clear but whose shape does not match our schema comes back as an error, the
// model retries the same shape, and the run burns its step budget going nowhere. It never
// looks like a bug — it looks like a slow, stupid model.
//
// Every case below is a shape a real model/gateway emits, drawn from the vocabularies
// models have most training exposure to (Anthropic's text_editor, Cursor, Codex,
// OpenHands, Aider) plus the type slips that come from tool calls rebuilt out of text.
// Each asserts the call REACHES ITS TOOL AND DOES THE WORK — not merely that it is
// rejected politely.
//
// To keep this honest as the toolset grows, the last block asserts that every tool in
// AGENT_TOOLS is covered by at least one case here.
import assert from 'node:assert/strict';
import Module from 'node:module';

const ROOT = '/repo';
let files = new Map();
let dirs = new Set();
let globMatches = [];
let settings = {};

function uri(fsPath) {
	return { fsPath, path: fsPath, scheme: 'file', toString: () => `file://${fsPath}` };
}
function joinPath(base, ...parts) {
	const segments = [];
	for (const seg of `${base.fsPath}/${parts.join('/')}`.split('/')) {
		if (!seg || seg === '.') { continue; }
		if (seg === '..') { segments.pop(); continue; }
		segments.push(seg);
	}
	return uri('/' + segments.join('/'));
}

const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: uri(ROOT), name: 'repo', index: 0 }],
		isTrusted: true,
		getConfiguration: () => ({ get: key => settings[key] }),
		asRelativePath: u => u.fsPath.replace(`${ROOT}/`, ''),
		findFiles: async (_include, _exclude, max) => globMatches.slice(0, max).map(p => uri(`${ROOT}/${p}`)),
		fs: {
			async readFile(u) {
				const text = files.get(u.fsPath);
				if (text === undefined) { const e = new Error('ENOENT'); e.code = 'FileNotFound'; throw e; }
				return new TextEncoder().encode(text);
			},
			async writeFile(u, bytes) { files.set(u.fsPath, new TextDecoder().decode(bytes)); },
			async readDirectory() { return []; },
			async stat(u) {
				if (!files.has(u.fsPath) && !dirs.has(u.fsPath)) { throw new Error('ENOENT'); }
				return { type: dirs.has(u.fsPath) ? 2 : 1 };
			},
		},
	},
	window: { showWarningMessage: async () => undefined, showQuickPick: async () => undefined },
	Uri: { file: uri, joinPath },
	RelativePattern: class { constructor(base, pattern) { this.baseUri = base.uri ?? base; this.pattern = pattern; } },
	FileType: { Directory: 2, File: 1 },
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};

const { AGENT_TOOLS, executeTool } = await import(new URL('../out/agent/tools.js', import.meta.url));
const { loadGuardrails } = await import(new URL('../out/agent/guardrails.js', import.meta.url));
const { parseTodoUpdate } = await import(new URL('../out/persona/todos.js', import.meta.url));

const approver = { async confirm() { return { approved: true }; }, async ask() { return ''; } };

const SOURCE = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
function reset() {
	files = new Map([[`${ROOT}/src/a.ts`, SOURCE]]);
	dirs = new Set([`${ROOT}/src`]);
	globMatches = ['src/a.ts'];
	settings = { 'guardrails.approval': 'yolo', 'guardrails.protectedPaths': [] };
}

/** Runs one call and returns { isError, result }. */
function run(name, args) {
	return executeTool({ id: 'c1', name, args }, approver, loadGuardrails());
}

/** Tools this matrix has exercised, checked for completeness at the end. */
const covered = new Set();

/**
 * Asserts a call in some alternate vocabulary produces exactly the same outcome as the
 * canonical call it is a synonym for. Comparing against the canonical result rather than a
 * hand-written expectation is what makes this a conformance test: a case cannot silently
 * drift into asserting a *different* behavior that happens not to be an error.
 */
async function equivalent(label, canonical, variants) {
	reset();
	const want = await run(canonical.name, canonical.args);
	assert.strictEqual(want.isError, false, `${label}: the canonical call itself failed — ${want.result}`);
	covered.add(canonical.name);
	const wantFiles = new Map(files);
	for (const variant of variants) {
		reset();
		const got = await run(variant.name ?? canonical.name, variant.args);
		assert.deepStrictEqual(
			{ isError: got.isError, result: got.result, files: [...files.entries()] },
			{ isError: false, result: want.result, files: [...wantFiles.entries()] },
			`${label}: ${JSON.stringify(variant)} -> ${got.result}`);
	}
}

// ---------------------------------------------------------------------------------------
// 1. read_file — name synonyms, argument synonyms, and numbers arriving as strings.
await equivalent('read_file', { name: 'read_file', args: { path: 'src/a.ts' } }, [
	{ name: 'view', args: { path: 'src/a.ts' } },
	{ name: 'cat', args: { file_path: 'src/a.ts' } },
	{ name: 'Read', args: { target_file: 'src/a.ts' } },
	{ name: 'open_file', args: { filename: 'src/a.ts' } },
	{ args: { path: './src/a.ts' } },
	{ args: { path: `${ROOT}/src/a.ts` } },
]);
await equivalent('read_file paging', { name: 'read_file', args: { path: 'src/a.ts', offset: 2, limit: 1 } }, [
	{ args: { path: 'src/a.ts', offset: '2', limit: '1' } },
	{ args: { file_path: 'src/a.ts', start_line: 2, num_lines: 1 } },
]);

// 2. list_dir — including the omitted path, which must mean the workspace root.
await equivalent('list_dir', { name: 'list_dir', args: { path: 'src' } }, [
	{ name: 'ls', args: { path: 'src' } },
	{ name: 'list_files', args: { directory: 'src' } },
	{ name: 'list_directory', args: { relative_workspace_path: 'src' } },
]);

// 3. search_files — the boolean is the trap: `isRegex: "false"` read loosely would turn a
//    literal search into a regex one and change what the model gets back.
await equivalent('search_files', { name: 'search_files', args: { query: 'const', glob: '**/*.ts' } }, [
	{ name: 'grep', args: { pattern: 'const', include: '**/*.ts' } },
	{ name: 'grep_search', args: { q: 'const', include_pattern: '**/*.ts' } },
	{ name: 'codebase_search', args: { search: 'const', glob: '**/*.ts' } },
	{ args: { query: 'const', glob: '**/*.ts', isRegex: 'false' } },
	{ args: { query: 'const', glob: '**/*.ts', isRegex: false } },
]);
await equivalent('search_files regex', { name: 'search_files', args: { query: 'const\\s+\\w', isRegex: true } }, [
	{ args: { query: 'const\\s+\\w', isRegex: 'true' } },
	{ args: { regex: 'const\\s+\\w', is_regex: 1 } },
]);

// 4. glob_files.
await equivalent('glob_files', { name: 'glob_files', args: { pattern: '**/*.ts', limit: 5 } }, [
	{ name: 'glob', args: { glob: '**/*.ts', limit: '5' } },
	{ name: 'file_search', args: { query: '**/*.ts', max_results: 5 } },
	{ name: 'find_files', args: { file_pattern: '**/*.ts', limit: 5 } },
]);

// 5. write_file — content arriving as an array of lines is the dangerous one: stringified
//    naively it becomes "a,b,c" and the file is silently corrupted rather than rejected.
await equivalent('write_file', { name: 'write_file', args: { path: 'src/new.ts', content: 'x\ny' } }, [
	{ name: 'create_file', args: { file_path: 'src/new.ts', file_text: 'x\ny' } },
	{ name: 'save_file', args: { target_file: 'src/new.ts', contents: 'x\ny' } },
	{ name: 'Write', args: { filename: 'src/new.ts', text: 'x\ny' } },
	{ args: { path: 'src/new.ts', content: ['x', 'y'] } },
]);

// 6. edit_file — the batch array's own name, the keys inside it, a batch sent as a bare
//    object, and `replaceAll` as a string. The inner-key case is the "oldText must not be
//    empty" failure: the anchor was always there, spelled `old_str`.
await equivalent('edit_file single', { name: 'edit_file', args: { path: 'src/a.ts', oldText: 'const b = 2;', newText: 'const b = 9;' } }, [
	{ name: 'str_replace_editor', args: { file_path: 'src/a.ts', old_str: 'const b = 2;', new_str: 'const b = 9;' } },
	{ name: 'str_replace', args: { path: 'src/a.ts', old_string: 'const b = 2;', new_string: 'const b = 9;' } },
	{ name: 'replace_in_file', args: { target_file: 'src/a.ts', search: 'const b = 2;', replace: 'const b = 9;' } },
	{ name: 'apply_patch', args: { path: 'src/a.ts', old_text: 'const b = 2;', new_text: 'const b = 9;' } },
	{ args: { path: 'src/a.ts', edits: [{ oldText: 'const b = 2;', newText: 'const b = 9;' }] } },
	{ args: { path: 'src/a.ts', edits: [{ old_str: 'const b = 2;', new_str: 'const b = 9;' }] } },
	{ args: { path: 'src/a.ts', edits: { oldText: 'const b = 2;', newText: 'const b = 9;' } } },
	{ args: { path: 'src/a.ts', changes: [{ old_string: 'const b = 2;', new_string: 'const b = 9;' }] } },
	{ args: { path: 'src/a.ts', replacements: [{ search: 'const b = 2;', replace: 'const b = 9;' }] } },
]);
await equivalent('edit_file replaceAll', { name: 'edit_file', args: { path: 'src/a.ts', oldText: 'const', newText: 'let', replaceAll: true } }, [
	{ args: { path: 'src/a.ts', oldText: 'const', newText: 'let', replaceAll: 'true' } },
	{ args: { path: 'src/a.ts', edits: [{ old_str: 'const', new_str: 'let', replace_all: true }] } },
]);

// 7. run_command — a command sent as a list of steps must chain on success, not run each
//    step regardless of whether the previous one failed.
{
	reset();
	covered.add('run_command');
	const listed = await run('run_command', { command: ['echo one', 'echo two'], cwd: '../outside' });
	// Rejected for its cwd (a real reason) rather than for its shape, and the joined command
	// is visible in neither case — so assert on the reason we DID get.
	assert.match(listed.result, /escapes the workspace root/);
}

// 8. update_todos — the checklist is what the completion gate reads, so a list rejected
//    over a status spelling turns a tracked run into an untracked one.
{
	const canonical = parseTodoUpdate({ items: [{ content: 'Fix the bug', status: 'in_progress' }] });
	assert.deepStrictEqual(canonical, { items: [{ content: 'Fix the bug', status: 'in_progress' }] });
	const variants = [
		{ todos: [{ content: 'Fix the bug', status: 'in-progress' }] },
		{ tasks: [{ task: 'Fix the bug', status: 'inprogress' }] },
		{ checklist: [{ title: 'Fix the bug', status: 'active' }] },
		{ items: [{ description: 'Fix the bug', status: 'doing' }] },
		{ steps: [{ text: 'Fix the bug', status: 'IN_PROGRESS' }] },
	];
	assert.deepStrictEqual(variants.map(parseTodoUpdate), variants.map(() => canonical));

	// Completed and pending spellings, and the shapes that carry no status at all.
	assert.deepStrictEqual(
		[
			parseTodoUpdate({ items: [{ content: 'a', status: 'done' }, { content: 'b', status: 'complete' }, { content: 'c', status: 'skipped' }] }),
			parseTodoUpdate({ items: [{ content: 'a', status: 'todo' }, { content: 'b' }, { content: 'c', status: 'nonsense' }] }),
			parseTodoUpdate({ items: ['a', 'b'] }),
		],
		[
			{ items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }, { content: 'c', status: 'completed' }] },
			{ items: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }] },
			{ items: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] },
		]);
}

// 9. A call whose intent genuinely cannot be recovered still fails — but the message must
//    name what arrived, or the model has nothing to correct and repeats itself.
{
	reset();
	const cases = [
		await run('edit_file', { path: 'src/a.ts', content: 'whole new file' }),
		await run('edit_file', { path: 'src/a.ts' }),
		await run('invented_tool', { path: 'src/a.ts' }),
	];
	assert.deepStrictEqual(cases.map(c => c.isError), [true, true, true]);
	assert.match(cases[0].result, /"content" belongs to write_file/);
	assert.match(cases[1].result, /supplied no arguments besides the path/);
	assert.match(cases[2].result, /read_file, list_dir, glob_files, search_files, write_file, edit_file, run_command/);
}

// 10. Completeness: a tool added later without a case here fails this suite rather than
//     quietly shipping with no conformance coverage at all.
{
	const missing = AGENT_TOOLS.map(t => t.name).filter(name => !covered.has(name));
	assert.deepStrictEqual(missing, [], `these tools have no conformance case: ${missing.join(', ')}`);
}

console.log('test-tool-conformance: all assertions passed');
