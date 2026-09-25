/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/mcp/manager.ts's consent gate on servers a *project* defines.
// Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-mcp-consent.mjs
//
// Workspace trust alone used to let cloning a repository and opening the chat spawn whatever
// command its `.vscode/mcp.json` named. Servers from the user's own settings are not asked about.
import assert from 'node:assert/strict';
import Module from 'node:module';

// Nothing listens here, so an attempted connection fails fast — which is how the test tells a
// server that was *attempted* from one that was never started.
const DEAD = 'http://127.0.0.1:9/mcp';
const files = {
	'/repo/.vscode/mcp.json': JSON.stringify({ servers: { fromRepo: { url: DEAD } } }),
};
const vscodeStub = {
	workspace: {
		isTrusted: true,
		workspaceFolders: [{ uri: { fsPath: '/repo', path: '/repo' } }],
		getConfiguration: () => ({ get: key => (key === 'mcp.servers' ? { fromSettings: { url: DEAD } } : undefined) }),
		fs: {
			async readFile(uri) {
				if (!(uri.path in files)) { throw new Error('ENOENT'); }
				return new TextEncoder().encode(files[uri.path]);
			},
		},
	},
	Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
	window: {},
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const { McpManager } = await import(new URL('../out/mcp/manager.js', import.meta.url));

// Refused: the repository's server never starts; the user's own server is tried without asking.
{
	const asked = [];
	const manager = new McpManager(async (id, config, file) => { asked.push({ id, url: config.url, file }); return false; });
	await manager.ensureStarted();
	assert.deepStrictEqual(asked, [{ id: 'fromRepo', url: DEAD, file: '.vscode/mcp.json' }], 'only the project server is asked about');
	const status = manager.getStatus().join('\n');
	assert.match(status, /fromRepo: not started \(defined by \.vscode\/mcp\.json; not allowed\)/);
	assert.match(status, /fromSettings: failed/, 'the user\'s own server was attempted');
	manager.dispose();
}

// Allowed: it is attempted like any other.
{
	const manager = new McpManager(async () => true);
	await manager.ensureStarted();
	assert.match(manager.getStatus().join('\n'), /fromRepo: failed/);
	manager.dispose();
}

// With nothing wired in, the default is to refuse.
{
	const manager = new McpManager();
	await manager.ensureStarted();
	assert.match(manager.getStatus().join('\n'), /fromRepo: not started/);
	manager.dispose();
}

console.log('test-mcp-consent: all assertions passed');
