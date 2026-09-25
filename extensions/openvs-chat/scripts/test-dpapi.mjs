/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/providers/webCookie/dpapi.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-dpapi.mjs
//
// Round-trips a synthetic, throwaway value through DPAPI as the CURRENT machine user — never
// touches a real credential, a real Chrome profile, or any browser data. On win32 this proves
// the powershell.exe shell-out actually works on this machine; on any other platform it proves
// dpapiUnprotectCurrentUser degrades to `undefined` rather than throwing.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const m = await import(new URL('../out/providers/webCookie/dpapi.js', import.meta.url));

if (process.platform !== 'win32') {
	const result = await m.dpapiUnprotectCurrentUser(Buffer.from('irrelevant on this platform'));
	assert.equal(result, undefined, 'non-Windows platforms must degrade to undefined, never throw');
	console.log('All dpapi assertions passed (non-Windows: degrade-only path checked).');
	process.exit(0);
}

// Protect a synthetic, throwaway string as the current user (mirrors what Chrome does to its
// own master key) and confirm dpapiUnprotectCurrentUser recovers it byte-for-byte.
const plaintext = `openvs-chat dpapi self-test ${Date.now()}`;
const protectScript = [
	'Add-Type -AssemblyName System.Security',
	`$bytes = [System.Text.Encoding]::UTF8.GetBytes('${plaintext}')`,
	'$wrapped = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
	'[Convert]::ToBase64String($wrapped)',
].join('; ');
const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', protectScript]);
const wrapped = Buffer.from(stdout.trim(), 'base64');

const recovered = await m.dpapiUnprotectCurrentUser(wrapped);
assert.ok(recovered, 'expected a recovered buffer, got undefined');
assert.equal(recovered.toString('utf8'), plaintext);

// A blob that is not validly DPAPI-wrapped (garbage bytes) fails closed to undefined, not a
// thrown exception — a caller must be able to treat "can't read this" as ordinary control flow.
const garbage = await m.dpapiUnprotectCurrentUser(Buffer.from([1, 2, 3, 4, 5]));
assert.equal(garbage, undefined);

console.log('All dpapi assertions passed.');
