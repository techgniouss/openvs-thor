/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Copies the phone app (openvs-relay/pwa) into this extension as relay-pwa/, which the local
// relay (src/remote/local/relayServer.ts) serves. The extension ships on its own, without the
// openvs-relay package beside it, so it has to carry its own copy. Run after editing the PWA:
//   node extensions/openvs-chat/scripts/sync-relay-pwa.mjs
// test-relay-pwa-sync.mjs fails while the two differ.
import fs from 'node:fs';

const source = new URL('../../../openvs-relay/pwa/', import.meta.url);
const target = new URL('../relay-pwa/', import.meta.url);

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const name of fs.readdirSync(source).sort()) {
	fs.copyFileSync(new URL(name, source), new URL(name, target));
}
console.log(`relay-pwa: copied ${fs.readdirSync(target).length} files from openvs-relay/pwa`);
