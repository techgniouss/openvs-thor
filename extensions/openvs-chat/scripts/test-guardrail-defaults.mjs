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

// The defaults actually stop the destructive forms a model writes on either platform, and leave
// ordinary single-file deletes alone.
const { checkCommand } = await import(new URL('../out/agent/guardrails.js', import.meta.url));
for (const blocked of [
	'rm -rf build', 'rm -fr build', 'rm -r -f build', 'rm -r build -f', 'rm --recursive --force build',
	'rmdir /s /q C:\\proj', 'rd /s /q node_modules', 'del /f /s /q *.*', 'format c:',
	'Remove-Item -Recurse -Force .\\dist', 'Remove-Item .\\dist -Force -Recurse',
]) {
	assert.equal(checkCommand(blocked, g).ok, false, `blocked: ${blocked}`);
}
for (const allowed of ['rm file.txt', 'rm -f stale.lock', 'rmdir empty', 'del old.txt', 'Remove-Item old.txt', 'npm run format', 'git push origin main']) {
	assert.equal(checkCommand(allowed, g).ok, true, `allowed: ${allowed}`);
}

console.log('test-guardrail-defaults.mjs: all assertions passed');
