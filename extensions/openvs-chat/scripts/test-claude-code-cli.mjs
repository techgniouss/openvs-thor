/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/claudeCodeCli.ts. Stubs both `vscode` (for the
// `claude-code-cli.cliPath` setting) and `child_process` (so no real CLI is ever spawned) via
// Module._load, the same technique test-tools.mjs uses for `vscode` alone. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-claude-code-cli.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';

let cliPathSetting = '';
let lastSpawn = null;
/** Set per test case before calling streamChat; returns the FakeChild to drive. */
let spawnImpl = () => { throw new Error('spawnImpl not configured for this test'); };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return {
			workspace: {
				getConfiguration: () => ({ get: key => (key === 'claude-code-cli.cliPath' ? cliPathSetting : undefined) }),
			},
		};
	}
	if (request === 'child_process') {
		return {
			spawn: (binary, args, opts) => {
				lastSpawn = { binary, args, opts };
				return spawnImpl(binary, args, opts);
			},
		};
	}
	return originalLoad(request, parent, isMain);
};

const { ClaudeCodeCliProvider } = await import(new URL('../out/providers/claudeCodeCli.js', import.meta.url));
const { isAbortError } = await import(new URL('../out/providers/types.js', import.meta.url));

/** A minimal stand-in for Node's ChildProcess: stdout/stderr are plain EventEmitters (with a
 * no-op setEncoding, since the provider switches them to string mode) and `kill` just records
 * what was called rather than touching a real process. */
class FakeChild extends EventEmitter {
	constructor() {
		super();
		this.stdout = new EventEmitter();
		this.stdout.setEncoding = () => { };
		this.stderr = new EventEmitter();
		this.stderr.setEncoding = () => { };
		this.killSignals = [];
	}
	kill(signal) {
		this.killSignals.push(signal);
		return true;
	}
}

function baseRequest(overrides = {}) {
	const chunks = [];
	return {
		messages: [{ role: 'user', content: 'hello' }],
		model: '',
		apiKey: '',
		baseUrl: '',
		maxTokens: 1000,
		signal: new AbortController().signal,
		onToken: delta => chunks.push(delta),
		onNotice: () => { },
		chunks,
		...overrides,
	};
}

// 1. Streamed stdout chunks reach onToken, in order, and a clean (code 0) exit resolves with
//    { truncated: false } — the "assume it finished naturally" shape every provider uses.
{
	const child = new FakeChild();
	spawnImpl = () => child;
	const request = baseRequest();
	const promise = new ClaudeCodeCliProvider().streamChat(request);
	child.stdout.emit('data', 'Hello ');
	child.stdout.emit('data', 'world');
	child.emit('close', 0, null);
	const result = await promise;
	assert.deepStrictEqual(result, { truncated: false });
	assert.equal(request.chunks.join(''), 'Hello world');
}

// 2a. A nonzero exit rejects with a clear error that names the exit code and includes stderr.
{
	const child = new FakeChild();
	spawnImpl = () => child;
	const promise = new ClaudeCodeCliProvider().streamChat(baseRequest());
	child.stderr.emit('data', 'boom: something broke');
	child.emit('close', 2, null);
	await assert.rejects(promise, err => {
		assert.match(err.message, /exited with code 2/);
		assert.match(err.message, /boom: something broke/);
		return true;
	});
}

// 2b. A spawn failure with ENOENT (CLI not installed / not on PATH) rejects with a friendly
//     message pointing at installing the CLI and the cliPath setting, not a raw ENOENT.
{
	const child = new FakeChild();
	spawnImpl = () => child;
	const promise = new ClaudeCodeCliProvider().streamChat(baseRequest());
	const enoent = new Error('spawn claude ENOENT');
	enoent.code = 'ENOENT';
	child.emit('error', enoent);
	await assert.rejects(promise, err => {
		assert.match(err.message, /was not found/);
		assert.match(err.message, /openvsChat\.claude-code-cli\.cliPath/);
		return true;
	});
}

// 3. Aborting request.signal kills the child with SIGTERM immediately, and once the child
//    actually exits the promise rejects with an error isAbortError recognizes — the same
//    shape agentRunner.ts/chatViewProvider.ts depend on for every other provider.
{
	const child = new FakeChild();
	spawnImpl = () => child;
	const controller = new AbortController();
	const promise = new ClaudeCodeCliProvider().streamChat(baseRequest({ signal: controller.signal }));
	controller.abort();
	assert.deepStrictEqual(child.killSignals, ['SIGTERM'], 'abort must SIGTERM the child right away');
	child.emit('close', null, 'SIGTERM');
	await assert.rejects(promise, err => {
		assert.ok(isAbortError(err), `expected an abort error recognized by isAbortError, got: ${err}`);
		return true;
	});
}

// 4. The configured cliPath and a non-empty model both reach the spawned command line.
{
	const child = new FakeChild();
	spawnImpl = () => child;
	cliPathSetting = 'C:/tools/claude.exe';
	const promise = new ClaudeCodeCliProvider().streamChat(baseRequest({ model: 'opus' }));
	child.emit('close', 0, null);
	await promise;
	cliPathSetting = '';
	assert.equal(lastSpawn.binary, 'C:/tools/claude.exe');
	assert.deepStrictEqual(lastSpawn.args.slice(0, 1).concat(lastSpawn.args.slice(2, 4)), ['-p', '--output-format', 'text']);
	const modelIndex = lastSpawn.args.indexOf('--model');
	assert.notEqual(modelIndex, -1);
	assert.equal(lastSpawn.args[modelIndex + 1], 'opus');
}

console.log('test-claude-code-cli: all assertions passed');
