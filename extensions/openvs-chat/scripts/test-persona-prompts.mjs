/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/persona/prompts.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-prompts.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/persona/prompts.js', import.meta.url));

// personaBase layers: identity first, env section when present, user base last.
const base = m.personaBase('cwd: /repo\nbranch: main', 'User custom rules');
assert.ok(base.startsWith('You are Thor'), 'identity must lead');
assert.ok(base.includes('# Environment'), 'env section present');
assert.ok(base.indexOf('# Environment') < base.indexOf('User custom rules'), 'user base after env');

// Empty env / empty user base: sections omitted, no double blank-line artifacts.
const bare = m.personaBase('', '');
assert.ok(bare.startsWith('You are Thor'));
assert.ok(!bare.includes('# Environment'));
assert.ok(!/\n{3,}/.test(bare), 'no triple newlines');

// Mode doctrines.
const agent = m.modeDoctrine('agent', {});
assert.ok(/AGENT mode/.test(agent));
assert.ok(/update_todos/.test(agent), 'agent doctrine references todo tool');
assert.ok(/<thinking>/.test(agent), 'agent doctrine includes thinking scaffold');
assert.ok(/verify/i.test(agent), 'agent doctrine demands verification');

const plan = m.modeDoctrine('plan', { readTools: true });
assert.ok(/PLAN mode/.test(plan));
assert.ok(/read_file/.test(plan), 'plan mentions read tools when readTools');
assert.ok(!/update_todos/.test(plan), 'no todo doctrine outside agent');

const planNoTools = m.modeDoctrine('plan', {});
assert.ok(!/read_file/.test(planNoTools));

const ask = m.modeDoctrine('ask', { readTools: true });
assert.ok(/ASK mode/.test(ask));
assert.ok(/<thinking>/.test(ask));

// thinking toggle: thinking:false drops the scaffold; TASKS (todos) stays.
const agentNoThink = m.modeDoctrine('agent', { thinking: false });
assert.ok(!/<thinking>/.test(agentNoThink), 'thinking:false removes scaffold in agent');
assert.ok(/update_todos/.test(agentNoThink), 'todos doctrine independent of thinking');
assert.ok(!/<thinking>/.test(m.modeDoctrine('ask', { thinking: false })), 'thinking:false removes scaffold in ask');
assert.ok(!/<thinking>/.test(m.modeDoctrine('plan', { thinking: false })), 'thinking:false removes scaffold in plan');
// default (omitted) keeps thinking on.
assert.ok(/<thinking>/.test(m.modeDoctrine('ask', {})), 'thinking on by default');

// Edit: no thinking scaffold (would corrupt code-block extraction), inline vs whole-file.
const editInline = m.modeDoctrine('edit', { inline: true });
assert.ok(/EDIT mode/.test(editInline));
assert.ok(!/<thinking>/.test(editInline), 'edit must not include thinking scaffold');
assert.ok(/selection/i.test(editInline));
const editFile = m.modeDoctrine('edit', {});
assert.ok(/COMPLETE updated file/i.test(editFile));

// Subagent preamble exists and carries the identity discipline.
assert.ok(m.SUBAGENT_PREAMBLE.includes('evidence'), 'subagent preamble carries evidence discipline');

// Compact tier: for models whose request budget cannot carry the full prompt.
{
	const full = m.personaBase('cwd: /repo', 'User custom rules');
	const compact = m.personaBase('cwd: /repo', 'User custom rules', true);
	assert.ok(compact.startsWith('You are Thor'), 'compact identity still leads');
	assert.ok(compact.includes('# Environment') && compact.includes('User custom rules'), 'env and the user\'s own prompt are kept');
	assert.ok(compact.length < full.length, 'compact identity is shorter');
	for (const mode of ['ask', 'plan', 'agent']) {
		const c = m.modeDoctrine(mode, { readTools: true, compact: true });
		const f = m.modeDoctrine(mode, { readTools: true });
		assert.ok(c.length * 2 < f.length, `${mode}: compact doctrine is well under half the full one (${c.length} vs ${f.length})`);
		assert.ok(!/<thinking>/.test(c), `${mode}: no thinking scaffold in the compact tier`);
		assert.ok(c.includes(`${mode.toUpperCase()} mode`), `${mode}: still names its mode`);
	}
	const agentC = m.modeDoctrine('agent', { compact: true });
	for (const rule of [/verify/i, /edit_file/, /never guess a path/i, /run_command only runs real programs/i, /ask_user/, /update_todos/, /12→/]) {
		assert.ok(rule.test(agentC), `compact agent doctrine keeps ${rule}`);
	}
	assert.ok(/read_file/.test(m.modeDoctrine('ask', { readTools: true, compact: true })), 'compact ask still names its tools');
	assert.ok(!/read_file/.test(m.modeDoctrine('ask', { compact: true })), 'and only when it has them');
	assert.strictEqual(m.modeDoctrine('edit', { inline: true, compact: true }), editInline, 'edit is already minimal and unchanged');
}

console.log('test-persona-prompts: all assertions passed');
