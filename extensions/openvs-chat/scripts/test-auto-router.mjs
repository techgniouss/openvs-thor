/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for Auto's model routing in src/auto/router.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-auto-router.mjs
//
// This is the half of Auto that decides *which* model serves each phase, and it fails
// silently by construction: a bad choice does not throw, it produces a run that 404s on
// its first request, spends premium credits nobody authorized, or reports "no provider can
// serve implementation" to a user whose key works fine everywhere else in the product.
// test-agent-loop.mjs drives the orchestrator against a stubbed router, so without this
// file nothing exercises the real one.
import assert from 'node:assert/strict';
import Module from 'node:module';

/** Settings the stubbed `getConfiguration('openvsChat')` reports. */
let settings = {};

const vscodeStub = {
	workspace: {
		getConfiguration: () => ({ get: key => settings[key], async update() { } }),
	},
	ConfigurationTarget: { Global: 1 },
};

const load = Module._load;
Module._load = (request, parent, isMain) =>
	request === 'vscode' ? vscodeStub : load(request, parent, isMain);

const { RoleRouter } = await import(new URL('../out/auto/router.js', import.meta.url));

/** Builds a provider stand-in with the fields the router actually reads. */
function provider(id, { label = id, models = [], tools = [], vision = [], requiresApiKey = true } = {}) {
	return {
		info: {
			id, label, requiresApiKey, supportsTools: true,
			suggestedModels: models, toolModelPatterns: tools, visionModelPatterns: vision,
		},
	};
}

/** Counts credential reads so the memoization can be asserted rather than assumed. */
let credentialReads = [];

/**
 * A registry stand-in. `keys` names the providers holding a credential; `selected` pins a
 * provider's currently-chosen chat model (what the user picked in the model dropdown).
 */
function registryOf(providers, { keys = [], selected = {} } = {}) {
	const byId = new Map(providers.map(p => [p.info.id, p]));
	return {
		get ids() { return [...byId.keys()]; },
		getProvider: id => byId.get(id),
		getModel: id => selected[id] ?? byId.get(id)?.info.suggestedModels[0] ?? '',
		async hasCredentials(id) {
			credentialReads.push(id);
			return keys.includes(id);
		},
	};
}

/** `provider:model` for an assignment, or its problem when it can't run. */
function summarize(a) {
	return a.ready ? `${a.providerId}:${a.model} (${a.source})` : `unready: ${a.problem}`;
}

const anthropic = provider('anthropic', {
	label: 'Anthropic',
	models: ['claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
	tools: ['claude-3', 'claude-[a-z]+-[4-9]'],
	vision: ['claude'],
});
const groq = provider('groq', {
	label: 'Groq',
	models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct'],
	tools: ['llama-3\\.[13]', 'llama-4'],
	vision: ['scout'],
});
const custom = provider('custom', { label: 'Custom', models: ['local-model'], requiresApiKey: false });

beforeEach();
function beforeEach() {
	settings = {};
	credentialReads = [];
}

// 1. A pinned role is honoured exactly and never substituted, however unfashionable the
// model — the whole point of pinning is that Auto stops choosing.
{
	beforeEach();
	settings['auto.planModel'] = 'groq:llama-3.1-8b-instant';
	const router = new RoleRouter(registryOf([anthropic, groq], { keys: ['anthropic', 'groq'] }));
	assert.deepStrictEqual(
		(await router.resolveRoleCandidates('plan')).map(summarize),
		['groq:llama-3.1-8b-instant (configured)'],
		'a pinned role yields exactly that model, and only it',
	);
}

// 2. A pinned model that cannot run says why, instead of being quietly swapped out. Each
// requirement gets its own message because each has a different fix.
{
	beforeEach();
	const router = new RoleRouter(registryOf([anthropic, groq], { keys: ['groq'] }));
	settings['auto.planModel'] = 'anthropic:claude-sonnet-5';
	const noKey = await router.resolveRole('plan');
	settings['auto.codeModel'] = 'groq:groq/compound-mini';
	const noTools = await router.resolveRole('code');
	settings['auto.planModel'] = 'groq:llama-3.3-70b-versatile';
	const noVision = await router.resolveRole('plan', { vision: true });
	settings['auto.planModel'] = 'nope:whatever';
	const noProvider = await router.resolveRole('plan');
	assert.deepStrictEqual(
		[noKey, noTools, noVision, noProvider].map(a => [a.ready, (a.problem ?? '').slice(0, 34)]),
		[
			[false, 'No API key for Anthropic. Add a ke'],
			[false, '"groq/compound-mini" is not tool-c'],
			[false, '"llama-3.3-70b-versatile" doesn\'t '],
			[false, 'Unknown provider "nope". Use the f'],
		],
		'every unusable pin is reported with the reason it is unusable',
	);
}

// 3. Inference never spends premium credits on the user's behalf: an Anthropic-only user
// gets Sonnet, not Fable or Opus, even though both are listed ahead of / next to it.
{
	beforeEach();
	const router = new RoleRouter(registryOf([anthropic, groq], { keys: ['anthropic'] }));
	const candidates = await router.resolveRoleCandidates('plan');
	assert.deepStrictEqual(
		candidates.map(a => a.model),
		['claude-sonnet-5', 'claude-haiku-4-5'],
		'premium models are excluded from automatic selection entirely',
	);
}

// 4. A user whose only credential is a free provider gets a working Auto — the failure the
// old vendor-ranked table produced was "no configured provider can serve planning" for a
// key that plain Ask/Agent used happily.
{
	beforeEach();
	const router = new RoleRouter(registryOf([anthropic, groq], { keys: ['groq'] }));
	assert.deepStrictEqual(
		[
			summarize(await router.resolveRole('plan')),
			summarize(await router.resolveRole('code')),
			summarize(await router.resolveRole('review')),
		],
		[
			'groq:llama-3.3-70b-versatile (inferred)',
			'groq:llama-3.3-70b-versatile (inferred)',
			'groq:llama-3.3-70b-versatile (inferred)',
		],
		'every role resolves from the one key the user actually holds',
	);
}

// 5. A provider is represented by *all* its models, not just the one currently selected in
// the chat dropdown: selecting a non-tool-capable model used to disqualify the provider
// from implementation altogether, even with tool-capable siblings sitting right there.
{
	beforeEach();
	const router = new RoleRouter(registryOf([groq], { keys: ['groq'], selected: { groq: 'llama-guard-4' } }));
	assert.deepStrictEqual(
		[
			summarize(await router.resolveRole('plan')),
			summarize(await router.resolveRole('code')),
		],
		[
			// The user's own selection wins where it qualifies…
			'groq:llama-guard-4 (inferred)',
			// …and where it can't serve the role, a sibling that can is used instead.
			'groq:llama-3.3-70b-versatile (inferred)',
		],
		'the selected model is preferred but never the provider\'s only representative',
	);
}

// 6. When the account's catalog has been fetched it is authoritative about what exists:
// offering a model it doesn't list buys a 404 on the run's first request.
{
	beforeEach();
	const catalog = id => (id === 'anthropic' ? [{ id: 'claude-haiku-4-5' }] : undefined);
	const router = new RoleRouter(registryOf([anthropic], { keys: ['anthropic'] }), catalog);
	assert.deepStrictEqual(
		(await router.resolveRoleCandidates('plan')).map(a => a.model),
		['claude-haiku-4-5'],
		'only models the fetched catalog lists are offered',
	);
}

// 7. Image attachments are a routing constraint, not a late 400: the request goes to a
// model that can read them, or nothing is claimed to be able to.
{
	beforeEach();
	const router = new RoleRouter(registryOf([groq], { keys: ['groq'] }));
	assert.deepStrictEqual(
		[
			summarize(await router.resolveRole('plan', { vision: true })),
			summarize(await router.resolveRole('code', { vision: true })),
		],
		[
			'groq:meta-llama/llama-4-scout-17b-16e-instruct (inferred)',
			'groq:meta-llama/llama-4-scout-17b-16e-instruct (inferred)',
		],
		'a vision requirement steers to the one checkpoint that accepts images',
	);
}

// 8. Nothing usable is reported as such, and the message names the requirement that could
// not be met rather than a generic failure.
{
	beforeEach();
	const router = new RoleRouter(registryOf([anthropic, groq], { keys: [] }));
	const plan = await router.resolveRole('plan');
	const code = await router.resolveRole('code');
	// Both requirements are named when both bind, or a user who attached an image is sent
	// hunting for a tool-capable model they already have.
	const codeWithImage = await router.resolveRole('code', { vision: true });
	assert.deepStrictEqual(
		[plan.ready, plan.problem, code.problem, codeWithImage.problem],
		[
			false,
			'No configured provider can serve planning. Add an API key (⚙ Providers) or pin a model in settings.',
			'No configured provider can serve implementation with a tool-capable model. Add an API key (⚙ Providers) or pin a model in settings.',
			'No configured provider can serve implementation with a tool-capable, vision-capable model. Add an API key (⚙ Providers) or pin a model in settings.',
		],
		'an empty configuration explains itself',
	);
}

// 9. Providers that must not be chosen unprompted stay unchosen: `custom` points at a local
// endpoint that may not be running. It remains available when pinned.
{
	beforeEach();
	const router = new RoleRouter(registryOf([custom], { keys: ['custom'] }));
	const inferred = await router.resolveRole('plan');
	settings['auto.planModel'] = 'custom:local-model';
	const pinned = await router.resolveRole('plan');
	assert.deepStrictEqual(
		[inferred.ready, summarize(pinned)],
		[false, 'custom:local-model (configured)'],
		'custom is never auto-selected but is always pinnable',
	);
}

// 10. Candidates are a fallback chain: bounded (each link is a request a failing run will
// make) and spread across providers (five models behind one revoked key are not a fallback
// from anything — the failure that takes one takes all five).
{
	beforeEach();
	const router = new RoleRouter(registryOf([anthropic, groq], { keys: ['anthropic', 'groq'] }));
	const candidates = await router.resolveRoleCandidates('code');
	const perProvider = {};
	for (const a of candidates) { perProvider[a.providerId] = (perProvider[a.providerId] ?? 0) + 1; }
	assert.deepStrictEqual(
		[candidates.length <= 5, candidates.every(a => a.ready), perProvider],
		[true, true, { anthropic: 2, groq: 2 }],
		'a bounded chain, capped per provider so it spans the keys the user holds',
	);
}

// 11. Resolving all three roles reads each provider's stored secret once, not once per
// role: this runs on the settings panel's render path and at the head of every Auto run.
{
	beforeEach();
	const router = new RoleRouter(registryOf([anthropic, groq], { keys: ['anthropic', 'groq'] }));
	await router.resolveAll();
	assert.deepStrictEqual(
		[...new Set(credentialReads)].length,
		credentialReads.length,
		`each provider's credential is read once per pass (got ${credentialReads.join(', ')})`,
	);
}

console.log('test-auto-router: all assertions passed');
