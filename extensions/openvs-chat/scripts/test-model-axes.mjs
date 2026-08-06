/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test asserting that every model a provider *suggests* is actually usable.
// Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-model-axes.mjs
//
// A suggested model is what the picker offers before any catalog has been fetched, so it is
// the first thing most people ever run. Three independent things decide whether it works,
// and each is a regex table maintained by hand in a different file:
//
//   * `toolModelPatterns` gates Agent mode. A miss doesn't error — the mode is quietly
//     unavailable for that model, which reads as "Agent mode is broken", not "wrong model".
//   * `visionModelPatterns` gates image attachments, same silent-failure shape.
//   * `contextWindow.ts` sizes the conversation budget. A miss lands on the 32k default,
//     and on a 128k+ model that makes compaction fire from the first few file reads onward,
//     summarizing away working state the run still needs.
//
// Nothing else checks that the three tables agree with the model lists they describe, and
// they are edited independently every time a provider is added or a vendor renames a model.
import assert from 'node:assert/strict';
import Module from 'node:module';

// Several providers reach `vscode` transitively (openai → chatgptBackend → oauth), which
// doesn't exist outside the extension host. Nothing here calls into it — the module only has
// to resolve for the import to succeed.
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? {} : load.call(this, request, ...rest);
};

const { modelSupportsTools, modelSupportsVision } = await import(new URL('../out/providers/types.js', import.meta.url));
const { contextWindowFor } = await import(new URL('../out/agent/contextWindow.js', import.meta.url));

/** Every provider module, in registry order. */
const PROVIDER_FILES = [
	'nvidia', 'openai', 'anthropic', 'gemini', 'antigravity', 'openrouter',
	'groq', 'mistral', 'cloudflare', 'kimi', 'qwen', 'custom',
];

/**
 * Providers whose suggested models legitimately land on the default context window: the
 * `custom` provider's default is an Ollama tag standing in for "whatever you run locally",
 * which genuinely has no knowable window.
 */
const WINDOW_EXEMPT = new Set(['custom']);

/**
 * Providers that currently serve no vision model, so none of their suggestions can accept
 * an image. Listing them here rather than relaxing the check keeps the claim reviewable:
 *
 *   * `antigravity` declares a never-matching sentinel pattern (`^\x00$`) on purpose.
 *   * `groq` keeps the Llama 4 family names, which Groq's catalog no longer lists. Blocking
 *     images is the correct behaviour for every model it does serve, and the patterns cost
 *     nothing if Scout returns — an empty pattern list would instead mean "assume every
 *     model takes images" and hand the user an opaque 400.
 */
const NO_VISION_MODELS = new Set(['antigravity', 'groq']);

/** Instantiates each provider and reads its declared `info`. */
async function providers() {
	const out = [];
	for (const file of PROVIDER_FILES) {
		const mod = await import(new URL(`../out/providers/${file}.js`, import.meta.url));
		let info;
		for (const exported of Object.values(mod)) {
			if (typeof exported !== 'function' || !exported.prototype) {
				continue;
			}
			try {
				const candidate = new exported().info;
				if (candidate?.id) {
					info = candidate;
					break;
				}
			} catch {
				// Not a zero-arg provider constructor.
			}
		}
		assert.ok(info, `${file}.js exports no provider with an \`info\``);
		out.push(info);
	}
	return out;
}

const infos = await providers();

// 1. Every suggested model must be able to drive Agent mode. Suggesting one that can't is
// how a provider ends up looking half-broken: the model answers in Ask and the Agent toggle
// is simply missing, with nothing on screen connecting the two.
{
	const cannot = [];
	for (const info of infos) {
		for (const model of info.suggestedModels) {
			if (info.supportsTools && !modelSupportsTools(info, model)) {
				cannot.push(`${info.id}: ${model}`);
			}
		}
	}
	assert.deepStrictEqual(cannot, [], 'suggested models that cannot run Agent mode');
}

// 2. No suggested model may fall through to the 32k default window. Every provider here
// ships large-context models, so landing on the default means the pattern table simply
// doesn't know the id — and the run pays for it in premature compaction, silently.
{
	const defaulted = [];
	for (const info of infos) {
		if (WINDOW_EXEMPT.has(info.id)) {
			continue;
		}
		for (const model of info.suggestedModels) {
			if (contextWindowFor(model) === 32_000) {
				defaulted.push(`${info.id}: ${model}`);
			}
		}
	}
	assert.deepStrictEqual(defaulted, [], 'suggested models landing on the default context window');
}

// 3. A provider that declares vision patterns at all must have at least one suggested model
// that satisfies them — otherwise image attachments are unreachable from the picker, and the
// only way to find a vision model is to already know its name.
{
	const unreachable = [];
	for (const info of infos) {
		if (!info.visionModelPatterns.length || NO_VISION_MODELS.has(info.id)) {
			continue; // permissive by design, or a documented no-vision backend
		}
		if (!info.suggestedModels.some(model => modelSupportsVision(info, model))) {
			unreachable.push(info.id);
		}
	}
	assert.deepStrictEqual(unreachable, [], 'providers whose suggested models are all vision-incapable');
}

// 4. The patterns are regex sources compiled with `new RegExp(p, 'i')` at match time, where
// a syntax error is swallowed and silently reported as "no match" — so a typo disables the
// capability it was meant to enable, with no error anywhere.
{
	const broken = [];
	for (const info of infos) {
		for (const pattern of [...info.toolModelPatterns, ...info.visionModelPatterns]) {
			try {
				new RegExp(pattern, 'i');
			} catch {
				broken.push(`${info.id}: ${pattern}`);
			}
		}
	}
	assert.deepStrictEqual(broken, [], 'unparseable capability patterns');
}

console.log('test-model-axes.mjs: all assertions passed');
