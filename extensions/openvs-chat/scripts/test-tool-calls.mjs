/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/toolCalls.ts and the tool-name/argument
// normalization in src/agent/tools.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-tool-calls.mjs
//
// These two layers are what make a non-frontier model usable: everything here is a
// malformation observed from real gateways (NVIDIA NIM, DashScope, Ollama, OpenRouter's
// smaller models) that previously became a dead tool call and a wasted step.
import assert from 'node:assert/strict';
import Module from 'node:module';

// tools.ts imports `vscode` at module load; nothing here calls into it.
const vscodeStub = {
	workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }), isTrusted: true },
	window: {},
	Uri: { file: p => ({ fsPath: p }), joinPath: (_b, ...p) => ({ fsPath: p.join('/') }) },
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.apply(this, [request, ...rest]);
};

const { MALFORMED_ARGS, extractTextToolCalls, parseToolArgs } = await import('../out/providers/toolCalls.js');
const { normalizeToolCall } = await import('../out/agent/tools.js');

const KNOWN = new Set(['read_file', 'list_dir', 'search_files', 'glob_files', 'write_file', 'edit_file', 'run_command']);

// 1. Argument repair. Each input is a shape a real gateway emitted; all must reach the
//    same object rather than an un-actionable error.
{
	const cases = [
		['{"path":"src/a.ts"}', { path: 'src/a.ts' }],
		['', {}],
		['```json\n{"path":"src/a.ts"}\n```', { path: 'src/a.ts' }],                     // fenced
		['{"path":"src/a.ts",}', { path: 'src/a.ts' }],                                  // trailing comma
		['{"path":"src/a.ts", "replaceAll": True}', { path: 'src/a.ts', replaceAll: true }], // Python literals
		['{"path":"src/a.ts", "limit": None}', { path: 'src/a.ts', limit: null }],
		['"{\\"path\\":\\"src/a.ts\\"}"', { path: 'src/a.ts' }],                          // double-encoded
		['Here you go: {"path":"src/a.ts"} — done', { path: 'src/a.ts' }],                // narrated
		['{"path":"src/a.ts", "content":"x', { path: 'src/a.ts', content: 'x' }],         // cut off mid-string
		['{"path":"src/a.ts", "edits":[{"oldText":"a","newText":"b"}', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }],
	];
	assert.deepStrictEqual(cases.map(([raw]) => parseToolArgs(raw)), cases.map(([, want]) => want));
}

// 2. Genuinely unreadable arguments are reported as such, not silently emptied — the tool
//    layer keys off this marker to quote the text back to the model.
{
	const parsed = parseToolArgs('path = src/a.ts');
	assert.deepStrictEqual(parsed, { [MALFORMED_ARGS]: 'path = src/a.ts' });
}

// 3. Tool calls written into prose are recovered, and the wrapper text is removed from
//    what the user sees. Without this the step reads as "prose, no tool call" and the run
//    ends having done nothing.
{
	const cases = [
		'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>',
		'Let me look.\n<function=read_file>{"path": "src/a.ts"}</function>',
		'Let me look.\n```json\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n```',
		'Let me look.\n{"name": "read_file", "parameters": {"path": "src/a.ts"}}',
		'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": "{\\"path\\": \\"src/a.ts\\"}"}\n</tool_call>',
	];
	assert.deepStrictEqual(
		cases.map(c => extractTextToolCalls(c, KNOWN)).map(r => ({ names: r.calls.map(c => c.name), args: r.calls.map(c => c.args), text: r.text })),
		cases.map(() => ({ names: ['read_file'], args: [{ path: 'src/a.ts' }], text: 'Let me look.' })));
}

// 4. Two calls in one message are both recovered, in order, and neither is double-counted
//    by the overlapping bare-JSON pattern.
{
	const content = '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>\n'
		+ '<tool_call>{"name":"list_dir","arguments":{"path":"src"}}</tool_call>';
	const { calls, text } = extractTextToolCalls(content, KNOWN);
	assert.deepStrictEqual({ names: calls.map(c => c.name), ids: new Set(calls.map(c => c.id)).size, text }, { names: ['read_file', 'list_dir'], ids: 2, text: '' });
}

// 5. Prose that merely contains JSON is left alone. The ambiguous forms only count when
//    the name is a tool that exists this run, or a real answer about JSON would be eaten.
{
	const cases = [
		'The config looks like {"name": "my-package", "version": "1.0.0"}.',
		'Here is the shape: {"name": "not_a_real_tool", "arguments": {"x": 1}}',
		'No braces here at all.',
	];
	assert.deepStrictEqual(
		cases.map(c => extractTextToolCalls(c, KNOWN)),
		cases.map(c => ({ calls: [], text: c })));
}

// 6. Tool and argument synonyms from other agent products are accepted. Small models reach
//    for these by reflex; refusing them costs a step and they usually repeat themselves.
{
	const cases = [
		[{ id: '1', name: 'bash', args: { cmd: 'npm test' } }, { name: 'run_command', args: { command: 'npm test' } }],
		[{ id: '1', name: 'str_replace_editor', args: { file_path: 'a.ts', old_str: 'x', new_str: 'y' } },
		{ name: 'edit_file', args: { path: 'a.ts', oldText: 'x', newText: 'y' } }],
		[{ id: '1', name: 'view', args: { file_path: 'a.ts' } }, { name: 'read_file', args: { path: 'a.ts' } }],
		[{ id: '1', name: 'grep', args: { pattern: 'foo', include: '*.ts' } }, { name: 'search_files', args: { query: 'foo', glob: '*.ts' } }],
		[{ id: '1', name: 'create_file', args: { file_path: 'a.ts', file_text: 'x' } }, { name: 'write_file', args: { path: 'a.ts', content: 'x' } }],
		[{ id: '1', name: 'READ_FILE', args: { path: 'a.ts' } }, { name: 'read_file', args: { path: 'a.ts' } }],
		// A correctly-spelled tool and argument is passed through untouched.
		[{ id: '1', name: 'read_file', args: { path: 'a.ts', limit: 20 } }, { name: 'read_file', args: { path: 'a.ts', limit: 20 } }],
	];
	assert.deepStrictEqual(
		cases.map(([input]) => { const c = normalizeToolCall(input); return { name: c.name, args: c.args }; }),
		cases.map(([, want]) => want));
}

// 7. An unrecognized name is left as-is, so executeTool can name the real tools rather
//    than this layer guessing.
{
	assert.strictEqual(normalizeToolCall({ id: '1', name: 'invent_something', args: {} }).name, 'invent_something');
}

console.log('test-tool-calls.mjs: all assertions passed');
