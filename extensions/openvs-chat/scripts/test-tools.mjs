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
/** The include pattern the last `findFiles` call was given. */
let lastGlob;
/** Absolute paths the fake fs treats as directories. */
let dirs = new Set();

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
		workspaceFolders: [{ uri: uri(ROOT), name: 'repo', index: 0 }],
		isTrusted: true,
		getConfiguration: () => ({ get: key => settings[key] }),
		asRelativePath: u => u.fsPath.replace(`${ROOT}/`, ''),
		// Entries starting with `/` are absolute (used by the multi-root tests); anything
		// else is relative to the primary folder. The include pattern is recorded rather
		// than applied — the tests assert on what the editor was asked to match.
		findFiles: async (include, _exclude, max) => {
			lastGlob = include;
			return globMatches.slice(0, max).map(p => uri(p.startsWith('/') ? p : `${ROOT}/${p}`));
		},
		fs: {
			async readFile(u) {
				if (dirs.has(u.fsPath)) {
					const err = new Error(`EISDIR: illegal operation on a directory, read ${u.fsPath}`);
					err.code = 'FileIsADirectory';
					throw err;
				}
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
			async stat(u) {
				if (!files.has(u.fsPath) && !dirs.has(u.fsPath)) { throw new Error(`ENOENT: ${u.fsPath}`); }
				return { type: dirs.has(u.fsPath) ? 2 : 1 };
			},
		},
	},
	window: { showWarningMessage: async () => undefined, showQuickPick: async () => undefined },
	Uri: { file: uri, joinPath },
	// Mirrors vscode.RelativePattern: a glob anchored to one workspace folder.
	RelativePattern: class { constructor(base, pattern) { this.baseUri = base.uri ?? base; this.pattern = pattern; } },
	FileType: { Directory: 2, File: 1 },
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};

const { executeTool, renderDiff, detectVerificationCommands } = await import(new URL('../out/agent/tools.js', import.meta.url));
const { normalizeWorkspacePath, loadGuardrails } = await import(new URL('../out/agent/guardrails.js', import.meta.url));

const approver = {
	async confirm(request) { approvals.push(request); return nextApproval; },
	async ask() { return ''; },
};

/** Runs one tool call against the fake workspace with the current settings. */
function run(name, args) {
	return executeTool({ id: 'c1', name, args }, approver, loadGuardrails());
}

/** Opens `roots` as the workspace folders, e.g. [['/repo','repo'], ['/api','api']]. */
function setFolders(roots) {
	vscodeStub.workspace.workspaceFolders = roots.map(([path, name], index) => ({ uri: uri(path), name, index }));
}

function reset(initial = {}, options = {}) {
	files = new Map(Object.entries(initial));
	approvals = [];
	globMatches = [];
	lastGlob = undefined;
	dirs = new Set();
	setFolders([[ROOT, 'repo']]);
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

// 22. `$` in newText is literal. String.replace treats `$&`, `$'` and `$1` in the
// replacement as substitution patterns, so routing an edit through it silently corrupted
// any snippet containing a dollar sign — shell scripts, template literals, jQuery, regex
// replacements. Covered on the exact, replaceAll and loose paths.
{
	const dollars = 'const s = `${a}$& and $\' and $1`;';
	reset({ '/repo/a.ts': 'const s = 1;\n' });
	await run('edit_file', { path: 'a.ts', oldText: 'const s = 1;', newText: dollars });
	assert.strictEqual(files.get('/repo/a.ts'), `${dollars}\n`, 'exact path keeps $ literal');

	reset({ '/repo/b.ts': 'x\nx\n' });
	await run('edit_file', { path: 'b.ts', oldText: 'x', newText: '$&y', replaceAll: true });
	assert.strictEqual(files.get('/repo/b.ts'), '$&y\n$&y\n', 'replaceAll keeps $ literal');

	// Loose path: the file is CRLF so the exact match fails first.
	reset({ '/repo/c.ts': 'keep\r\n\tanchor\r\n' });
	await run('edit_file', { path: 'c.ts', oldText: 'anchor', newText: '$& $1' });
	assert.strictEqual(files.get('/repo/c.ts'), 'keep\r\n\t$& $1\r\n', 'loose path keeps $ literal');
}

// 23. Two identical loose matches are both replaced, in the right places. Replacing by
// String.replace re-found the first match on the second pass — which by then was the text
// just written — so the second site was left untouched and the first was mangled.
// The file is CRLF and oldText is multi-line, so the exact match cannot fire and both
// sites go through the loose path.
{
	const before = 'if (a) {\r\n\t\tgo();\r\n\t\tdone();\r\n}\r\nif (b) {\r\n\t\tgo();\r\n\t\tdone();\r\n}\r\n';
	reset({ '/repo/a.ts': before });
	const res = await run('edit_file', {
		path: 'a.ts',
		oldText: 'go();\ndone();',
		newText: 'go();\nlog();\ndone();',
		replaceAll: true,
	});
	assert.strictEqual(res.isError, false, res.result);
	assert.strictEqual(
		files.get('/repo/a.ts'),
		'if (a) {\r\n\t\tgo();\r\n\t\tlog();\r\n\t\tdone();\r\n}\r\nif (b) {\r\n\t\tgo();\r\n\t\tlog();\r\n\t\tdone();\r\n}\r\n',
		'both sites replaced, indentation and CRLF preserved at each');
}

// 24. A multi-line replacement matched against a SINGLE-line anchor still gets the file's
// line endings. The span of a one-line match contains no newline at all, so judging the
// file's convention by the span stripped CRLF out of every such replacement.
{
	reset({ '/repo/a.ts': 'first\r\n\tonly\r\nlast\r\n' });
	// Trailing space, so the exact match misses and the loose path handles it.
	await run('edit_file', { path: 'a.ts', oldText: 'only ', newText: 'one\ntwo' });
	assert.strictEqual(files.get('/repo/a.ts'), 'first\r\n\tone\r\n\ttwo\r\nlast\r\n');
}

// 24b. When the model's own nesting disagrees with the file's, no indentation is guessed:
// its text goes in as written. A guessed shift puts code at the wrong depth, which is both
// worse and far harder to notice in a diff than untidy indentation.
{
	reset({ '/repo/a.ts': 'if (a) {\r\n\t\tgo();\r\n\t}\r\n' });
	// The model has `}` deeper than `go();`; the file has it shallower — no uniform shift.
	await run('edit_file', { path: 'a.ts', oldText: 'go();\n\t}', newText: 'stop();\n\t}' });
	assert.strictEqual(files.get('/repo/a.ts'), 'if (a) {\r\nstop();\r\n\t}\r\n');
}

// 24c. Exact matches are not reindented — the model asked for that text byte for byte —
// but LF newlines it wrote into a CRLF file are still corrected.
{
	reset({ '/repo/a.ts': 'first\r\nonly\r\n' });
	await run('edit_file', { path: 'a.ts', oldText: 'only', newText: 'one\ntwo' });
	assert.strictEqual(files.get('/repo/a.ts'), 'first\r\none\r\ntwo\r\n');
}

// 25. A block that repeats on consecutive lines matches without the two spans overlapping —
// overlapping ranges would splice the second replacement inside the first.
{
	reset({ '/repo/a.ts': 'x\nx\nx\nx\n' });
	const res = await run('edit_file', { path: 'a.ts', oldText: '   1→x\n   2→x', newText: 'y\ny', replaceAll: true });
	assert.strictEqual(res.isError, false, res.result);
	assert.strictEqual(files.get('/repo/a.ts'), 'y\ny\ny\ny\n');
}

// 26. Multi-root: a search or glob hit in the SECOND folder round-trips. This was the
// whole bug — matches were reported folder-prefixed ("api/src/index.ts") but every path was
// resolved against workspaceFolders[0], so the very next read_file looked for
// /repo/api/src/index.ts and failed. Every search result in a multi-root workspace pointed
// at a path the agent could not open.
{
	reset({ '/api/src/index.ts': 'export const x = 1;\n' });
	setFolders([[ROOT, 'repo'], ['/api', 'api']]);
	globMatches = ['/api/src/index.ts', '/elsewhere/stray.ts'];

	const found = await run('glob_files', { pattern: '**/*.ts' });
	assert.strictEqual(found.result, 'api/src/index.ts',
		'prefixed with the folder name, and a hit outside every folder is dropped');

	const read = await run('read_file', { path: found.result });
	assert.strictEqual(read.isError, false, read.result);
	assert.match(read.result, /export const x = 1;/);

	// …and writes land in the right folder too.
	const edit = await run('edit_file', { path: 'api/src/index.ts', oldText: '1', newText: '2' });
	assert.strictEqual(edit.isError, false, edit.result);
	assert.strictEqual(files.get('/api/src/index.ts'), 'export const x = 2;\n');
	assert.strictEqual(files.has('/repo/api/src/index.ts'), false, 'nothing was created under the first folder');
}

// 27. A plain relative path still means the first folder, exactly as in a single-root
// workspace — the folder-name branch must not capture ordinary paths.
{
	reset({ '/repo/a.ts': 'one\n' });
	setFolders([[ROOT, 'repo'], ['/api', 'api']]);
	const res = await run('read_file', { path: 'a.ts' });
	assert.strictEqual(res.isError, false, res.result);
	assert.match(res.result, /one/);
}

// 28. An absolute path inside a folder is honoured rather than rebased onto the root, where
// it became /repo/api/src/index.ts and simply failed to open. One that matches no folder is
// still treated as relative and reported missing — never read from outside the workspace.
{
	reset({ '/api/src/index.ts': 'ok\n', '/outside/secret.ts': 'nope\n' });
	setFolders([[ROOT, 'repo'], ['/api', 'api']]);
	const inside = await run('read_file', { path: '/api/src/index.ts' });
	assert.strictEqual(inside.isError, false, inside.result);
	assert.match(inside.result, /ok/);

	const outside = await run('read_file', { path: '/outside/secret.ts' });
	assert.strictEqual(outside.isError, true, 'a path outside every folder is not read');
	assert.ok(!/nope/.test(outside.result), 'and its contents never appear');
}

// 29. Confinement is enforced per folder, not just against the first one: `..` out of the
// second folder is blocked the same way it always was out of the first.
{
	reset({ '/etc/passwd': 'secret' });
	setFolders([[ROOT, 'repo'], ['/api', 'api']]);
	const res = await run('read_file', { path: 'api/../../etc/passwd' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /escapes the workspace root/);
}

// 30. Multi-root: a folder-name prefix works in a GLOB too, not just in a path. A plain
// string pattern is matched against every folder's own relative paths, so "api/**" looked
// for an `api` directory inside each folder and matched the folder called `api` never —
// while read_file accepted that exact prefix and the environment snapshot tells the model
// to use it. An empty result is precisely what sends a model round the same search again.
{
	reset({ '/api/src/index.ts': 'x\n' });
	setFolders([[ROOT, 'repo'], ['/api', 'api']]);
	globMatches = ['/api/src/index.ts'];
	await run('glob_files', { pattern: 'api/**/*.ts' });
	assert.strictEqual(lastGlob.baseUri.fsPath, '/api', 'scoped to the named folder');
	assert.strictEqual(lastGlob.pattern, '**/*.ts', 'with the folder name stripped off');

	// A pattern naming no folder is passed straight through, as in a single-root workspace.
	await run('glob_files', { pattern: '**/*.ts' });
	assert.strictEqual(lastGlob, '**/*.ts');
}

// 31. Reading a directory names the tool that would have worked. The raw
// EISDIR/FileIsADirectory error mentions no tool the model has, so it retried the same call.
{
	reset();
	dirs.add('/repo/src');
	const res = await run('read_file', { path: 'src' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /is a directory, not a file\. Use list_dir/);
}

// 32. run_command's cwd goes through the same guarded resolution as any other path, so a
// command cannot be aimed outside the workspace. (Checked on the rejection path — the
// success path would reach the real `exec`.)
{
	reset();
	const res = await run('run_command', { command: 'echo hi', cwd: '../outside' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /escapes the workspace root/);
	assert.strictEqual(approvals.length, 0, 'the user is never asked to approve a blocked command');
}

// 33. The verification probe covers every folder, and a command belonging to a non-primary
// one carries the cwd the model has to pass. Without that the completion gate would demand
// "npm run build" for a change in the second folder, the model would run the FIRST folder's
// build, and the run would be reported verified on the strength of an unrelated green build.
{
	reset({
		'/repo/package.json': JSON.stringify({ scripts: { build: 'x' } }),
		'/api/package.json': JSON.stringify({ scripts: { test: 'y' } }),
	});
	setFolders([[ROOT, 'repo'], ['/api', 'api']]);
	assert.deepStrictEqual(await detectVerificationCommands(), [
		{ command: 'npm run build', cwd: undefined },
		{ command: 'npm run test', cwd: 'api' },
	]);
}

// 34. Nested workspace folders resolve to the innermost one, whatever order they were
// added in. Taking the first prefix match made a file's reported path depend on that order.
{
	reset({ '/repo/packages/api/src/a.ts': 'x\n' });
	for (const order of [[[ROOT, 'repo'], ['/repo/packages/api', 'api']], [['/repo/packages/api', 'api'], [ROOT, 'repo']]]) {
		setFolders(order);
		globMatches = ['/repo/packages/api/src/a.ts'];
		const found = await run('glob_files', { pattern: '**/*.ts' });
		assert.strictEqual(found.result, 'api/src/a.ts', `innermost folder wins (order: ${order.map(o => o[1])})`);
		// …and the path it reported opens the file it came from.
		const read = await run('read_file', { path: found.result });
		assert.strictEqual(read.isError, false, read.result);
	}
}

console.log('test-tools: all assertions passed');
