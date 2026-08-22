/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the `complete` routing role. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-router.mjs
import assert from 'node:assert/strict';
import Module from 'node:module';

// router.js imports 'vscode' at module scope (RoleRouter reads settings through it); stub it
// the same way test-auto-router.mjs does so this file can load the compiled module directly.
const vscodeStub = {
	workspace: {
		getConfiguration: () => ({ get: () => undefined, async update() { } }),
	},
	ConfigurationTarget: { Global: 1 },
};
const load = Module._load;
Module._load = (request, parent, isMain) =>
	request === 'vscode' ? vscodeStub : load(request, parent, isMain);

const m = await import(new URL('../out/auto/router.js', import.meta.url));

// The Auto pipeline must not learn about this role: AUTO_ROLES drives resolveAll() and the
// Auto settings rows, so a completion entry appearing there is a visible regression.
assert.deepStrictEqual(m.AUTO_ROLES, ['plan', 'code', 'review']);

// Reasoning models are excluded outright, not down-ranked: seconds of hidden reasoning
// before the first character makes a completion useless however good it eventually is.
for (const model of ['deepseek-r1', 'DeepSeek-R1-Distill-Qwen-7B', 'qwq-32b', 'o1', 'o3-mini',
	'qwen3-thinking', 'claude-opus-4', 'gpt-5.1-pro']) {
	assert.strictEqual(m.isCompletionExcluded(model), true, `${model} must be excluded`);
}
for (const model of ['codestral-latest', 'qwen2.5-coder:7b', 'llama-3.1-8b-instant',
	'ministral-3b-latest', 'gpt-4o-mini', 'codegemma:2b']) {
	assert.strictEqual(m.isCompletionExcluded(model), false, `${model} must be allowed`);
}

// Ranking is inverted relative to the Auto roles: small and fast wins, because a 70B model
// at 4s loses to a 3B model at 200ms regardless of which writes better code.
{
	const rank = (role, models) => [...models].sort((a, b) =>
		m.scoreForRole(role, b, false, 0) - m.scoreForRole(role, a, false, 0));
	const ordered = rank('complete', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'codestral-latest']);
	assert.strictEqual(ordered[0], 'codestral-latest', 'a FIM coder model ranks first');
	assert.ok(ordered.indexOf('llama-3.1-8b-instant') < ordered.indexOf('llama-3.3-70b-versatile'),
		'the small fast checkpoint outranks its large sibling for this role');
	// The opposite holds for the Auto code role — which is why complete needs its own row.
	assert.strictEqual(rank('code', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'])[0],
		'llama-3.3-70b-versatile');
}

// A user's explicit pick still outranks affinity, exactly as for the Auto roles.
assert.ok(m.scoreForRole('complete', 'llama-3.3-70b-versatile', true, 0)
	> m.scoreForRole('complete', 'codestral-latest', false, 0),
	'a pinned model is never demoted by ranking');

// The pin round-trips through one `provider:model` key, matching the Auto roles. An earlier
// design used two separate keys and contradicted the mechanism it claimed to reuse.
assert.strictEqual(m.roleSettingKey('complete'), 'completions.model');
assert.strictEqual(m.roleSettingKey('plan'), 'auto.planModel');

// --- CompletionModelResolver: local-endpoint admission -----------------------------------
// The router excludes `custom` from every role's pool by default (a local endpoint may not
// be running). For `complete` that default is wrong once reachability is known, and the
// resolver is what's supposed to make that determination and pass it through — this is the
// wiring between the two files, not just either file's own table, and it is exactly the kind
// of gap that compiles cleanly and then silently never admits the local model.
{
	const { CompletionModelResolver } = await import(new URL('../out/completions/completionModel.js', import.meta.url));

	const seenLocalReachable = [];
	const stubRouter = {
		async resolveRole(role, needs, memo, localReachable) {
			seenLocalReachable.push(localReachable);
			return {
				role, roleLabel: '', providerId: 'custom', providerLabel: 'Custom',
				model: 'qwen2.5-coder', source: 'inferred', ready: true,
			};
		},
	};

	let releaseProbe;
	const probeGate = new Promise(resolve => { releaseProbe = resolve; });
	const stubRegistry = {
		getProvider: () => ({ info: { fimModelPatterns: ['coder'] } }),
		async listModels() { await probeGate; return []; },
	};

	const resolver = new CompletionModelResolver(stubRouter, stubRegistry);

	// The first call must not block on the probe it kicks off — it routes on the not-yet-known
	// (false) result immediately, exactly as it would if the local endpoint were slow or down.
	await resolver.resolve();
	assert.strictEqual(seenLocalReachable[0], false,
		'first call routes on the prior result rather than blocking on a fresh probe');

	// Let the in-flight probe resolve, then give its .then() a turn to run.
	releaseProbe();
	await probeGate;
	await new Promise(resolve => setImmediate(resolve));

	// A completed probe is reflected starting on the next call.
	await resolver.resolve();
	assert.strictEqual(seenLocalReachable[1], true,
		'a completed reachability probe admits custom on the following call');
}

console.log('all assertions passed');
