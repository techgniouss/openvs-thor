/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Pins the code-side fallbacks of the hard guardrail lists to the manifest defaults. The two
// are separate copies of the same list, and the code one is what applies when a host returns
// `undefined` for the setting — so a drift there is a guardrail silently turned off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';

const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? { workspace: { getConfiguration: () => ({ get: () => undefined }) } } : load.call(this, request, ...rest);
};
const { DEFAULT_DENIED_COMMANDS, DEFAULT_PROTECTED_PATHS, loadGuardrails } = await import(new URL('../out/agent/guardrails.js', import.meta.url));

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const props = Object.assign({}, ...[].concat(pkg.contributes.configuration).map(c => c.properties));
assert.deepEqual([...DEFAULT_DENIED_COMMANDS], props['openvsChat.guardrails.deniedCommands'].default, 'denied commands match the manifest');
assert.deepEqual([...DEFAULT_PROTECTED_PATHS], props['openvsChat.guardrails.protectedPaths'].default, 'protected paths match the manifest');

const g = loadGuardrails();
assert.equal(g.deniedCommands.length, DEFAULT_DENIED_COMMANDS.length, 'an unsupplied setting still loads every denied-command pattern');
assert.deepEqual(g.protectedPaths, [...DEFAULT_PROTECTED_PATHS], 'and every protected path');

console.log('test-guardrail-defaults.mjs: all assertions passed');
