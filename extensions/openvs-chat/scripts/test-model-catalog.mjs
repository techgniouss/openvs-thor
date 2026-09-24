/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// The model picker lists what `OpenAICompatibleProvider.listModels` returns. A `/models`
// endpoint lists every model the account can reach — OpenAI's is mostly whisper, tts, dall-e,
// embeddings and moderation models, sorted in among the chat ones — so without filtering the
// picker read as a random list, and a pick from it failed on the first request. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-model-catalog.mjs
//
// Driven against a real local HTTP server, like test-fetch-url.mjs: the catalog is whatever
// comes back off the wire, and a stubbed fetch would only assert our own assumptions back.
import assert from 'node:assert/strict';
import http from 'node:http';

const { KimiProvider } = await import(new URL('../out/providers/kimi.js', import.meta.url));

/** Serves `ids` as an OpenAI-style `/models` catalog; resolves the base URL. */
async function serveCatalog(ids) {
	const server = http.createServer((req, res) => {
		if (req.url !== '/v1/models') {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) }));
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function listed(ids) {
	const { server, baseUrl } = await serveCatalog(ids);
	try {
		const entries = await new KimiProvider().listModels('key', baseUrl, new AbortController().signal);
		return entries.map(e => e.id);
	} finally {
		server.close();
	}
}

// Chat models survive, sorted; speech, image, embedding, moderation, realtime and legacy
// completion models do not.
assert.deepEqual(await listed([
	'whisper-1', 'gpt-4o', 'tts-1-hd', 'gpt-4o-mini-tts', 'text-embedding-3-small', 'dall-e-3',
	'omni-moderation-latest', 'gpt-4o-realtime-preview', 'davinci-002', 'gpt-image-1',
	'gpt-3.5-turbo-instruct', 'gpt-4o-audio-preview', 'o3-mini', 'nomic-embed-text',
	'llama-3.3-70b-instruct', 'qwen3-coder-plus', 'deepseek-r1',
]), ['deepseek-r1', 'gpt-4o', 'llama-3.3-70b-instruct', 'o3-mini', 'qwen3-coder-plus']);

// A catalog the filter doesn't recognize as chat at all is shown whole — an unfamiliar list
// beats an empty picker.
assert.deepEqual(await listed(['text-embedding-v3', 'whisper-large']), ['text-embedding-v3', 'whisper-large']);

// ---- ModelCatalog: the races that made the pickers show a different list each refresh ---------

const { ModelCatalog } = await import(new URL('../out/providers/modelCatalog.js', import.meta.url));

/** A lister whose replies the test releases by hand, in any order. */
function manualLister() {
	const pending = [];
	const lister = () => new Promise(resolve => pending.push(resolve));
	return { lister, pending, calls: () => pending.length };
}

// Concurrent loads share one fetch, and the result is cached.
{
	const m = manualLister();
	const catalog = new ModelCatalog(m.lister);
	const a = catalog.load('p', false);
	const b = catalog.load('p', false);
	assert.equal(m.calls(), 1, 'a burst of config refreshes makes one request, not one each');
	m.pending[0]([{ id: 'model-1' }]);
	assert.deepEqual([await a, await b], [[{ id: 'model-1' }], [{ id: 'model-1' }]]);
	await catalog.load('p', false);
	assert.equal(m.calls(), 1, 'served from cache afterwards');
	catalog.load('p', true);
	assert.equal(m.calls(), 2, 'an explicit refresh fetches again');
}

// A fetch started under an old key can't overwrite the catalog after the key changed.
{
	const m = manualLister();
	const catalog = new ModelCatalog(m.lister);
	const stale = catalog.load('p', false);
	catalog.invalidate('p');
	const fresh = catalog.load('p', false);
	assert.equal(m.calls(), 2, 'the invalidated fetch is not reused');
	m.pending[1]([{ id: 'new-account-model' }]);
	await fresh;
	m.pending[0]([{ id: 'old-account-model' }]);
	await stale;
	assert.deepEqual(catalog.get('p'), [{ id: 'new-account-model' }], 'the late reply from the old key is discarded');
}

console.log('test-model-catalog: all assertions passed');
