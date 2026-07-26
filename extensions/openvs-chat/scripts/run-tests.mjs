/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Runs every test-*.mjs in this folder and reports a summary. Run:
//   npm run test --prefix extensions/openvs-chat
//
// Each test file is a standalone process (they stub the `vscode` module globally via
// Module._load, so sharing one process would let them interfere), and each is expected to
// exit 0 and print its own "all assertions passed" line.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter(f => /^test-.*\.mjs$/.test(f)).sort();
if (!files.length) {
	console.error('No test-*.mjs files found.');
	process.exit(1);
}

// The tests import from out/, so a stale build would silently test the previous revision.
const compiled = path.join(here, '..', 'out', 'agent', 'agentRunner.js');
if (!fs.existsSync(compiled)) {
	console.error('out/ is missing — run `npx tsc -p extensions/openvs-chat/tsconfig.json` first.');
	process.exit(1);
}

let failed = 0;
for (const file of files) {
	const result = spawnSync(process.execPath, [path.join(here, file)], { encoding: 'utf8' });
	const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
	if (result.status === 0) {
		console.log(`  PASS  ${file}`);
	} else {
		failed++;
		console.log(`  FAIL  ${file}\n${output.split('\n').map(l => `        ${l}`).join('\n')}`);
	}
}

console.log(`\n${files.length - failed}/${files.length} suites passed.`);
process.exit(failed ? 1 : 0);
