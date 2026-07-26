/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the agent tool layer in src/agent/tools.ts and the path
// normalization it shares with src/agent/guardrails.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-tools.mjs
//
// The tools reach the `vscode` host API for the workspace filesystem, so this serves an
// in-memory stand-in: a fake fs plus a Uri shape that joins paths the way VS Code does.
import assert from 'node:assert/strict';
import Module from 'node:module';

const ROOT = '/repo';
/** The fake workspace: absolute posix path -> file contents. */
let files = new Map();
/** Every approval the tools raised, so tests can assert on what the user was shown. */
let approvals = [];
/** What the stubbed approver answers next. */
let nextApproval = { approved: true };
/** Settings the stubbed `getConfiguration` reports. */
let settings = {};
/** Workspace-relative paths the stubbed `findFiles` reports, in order. */
let globMatches = [];

function uri(fsPath) {
	return { fsPath, path: fsPath, scheme: 'file', toString: () => `file://${fsPath}` };
}

/** Mirrors vscode.Uri.joinPath: append segments, then normalize `.` and `..`. */
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
		workspaceFolders: [{ uri: uri(ROOT) }],
		isTrusted: true,
		getConfiguration: () => ({ get: key => settings[key] }),
		asRelativePath: u => u.fsPath.replace(`${ROOT}/`, ''),
		findFiles: async (_include, _exclude, max) => globMatches.slice(0, max).map(rel => uri(`${ROOT}/${rel}`)),
		fs: {
			async readFile(u) {
				const text = files.get(u.fsPath);
				if (text === undefined) {
					const err = new Error(`ENOENT: ${u.fsPath}`);
					err.code = 'FileNotFound';
					throw err;
				}
				return new TextEncoder().encode(text);
			},
			async writeFile(u, bytes) { files.set(u.fsPath, new TextDecoder().decode(bytes)); },
			async readDirectory() { return []; },
		},
	},
	window: { showWarningMessage: async () => undefined, showQuickPick: async () => undefined },
	Uri: { file: uri, joinPath },
	FileType: { Directory: 2, File: 1 },
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};

const { executeTool, renderDiff } = await import(new URL('../out/agent/tools.js', import.meta.url));
const { normalizeWorkspacePath, loadGuardrails } = await import(new URL('../out/agent/guardrails.js', import.meta.url));

const approver = {
	async confirm(request) { approvals.push(request); return nextApproval; },
	async ask() { return ''; },
};

/** Runs one tool call against the fake workspace with the current settings. */
function run(name, args) {
	return executeTool({ id: 'c1', name, args }, approver, loadGuardrails());
}

function reset(initial = {}, options = {}) {
	files = new Map(Object.entries(initial));
	approvals = [];
	globMatches = [];
	nextApproval = { approved: true };
	// 'yolo' keeps approvals out of the way unless a test is specifically about them.
	settings = { 'guardrails.approval': 'yolo', 'guardrails.protectedPaths': [], ...options };
}

// 1. Leading dots must survive normalization. Stripping them (the old `/^[./\\]+/`)
// silently redirected every root dotfile: `.env` became `env`, and the guardrail
// validated a different path from the one the filesystem touched.
{
	assert.strictEqual(normalizeWorkspacePath('.env'), '.env');
	assert.strictEqual(normalizeWorkspacePath('.gitignore'), '.gitignore');
	assert.strictEqual(normalizeWorkspacePath('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
	assert.strictEqual(normalizeWorkspacePath('./src/a.ts'), 'src/a.ts');
	assert.strictEqual(normalizeWorkspacePath('.//./src/a.ts'), 'src/a.ts');
	assert.strictEqual(normalizeWorkspacePath('/src/a.ts'), 'src/a.ts');
	assert.strictEqual(normalizeWorkspacePath('src\\a.ts'), 'src/a.ts');
	// `..` is preserved so checkPath can reject the escape instead of rebasing it inside.
	assert.strictEqual(normalizeWorkspacePath('../etc/passwd'), '../etc/passwd');
}

// 2. End to end: a dotfile is written to the dotfile, not to a de-dotted sibling.
{
	reset();
	const res = await run('write_file', { path: '.gitignore', content: 'node_modules\n' });
	assert.strictEqual(res.isError, false, res.result);
	assert.strictEqual(files.get('/repo/.gitignore'), 'node_modules\n');
	assert.strictEqual(files.has('/repo/gitignore'), false, 'no de-dotted file was created');
}

// 3. …and reading it back finds the same file.
{
	reset({ '/repo/.vscode/settings.json': '{"a":1}' });
	const res = await run('read_file', { path: '.vscode/settings.json' });
	assert.strictEqual(res.isError, false);
	assert.match(res.result, /"a":1/);
}

// 4. Escaping the workspace root is still blocked.
{
	reset({ '/etc/passwd': 'secret' });
	const res = await run('read_file', { path: '../etc/passwd' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /escapes the workspace root/);
}

// 5. Protected paths are matched against the real (dotted) path.
{
	reset({}, { 'guardrails.protectedPaths': ['.env'] });
	const res = await run('write_file', { path: '.env', content: 'KEY=1' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /protected path/);
	assert.strictEqual(files.size, 0, 'nothing was written');
}

// 6. A drastic overwrite is never auto-approved, even under 'yolo': that is the
// signature of a truncated response, and the write cannot be undone.
{
	const original = 'line\n'.repeat(200);
	reset({ '/repo/src/big.ts': original });
	nextApproval = { approved: false, feedback: 'looks truncated' };
	const res = await run('write_file', { path: 'src/big.ts', content: 'line\n' });
	assert.strictEqual(res.isError, true);
	assert.strictEqual(approvals.length, 1, 'the user was asked despite yolo');
	assert.match(approvals[0].detail, /cut off/, 'the card says why it is suspicious');
	assert.match(res.result, /looks truncated/, 'the reason the user gave reaches the model');
	assert.strictEqual(files.get('/repo/src/big.ts'), original, 'the file is untouched');
}

// 6b. A normal-sized overwrite under 'yolo' is not interrupted.
{
	const original = 'line\n'.repeat(200);
	reset({ '/repo/src/big.ts': original });
	const res = await run('write_file', { path: 'src/big.ts', content: 'line\n'.repeat(180) });
	assert.strictEqual(res.isError, false);
	assert.strictEqual(approvals.length, 0, 'no interruption for an ordinary edit');
}

// 6c. Creating a new small file is never "suspicious" — there is nothing to destroy.
{
	reset();
	const res = await run('write_file', { path: 'new.txt', content: 'hi' });
	assert.strictEqual(res.isError, false);
	assert.strictEqual(approvals.length, 0);
}

// 7. Approvals carry a diff preview, so the user sees what actually changes.
{
	reset({ '/repo/a.txt': 'one\ntwo\nthree\n' }, { 'guardrails.approval': 'always' });
	await run('edit_file', { path: 'a.txt', oldText: 'two', newText: 'TWO' });
	assert.strictEqual(approvals.length, 1);
	assert.strictEqual(approvals[0].previewLanguage, 'diff');
	assert.match(approvals[0].preview, /-two/);
	assert.match(approvals[0].preview, /\+TWO/);
	assert.strictEqual(approvals[0].signature, 'edit_file:a.txt', 'always-allow is scoped to this file');
}

// 8. Editing a file that does not exist is a clear error, not a crash.
{
	reset();
	const res = await run('edit_file', { path: 'missing.ts', oldText: 'x', newText: 'y' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /does not exist/);
}

// 9. A denial with no reason still tells the model not to just retry.
{
	reset({ '/repo/a.txt': 'x' }, { 'guardrails.approval': 'always' });
	nextApproval = { approved: false };
	const res = await run('write_file', { path: 'a.txt', content: 'y' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /Do not retry it unchanged/);
	assert.strictEqual(files.get('/repo/a.txt'), 'x');
}

// 10. renderDiff shows the changed region with context, and says so when nothing moved.
{
	assert.strictEqual(renderDiff('same\n', 'same\n'), '(no textual change)');
	const diff = renderDiff('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n');
	assert.match(diff, /^@@ line 3 @@/);
	assert.match(diff, /-c/);
	assert.match(diff, /\+X/);
	assert.ok(!diff.includes('-a'), 'unchanged leading lines are context, not removals');
}

// 11. "Allow for this run" is scoped tightly enough to be safe: approving `npm run build`
// must not silently pre-approve `npm publish`.
{
	const { commandSignature } = await import(new URL('../out/agent/tools.js', import.meta.url));
	if (commandSignature) {
		assert.strictEqual(commandSignature('npm run build'), commandSignature('npm run test'));
		assert.notStrictEqual(commandSignature('npm run build'), commandSignature('npm publish'));
		assert.notStrictEqual(commandSignature('git status'), commandSignature('git push'));
	}
}

// 12. An empty path is rejected rather than resolving to the workspace root itself.
{
	reset();
	const res = await run('read_file', { path: '' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /empty path/i);
}

// 13. A tool name handed to run_command is caught here, not by the shell. Models do write
// `run_command("list_dir .")`, and cmd.exe answers with "'list_dir' is not recognized as an
// internal or external command" — which never tells the model that list_dir is a tool it
// already has, so it burns a step and often retries the same thing.
{
	reset();
	for (const command of ['list_dir .', 'read_file src/a.ts', 'SEARCH_FILES foo', 'mcp__db__query "select 1"']) {
		const res = await run('run_command', { command });
		assert.strictEqual(res.isError, true, command);
		assert.match(res.result, /is one of your tools, not a shell command/, command);
		assert.strictEqual(approvals.length, 0, 'the user is never asked to approve a non-command');
	}
}

// 14. The approval ladder has exactly three rungs, and the retired `auto-readonly` value
// maps onto `always` rather than silently dropping the user to the laxer default.
{
	const modes = {
		always: { writes: false, commands: false },
		'auto-edits': { writes: true, commands: false },
		yolo: { writes: true, commands: true },
		'auto-readonly': { writes: false, commands: false },
	};
	const { autoApproves, autoApprovesWrites } = await import(new URL('../out/agent/guardrails.js', import.meta.url));
	for (const [approval, want] of Object.entries(modes)) {
		settings = { 'guardrails.approval': approval };
		const g = loadGuardrails();
		assert.deepStrictEqual(
			{ writes: autoApprovesWrites(g), commands: autoApproves(g) }, want, approval);
	}
	// An unset or unrecognized policy falls back to the shipped default.
	settings = {};
	assert.strictEqual(loadGuardrails().approval, 'auto-edits');
	settings = { 'guardrails.approval': 'nonsense' };
	assert.strictEqual(loadGuardrails().approval, 'auto-edits');
}

// 15. Reads are line-numbered, so the model can cite `path:line` and aim its next read
// without counting lines by hand — recounting is why it re-reads a file it already has.
{
	reset({ '/repo/a.ts': 'const a = 1;\nconst b = 2;\n' });
	const res = await run('read_file', { path: 'a.ts' });
	assert.strictEqual(res.isError, false);
	assert.deepStrictEqual(res.result.split('\n').slice(0, 2), ['     1→const a = 1;', '     2→const b = 2;']);
	// A paged read numbers from the offset, not from 1.
	const page = await run('read_file', { path: 'a.ts', offset: 2, limit: 1 });
	assert.match(page.result, /^ +2→const b = 2;/);
}

// 16. An oldText copied straight out of a numbered read still applies. Rejecting it would
// send the model back to re-read the very file it just quoted.
{
	reset({ '/repo/a.ts': 'const a = 1;\nconst b = 2;\n' });
	const res = await run('edit_file', { path: 'a.ts', oldText: '     2→const b = 2;', newText: 'const b = 3;' });
	assert.strictEqual(res.isError, false, res.result);
	assert.strictEqual(files.get('/repo/a.ts'), 'const a = 1;\nconst b = 3;\n');
}

// 17. Indentation and line-ending drift no longer fail the edit: the needle is taken from
// the file, and the replacement is shifted to the depth the file actually uses.
{
	reset({ '/repo/a.ts': 'class A {\r\n\t\tif (x) {\r\n\t\t\treturn 1;\r\n\t\t}\r\n}\r\n' });
	const res = await run('edit_file', {
		path: 'a.ts',
		oldText: 'if (x) {\n\treturn 1;\n}',
		newText: 'if (y) {\n\treturn 2;\n}',
	});
	assert.strictEqual(res.isError, false, res.result);
	assert.strictEqual(files.get('/repo/a.ts'), 'class A {\r\n\t\tif (y) {\r\n\t\t\treturn 2;\r\n\t\t}\r\n}\r\n');
}

// 18. A genuine miss quotes the lines that resemble the anchor, so the retry does not have
// to start with another full read of the file.
{
	reset({ '/repo/a.ts': 'const total = 1;\nconst other = 2;\n' });
	const res = await run('edit_file', { path: 'a.ts', oldText: 'const total = 99;', newText: 'x' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /was not found/);
	assert.match(res.result, /a\.ts:1: const total = 1;/);
}

// 19. A batch of edits is all-or-nothing: a bad third edit must not leave the file half
// changed, which would have the model reasoning about a state that was never written.
{
	reset({ '/repo/a.ts': 'one\ntwo\nthree\n' });
	const bad = await run('edit_file', {
		path: 'a.ts',
		edits: [{ oldText: 'one', newText: '1' }, { oldText: 'nine', newText: '9' }],
	});
	assert.strictEqual(bad.isError, true);
	assert.match(bad.result, /edits\[1\]/);
	assert.strictEqual(files.get('/repo/a.ts'), 'one\ntwo\nthree\n', 'nothing was written');

	const good = await run('edit_file', {
		path: 'a.ts',
		edits: [{ oldText: 'one', newText: '1' }, { oldText: 'three', newText: '3' }],
	});
	assert.strictEqual(good.isError, false, good.result);
	assert.strictEqual(files.get('/repo/a.ts'), '1\ntwo\n3\n');
}

// 20. glob_files finds a file by name in one call — the alternative was walking the tree
// with list_dir, several steps before the run has even located the code to change.
{
	reset();
	globMatches = ['src/agent/tools.ts', 'src/agent/guardrails.ts'];
	const hit = await run('glob_files', { pattern: 'src/**/*.ts' });
	assert.strictEqual(hit.isError, false);
	assert.deepStrictEqual(hit.result.split('\n'), globMatches);

	globMatches = [];
	const miss = await run('glob_files', { pattern: 'tools.ts' });
	assert.strictEqual(miss.isError, false, 'no matches is an answer, not a failure');
	assert.match(miss.result, /\*\*\/tools\.ts/, 'the model is told how to match at any depth');
}

// 21. glob_files confines results to the workspace, and — like read_file and search_files —
// does NOT hide protected paths: `guardrails.protectedPaths` is a write blocklist, so the
// agent can still see that a .env exists. Pinned here so the two never silently diverge.
{
	reset({}, { 'guardrails.protectedPaths': ['.env'] });
	globMatches = ['.env', 'src/a.ts'];
	const res = await run('glob_files', { pattern: '**/*' });
	assert.deepStrictEqual(res.result.split('\n'), ['.env', 'src/a.ts']);
	assert.strictEqual((await run('write_file', { path: '.env', content: 'x' })).isError, true, 'but writing it is still blocked');
}

console.log('test-tools: all assertions passed');
