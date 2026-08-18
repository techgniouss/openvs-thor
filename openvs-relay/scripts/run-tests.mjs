// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
// Runs every test-*.mjs in this folder and reports a summary. Run:
//   npm test --prefix openvs-relay
//
// Ported from extensions/openvs-chat/scripts/run-tests.mjs (same shape: one child process per
// test file, each expected to exit 0 and print its own pass line). Unlike that package, there is
// no `out/` build step to check for here — the test files import `../src/*.ts` directly, and
// Node 24's built-in TypeScript type-stripping runs them with no transpile step at all (see this
// package's `Ground truth` doc in the task that produced it: pairing/token/VAPID logic is
// designed to run under plain `node`, unmodified).
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
