/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// relay-pwa/ is this extension's copy of the phone app (openvs-relay/pwa), served by the local
// relay. A phone paired to a locally hosted relay and one paired to a deployed relay must run
// the same app, so the copy may not drift. Fix a failure with:
//   node extensions/openvs-chat/scripts/sync-relay-pwa.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = new URL('../../../openvs-relay/pwa/', import.meta.url);
const copy = new URL('../relay-pwa/', import.meta.url);

/** Text compared with line endings normalized — git may check the two out differently. */
function read(url) {
	const bytes = fs.readFileSync(url);
	return /\.(png)$/.test(url.pathname) ? bytes.toString('base64') : bytes.toString('utf8').replace(/\r\n/g, '\n');
}

if (!fs.existsSync(source)) {
	console.log('test-relay-pwa-sync: openvs-relay/ not present in this checkout, skipped');
	process.exit(0);
}
const expected = fs.readdirSync(source).sort();
assert.deepEqual(fs.readdirSync(copy).sort(), expected, 'relay-pwa/ has different files than openvs-relay/pwa — run scripts/sync-relay-pwa.mjs');
for (const name of expected) {
	assert.equal(read(new URL(name, copy)), read(new URL(name, source)), `relay-pwa/${name} differs from openvs-relay/pwa/${name} — run scripts/sync-relay-pwa.mjs`);
}
console.log('test-relay-pwa-sync: all assertions passed');
