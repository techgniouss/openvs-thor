/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/prompt.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-prompt.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/prompt.js', import.meta.url));

const window = {
	prefix: 'function add(a, b) {\n\t',
	suffix: '\n}\n',
	languageId: 'javascript',
	relativePath: 'src/math.js',
	imports: 'import assert from "assert";',
	eol: '\n',
};

const msgs = m.buildChatPrompt(window);

// Exactly two turns: a system instruction and the cursor context. No conversation history
// belongs here — a completion is stateless and every extra token is paid per keystroke.
assert.strictEqual(msgs.length, 2);
assert.strictEqual(msgs[0].role, 'system');
assert.strictEqual(msgs[1].role, 'user');

// The instruction must forbid the exact artifacts sanitize.ts otherwise has to repair.
const system = msgs[0].content.toLowerCase();
for (const rule of ['no explanation', 'no markdown', 'do not repeat']) {
	assert.ok(system.includes(rule), `system prompt must state: ${rule}`);
}

// The user turn carries language, path, imports, and the split around the cursor.
const user = msgs[1].content;
assert.ok(user.includes('javascript'));
assert.ok(user.includes('src/math.js'));
assert.ok(user.includes('import assert from "assert";'));
assert.ok(user.includes(window.prefix));
assert.ok(user.includes(window.suffix));

// An empty import block must not leave a dangling empty section.
const bare = m.buildChatPrompt({ ...window, imports: '' });
assert.ok(!/imports:\s*\n\s*\n/i.test(bare[1].content));

// Stop sequences cut the two runaway shapes: a new fence and a paragraph break.
assert.deepStrictEqual(m.COMPLETION_STOP, ['```', '\n\n\n']);

// FIM gets its own, shorter stop: a real FIM endpoint never emits a fence (it isn't a chat
// model), and a triple newline is far too loose a bound for a ~96-token completion. Reusing
// COMPLETION_STOP on the FIM path — which an earlier draft of this plan did — leaves an
// inert stop token and one that is too permissive to matter.
assert.deepStrictEqual(m.FIM_STOP, ['\n\n']);

console.log('all assertions passed');
