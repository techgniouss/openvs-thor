/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone test asserting that src/remote/policy.ts's two lists exactly partition the
// webview→host message types the host dispatcher handles. Run:
//   node extensions/openvs-chat/scripts/test-remote-policy.mjs
//
// Deny-by-default only holds if it is enforced, not merely intended: without this test, a
// message type added next year (a new `case` in the host dispatcher) is not automatically
// denied to a remote client — it is simply absent from both lists, unchecked, and whoever
// wires up the remote transport has to remember to place it by hand. This test is what makes
// "every message type is placed in exactly one list" a build failure instead of a hope.
//
// No compiled output is imported — this reads source text with regexes, same as
// test-webview.mjs, so it does not depend on `out/` being up to date.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url = p => new URL(p, import.meta.url);

/**
 * Concatenates `fixed` files with every `.ts` file directly under each of `dirs`, joined by
 * `'\n'`. Directories that do not exist yet are skipped rather than throwing. Kept in sync
 * with test-webview.mjs's `readSourceSet`, but duplicated rather than shared — six lines
 * doesn't earn a shared helper module between two standalone test files.
 */
function readSourceSet(fixed, dirs) {
	const parts = fixed.map(p => fs.readFileSync(url(p), 'utf8'));
	for (const dir of dirs) {
		const dirUrl = url(dir + '/');
		if (!fs.existsSync(dirUrl)) {
			continue;
		}
		for (const entry of fs.readdirSync(dirUrl).sort()) {
			if (entry.endsWith('.ts')) {
				parts.push(fs.readFileSync(new URL(entry, dirUrl), 'utf8'));
			}
		}
	}
	return parts.join('\n');
}

const host = readSourceSet(['../src/chatViewProvider.ts'], ['../src/session', '../src/remote']);
const policySrc = fs.readFileSync(url('../src/remote/policy.ts'), 'utf8');

/** All matches of `re`'s first capture group, deduped. */
function captures(text, re) {
	return [...new Set([...text.matchAll(re)].map(m => m[1]))];
}

/** Every message type the host dispatcher handles, i.e. every case in its switch. */
const dispatcherCases = captures(host, /^\s*case '([a-zA-Z]+)':/gm);
assert.ok(dispatcherCases.length > 30, `expected the host dispatcher to be found, got ${dispatcherCases.length} cases`);

/** Extracts the string literals of an exported `const NAME: readonly string[] = [...]` array. */
function extractList(src, name) {
	const re = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`);
	const match = re.exec(src);
	assert.ok(match, `expected src/remote/policy.ts to export ${name}`);
	return captures(match[1], /'([a-zA-Z]+)'/g);
}

const allowed = extractList(policySrc, 'REMOTE_ALLOWED');
const denied = extractList(policySrc, 'REMOTE_DENIED');

// 1. Nothing may appear in both lists — an entry that is both allowed and denied is a
// contradiction, and whichever check runs last in the real dispatcher wins by accident.
{
	const both = allowed.filter(t => denied.includes(t)).sort();
	assert.deepStrictEqual(both, [], 'these types are in both REMOTE_ALLOWED and REMOTE_DENIED — remove from one');
}

// 2. Every dispatcher case must appear in exactly one list. A case in neither list is the
// exact failure this file exists to catch: a message type that is remotely inert only by
// accident, not by declared policy.
{
	const missing = dispatcherCases.filter(t => !allowed.includes(t) && !denied.includes(t)).sort();
	assert.deepStrictEqual(missing, [],
		'these host dispatcher cases are in neither list — add each to REMOTE_ALLOWED or REMOTE_DENIED in src/remote/policy.ts');
}

// 3. Every list entry must be a real dispatcher case, so entries cannot rot after a handler
// is deleted and quietly keep describing a message type that no longer exists.
{
	const stale = [...allowed, ...denied].filter(t => !dispatcherCases.includes(t)).sort();
	assert.deepStrictEqual(stale, [],
		'these entries in REMOTE_ALLOWED/REMOTE_DENIED are not real host dispatcher cases — remove them from src/remote/policy.ts');
}

console.log('test-remote-policy: all assertions passed');
