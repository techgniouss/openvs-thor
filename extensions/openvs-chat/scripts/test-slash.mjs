/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the host-side slash-command dispatch in src/session/slash.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-slash.mjs
//
// src/session/ imports nothing from `vscode`, so — like test-session-store.mjs — this needs no
// Module._load stub: the compiled module is imported directly, and a fake SlashEffects (a real
// implementation of the interface, not a mocked-out `any`) records what runSlash calls.
import assert from 'node:assert/strict';
import { SLASH_COMMANDS, SLASH_INLINE, buildSkillsText, parseSlash, runSlash } from '../out/session/slash.js';

/** A real SlashEffects implementation that records every call instead of acting on it. */
function makeEffects(skillsSnapshot) {
	const calls = [];
	const effects = {
		setMode: mode => calls.push({ fn: 'setMode', mode }),
		setAutoProvider: () => calls.push({ fn: 'setAutoProvider' }),
		clearSession: () => calls.push({ fn: 'clearSession' }),
		slashInline: (command, text) => calls.push({ fn: 'slashInline', command, text }),
		setSkill: id => calls.push({ fn: 'setSkill', id }),
		createSkill: () => calls.push({ fn: 'createSkill' }),
		mcpAdd: () => calls.push({ fn: 'mcpAdd' }),
		mcpReconnect: () => calls.push({ fn: 'mcpReconnect' }),
		openMcpSettings: () => calls.push({ fn: 'openMcpSettings' }),
		reply: text => calls.push({ fn: 'reply', text }),
		listSkills: () => skillsSnapshot ?? { skills: [], active: [] },
	};
	return { effects, calls };
}

/** Names every command SLASH_COMMANDS carries only for the composer's autocomplete menu — never
 * dispatched by `runSlash` because the action is inherently client-owned (see slash.ts's own doc
 * on `runSlash`: opening a UI panel, or filling a composer whose result already round-trips
 * through `enhancePrompt`). Kept as an explicit, named exception set — rather than silently
 * excluding whatever `runSlash` happens not to recognize — so a *new* catalog entry that
 * `runSlash` doesn't dispatch fails loudly here instead of quietly joining this list. */
const CLIENT_ONLY_COMMANDS = new Set(['history', 'enhance']);

// 1. parseSlash: the regex, ported verbatim.
{
	assert.deepStrictEqual(parseSlash('/ask hello'), { cmd: 'ask', rest: 'hello' });
	assert.deepStrictEqual(parseSlash('/ASK   Hello there  '), { cmd: 'ask', rest: 'Hello there' },
		'the command is lowercased, the rest is trimmed but keeps its own case');
	assert.deepStrictEqual(parseSlash('/help'), { cmd: 'help', rest: '' });
	assert.strictEqual(parseSlash('not a command'), undefined);
	assert.strictEqual(parseSlash(''), undefined);
}

// 2. Catalog ⇄ dispatcher parity: every SLASH_COMMANDS entry not in CLIENT_ONLY_COMMANDS is
// recognized (handled: true) by runSlash, and every one of those is a real catalog entry. This
// is the check that keeps "one source of truth" real for the commands that actually moved
// host-side — see slash.ts's own doc on why /history and /enhance are the deliberate exceptions.
{
	for (const { cmd } of SLASH_COMMANDS) {
		const { effects } = makeEffects();
		const result = runSlash(`/${cmd}`, effects);
		if (CLIENT_ONLY_COMMANDS.has(cmd)) {
			assert.strictEqual(result.handled, false, `/${cmd} is client-only and must not be recognized by runSlash`);
		} else {
			assert.strictEqual(result.handled, true, `/${cmd} is in SLASH_COMMANDS but runSlash does not recognize it`);
		}
	}
	// ...and the reverse: nothing runSlash recognizes is absent from the catalog (the
	// autocomplete menu would otherwise offer a command it cannot actually complete to).
	const catalogCmds = new Set(SLASH_COMMANDS.map(c => c.cmd));
	for (const cmd of ['ask', 'plan', 'agent', 'auto', 'skills', 'skill', 'mcp', 'clear', 'help', ...SLASH_INLINE]) {
		assert.ok(catalogCmds.has(cmd), `runSlash recognizes /${cmd} but it is missing from SLASH_COMMANDS`);
	}
}

// 3. /ask, /plan, /agent — mode switch, with and without a piggybacked message. /edit is the
// legacy alias for the mode Plan replaced.
{
	for (const [cmd, mode] of [['ask', 'ask'], ['plan', 'plan'], ['agent', 'agent'], ['edit', 'plan']]) {
		const { effects, calls } = makeEffects();
		const result = runSlash(`/${cmd}`, effects);
		assert.deepStrictEqual(result, { handled: true });
		assert.deepStrictEqual(calls, [{ fn: 'setMode', mode }]);
	}
	const { effects, calls } = makeEffects();
	const result = runSlash('/ask hello', effects);
	assert.deepStrictEqual(result, { handled: true, sendRest: 'hello' });
	assert.deepStrictEqual(calls, [{ fn: 'setMode', mode: 'ask' }]);
}

// 4. /auto — Auto provider + Agent mode, with and without a piggybacked message.
{
	const { effects, calls } = makeEffects();
	const result = runSlash('/auto', effects);
	assert.deepStrictEqual(result, { handled: true });
	assert.deepStrictEqual(calls, [{ fn: 'setAutoProvider' }, { fn: 'setMode', mode: 'agent' }]);
}
{
	const { effects, calls } = makeEffects();
	const result = runSlash('/auto build the thing', effects);
	assert.deepStrictEqual(result, { handled: true, sendRest: 'build the thing' });
	assert.deepStrictEqual(calls, [{ fn: 'setAutoProvider' }, { fn: 'setMode', mode: 'agent' }]);
}

// 5. The five inline editor actions.
{
	for (const cmd of SLASH_INLINE) {
		const { effects, calls } = makeEffects();
		const result = runSlash(`/${cmd} do it better`, effects);
		assert.deepStrictEqual(result, { handled: true });
		assert.deepStrictEqual(calls, [{ fn: 'slashInline', command: cmd, text: 'do it better' }]);
	}
}

// 6. /skill — activate, deactivate-all, and scaffold a new one.
{
	{
		const { effects, calls } = makeEffects();
		assert.deepStrictEqual(runSlash('/skill impeccable', effects), { handled: true });
		assert.deepStrictEqual(calls, [{ fn: 'setSkill', id: 'impeccable' }]);
	}
	for (const off of ['off', 'none']) {
		const { effects, calls } = makeEffects();
		assert.deepStrictEqual(runSlash(`/skill ${off}`, effects), { handled: true });
		assert.deepStrictEqual(calls, [{ fn: 'setSkill', id: '' }]);
	}
	for (const create of ['new', 'create']) {
		const { effects, calls } = makeEffects();
		assert.deepStrictEqual(runSlash(`/skill ${create}`, effects), { handled: true });
		assert.deepStrictEqual(calls, [{ fn: 'createSkill' }]);
	}
}

// 7. /mcp — bare opens Settings, add/reconnect dispatch directly.
{
	const { effects, calls } = makeEffects();
	assert.deepStrictEqual(runSlash('/mcp', effects), { handled: true });
	assert.deepStrictEqual(calls, [{ fn: 'openMcpSettings' }]);
}
{
	const { effects, calls } = makeEffects();
	assert.deepStrictEqual(runSlash('/mcp add', effects), { handled: true });
	assert.deepStrictEqual(calls, [{ fn: 'mcpAdd' }]);
}
{
	const { effects, calls } = makeEffects();
	assert.deepStrictEqual(runSlash('/mcp reconnect', effects), { handled: true });
	assert.deepStrictEqual(calls, [{ fn: 'mcpReconnect' }]);
}

// 8. /clear — the same effect case 'clearSession' has.
{
	const { effects, calls } = makeEffects();
	assert.deepStrictEqual(runSlash('/clear', effects), { handled: true });
	assert.deepStrictEqual(calls, [{ fn: 'clearSession' }]);
}

// 9. /help and /skills reply with non-empty, host-generated text — and /skills' text is built
// from exactly the data `listSkills()` (i.e. postSkills()) hands back, so it cannot drift.
{
	const { effects, calls } = makeEffects();
	assert.deepStrictEqual(runSlash('/help', effects), { handled: true });
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].fn, 'reply');
	assert.ok(calls[0].text.length > 0 && calls[0].text.includes('Slash commands'));
}
{
	const snapshot = { skills: [{ id: 'impeccable', name: 'Impeccable', description: 'UI polish' }], active: ['impeccable'] };
	const { effects, calls } = makeEffects(snapshot);
	assert.deepStrictEqual(runSlash('/skills', effects), { handled: true });
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].fn, 'reply');
	assert.strictEqual(calls[0].text, buildSkillsText(snapshot));
	assert.ok(calls[0].text.includes('impeccable') && calls[0].text.includes('✓ active'));
}

// 10. Unrecognized input — a typo, plain text, /history, and /enhance all report handled: false
// so the caller's own "treat as a normal message" fallback applies, and no effect is called.
{
	for (const text of ['/foo', '/foo bar', 'not a slash command at all', '/history', '/history reopen', '/enhance make this better']) {
		const { effects, calls } = makeEffects();
		assert.deepStrictEqual(runSlash(text, effects), { handled: false }, `"${text}" must not be handled`);
		assert.deepStrictEqual(calls, [], `"${text}" must not call any effect`);
	}
}

console.log('test-slash: all assertions passed');
