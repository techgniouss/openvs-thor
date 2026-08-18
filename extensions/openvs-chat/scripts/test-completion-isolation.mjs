/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Guards the non-interference contract in section 3 of the design spec. The completion path
// shares mutable state with chat and Agent, and touching any of it from here changes
// behaviour the user did not ask to change. Static because the point is that these calls
// must not exist at all, not that they happen to be unreachable today. Run:
//   node extensions/openvs-chat/scripts/test-completion-isolation.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src', 'completions');
const sources = fs.readdirSync(dir)
	.filter(f => f.endsWith('.ts'))
	.map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
assert.ok(sources.length >= 10, `expected the completions module to be complete, saw ${sources.length} files`);

const banned = [
	// Module-global in providers/types.ts: setting it changes chat's stall detection too.
	['setStreamIdleTimeout', 'pass ReadSSEOptions.idleMs per request instead'],
	// Writes openvsChat.<provider>.model, which is the CHAT model, not the completion one.
	['.setModel(', 'write openvsChat.completions.model instead'],
	// Belongs to the agent loop; a 96-token completion must not tighten an agent budget.
	['adoptRequestCeiling', 'completions must not adjust agent budgets'],
	// Bundles a `pace` hook that would sleep out a refill window; see noteOnlyOpts.
	['fetchOpts(', 'use rateLimits.noteOnlyOpts() so completions never pace'],
];

for (const [file, text] of sources) {
	for (const [needle, why] of banned) {
		assert.ok(!text.includes(needle), `${file} must not use ${needle} — ${why}`);
	}
}

// AUTO_ROLES must not have grown a completion entry.
const router = fs.readFileSync(path.join(here, '..', 'src', 'auto', 'router.ts'), 'utf8');
assert.match(router, /AUTO_ROLES: AutoRole\[\] = \['plan', 'code', 'review'\]/);

console.log('all assertions passed');
