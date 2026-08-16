/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/git/commitMessage.ts's pure prompt builder. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-commit-message.mjs
//
// buildCommitMessagePrompt itself never touches the `vscode` host API, but importing the
// module still runs its top-level `import * as vscode from 'vscode'` — stub it the same way
// test-tools.mjs does so that resolves without a real VS Code host.
import assert from 'node:assert/strict';
import Module from 'node:module';

const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : load.call(this, request, ...rest);
};

const m = await import(new URL('../out/git/commitMessage.js', import.meta.url));

// A normal diff is embedded whole, fenced, with the instruction ahead of it.
const diff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n';
const prompt = m.buildCommitMessagePrompt(diff);
assert.ok(prompt.includes('Conventional Commits'), 'names the style to follow');
assert.ok(prompt.includes('```diff'), 'diff is fenced');
assert.ok(prompt.includes(diff.trim()), 'full diff is included when under the cap');
assert.ok(prompt.indexOf('Write a git commit message') < prompt.indexOf(diff), 'instruction precedes the diff');

// An oversized diff is truncated rather than sent whole, and says so.
const huge = 'x'.repeat(20_000);
const hugePrompt = m.buildCommitMessagePrompt(huge);
assert.ok(hugePrompt.length < huge.length + 500, 'oversized diff is capped, not embedded whole');
assert.ok(hugePrompt.includes('truncated'), 'truncation is noted for the model');

// stripWrappingFence: a fence wrapping the whole reply is removed...
assert.equal(m.stripWrappingFence('```\nfeat: add thing\n```'), 'feat: add thing');
assert.equal(m.stripWrappingFence('```text\nfeat: add thing\n```'), 'feat: add thing');
// ...but a fence that isn't the whole reply is left alone, and plain text is untouched.
assert.equal(m.stripWrappingFence('feat: add thing\n\nSee also:\n```\nsnippet\n```'), 'feat: add thing\n\nSee also:\n```\nsnippet\n```');
assert.equal(m.stripWrappingFence('feat: add thing'), 'feat: add thing');

console.log('test-commit-message: all assertions passed');
