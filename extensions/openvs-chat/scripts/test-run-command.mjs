/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for run_command in src/agent/tools.ts, against the real OS. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-run-command.mjs
//
// The other suites stop at the guardrail rejections; this one actually spawns processes,
// because the bug it guards is in the plumbing rather than the policy: `exec` buffers the
// whole output and kills the child when the buffer overflows, so a verbose-but-successful
// build came back as "killed, exit status unknown" and the agent re-ran it forever.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openvs-cmd-'));
const settings = { 'agent.commandTimeoutMs': 60_000 };
const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: workspace }, name: 'repo' }],
		getConfiguration: () => ({ get: key => settings[key] }),
		isTrusted: true,
	},
	window: {},
	Uri: {
		file: p => ({ fsPath: p }),
		joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }),
	},
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.apply(this, [request, ...rest]);
};

const { executeTool } = await import('../out/agent/tools.js');

// Never consulted: the default approval policy is `yolo`, so commands run unprompted.
let approvals = 0;
const approver = {
	confirm: async () => { approvals++; return { approved: true }; },
	ask: async () => '',
};
const run = (args) => executeTool({ id: '1', name: 'run_command', args }, approver);

// A script rather than an inline `node -e`: quoting differs between Git Bash, PowerShell
// and cmd.exe, and this test must not depend on which one the machine resolves to.
const noisy = path.join(workspace, 'noisy.js');
fs.writeFileSync(noisy, [
	"const line = 'x'.repeat(1000) + '\\n';",
	'for (let i = 0; i < 25000; i++) { process.stdout.write(line); }',
	"process.stdout.write('FINAL-LINE\\n');",
].join('\n'));

// 1. 25MB of output — well past the old 16MB buffer — is no longer fatal. The command runs
//    to completion, its real exit code is reported, and what the model sees is bounded.
{
	const res = await run({ command: `node noisy.js` });
	assert.strictEqual(res.isError, false, res.result.slice(0, 300));
	assert.match(res.result, /chars of output omitted/);
	assert.match(res.result, /FINAL-LINE/, 'the tail is kept, so a failing build\'s summary survives');
	assert.ok(res.result.length < 40_000, `output stays bounded, got ${res.result.length}`);
	assert.doesNotMatch(res.result, /was killed/);
}

// 2. A genuine failure is still reported as one, with its exit code.
{
	const failing = path.join(workspace, 'fail.js');
	fs.writeFileSync(failing, "console.error('boom'); process.exit(3);");
	const res = await run({ command: 'node fail.js' });
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /boom/);
	assert.match(res.result, /\[exit code 3\]/);
}

// 3. A command that exits cleanly and quietly reports success with its output intact.
{
	const res = await run({ command: 'node --version' });
	assert.deepStrictEqual(
		{ isError: res.isError, version: /^v\d+\./.test(res.result.trim()) }, { isError: false, version: true }, res.result);
}

// 4. The timeout still kills, and says so — that is the one case where the exit status is
//    genuinely unknown and the model must not read it as a failing build.
{
	const slow = path.join(workspace, 'slow.js');
	fs.writeFileSync(slow, 'setTimeout(() => {}, 60000);');
	settings['agent.commandTimeoutMs'] = 700;
	const res = await run({ command: 'node slow.js' });
	settings['agent.commandTimeoutMs'] = 60_000;
	assert.strictEqual(res.isError, true);
	assert.match(res.result, /killed after the 1s timeout/);
	assert.match(res.result, /did NOT fail on its own/);
}

// 5. Nothing above prompted: `yolo` is the shipped default, so the agent is not waiting on
//    a card for every build and test it runs.
assert.strictEqual(approvals, 0);

fs.rmSync(workspace, { recursive: true, force: true });
console.log('test-run-command: all assertions passed');
