/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/mcp/httpClient.ts — the remote MCP transport. Run:
//   node extensions/openvs-chat/scripts/test-mcp-http.mjs
//
// Driven against a real HTTP server rather than a mocked fetch, because everything that
// makes this module hard is on the wire: which content type a reply comes back as, where
// a reply arrives at all (the POST's own response, or a long-lived GET), and the session
// header that has to be echoed. A stubbed fetch would assert our own assumptions back at us.
import assert from 'node:assert/strict';
import http from 'node:http';

const { McpHttpClient } = await import(new URL('../out/mcp/httpClient.js', import.meta.url));
const { flattenContent } = await import(new URL('../out/mcp/client.js', import.meta.url));

/** The tool list and call result both servers below answer with. */
const TOOLS = [{ name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }];

/** Builds a JSON-RPC reply for one request, shared by both transports. */
function reply(request, sessionSeen) {
	if (request.method === 'initialize') {
		return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } };
	}
	if (request.method === 'tools/list') {
		return { jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } };
	}
	if (request.method === 'tools/call') {
		if (request.params?.name === 'boom') {
			return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'tool exploded' } };
		}
		return {
			jsonrpc: '2.0', id: request.id, result: {
				content: [
					{ type: 'text', text: `q=${request.params?.arguments?.q} session=${sessionSeen ?? 'none'}` },
					{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(4000) },
				],
			},
		};
	}
	return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `no such method ${request.method}` } };
}

/** Reads a request body to a string. */
function body(req) {
	return new Promise(resolve => {
		let data = '';
		req.on('data', chunk => { data += chunk; });
		req.on('end', () => resolve(data));
	});
}

/** Starts a server on an ephemeral port and returns its base URL plus a stop(). */
async function listen(handler) {
	const server = http.createServer(handler);
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return { url: `http://127.0.0.1:${port}`, stop: () => new Promise(resolve => server.close(resolve)) };
}

// 1. Streamable HTTP: replies on the POST's own response, one as JSON and one as SSE, with
// a session id the client must echo from the handshake onward. Both content types are
// exercised because servers pick per response, not per connection.
{
	const seenAuth = [];
	const site = await listen(async (req, res) => {
		const request = JSON.parse(await body(req));
		seenAuth.push(req.headers.authorization);
		const session = req.headers['mcp-session-id'];
		if (request.method === 'notifications/initialized') {
			res.writeHead(202).end();
			return;
		}
		const payload = reply(request, session);
		if (request.method === 'tools/call') {
			// An SSE reply, with a notification ahead of it that the client must skip past.
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
			res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
			res.end();
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
		res.end(JSON.stringify(payload));
	});

	const client = new McpHttpClient({ url: site.url, headers: { Authorization: 'Bearer t0ken' } });
	await client.start();
	assert.deepStrictEqual(await client.listTools(), TOOLS);
	const called = await client.callTool('search', { q: 'mcp' });
	assert.deepStrictEqual(called, {
		text: 'q=mcp session=sess-1\n(image returned as image/png, ~3KB — not shown; this conversation carries text only)',
		isError: false,
	});
	// A JSON-RPC error is an error, not a result the model should read as an answer.
	await assert.rejects(client.callTool('boom', {}), /tool exploded/);
	assert.ok(seenAuth.every(v => v === 'Bearer t0ken'), 'configured headers go on every request');
	client.dispose();
	await site.stop();
}

// 2. Legacy HTTP+SSE: a POST is refused with 405, replies arrive on a long-lived GET, and
// requests go to the endpoint that stream names. This is still what a lot of deployed
// servers speak, so failing over to it is the difference between reaching them and not.
{
	let stream;
	const site = await listen(async (req, res) => {
		if (req.method === 'GET') {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write('event: endpoint\ndata: /rpc?session=abc\n\n');
			stream = res;
			return;
		}
		if (!req.url.startsWith('/rpc')) {
			res.writeHead(405).end(); // the signal that this server is legacy
			return;
		}
		const request = JSON.parse(await body(req));
		res.writeHead(202).end();
		if (request.id !== undefined) {
			stream.write(`data: ${JSON.stringify(reply(request, 'legacy'))}\n\n`);
		}
	});

	const client = new McpHttpClient({ url: site.url });
	await client.start();
	assert.deepStrictEqual(await client.listTools(), TOOLS);
	assert.equal((await client.callTool('search', { q: 'x' })).text.split('\n')[0], 'q=x session=legacy');
	client.dispose();
	stream?.end();
	await site.stop();
}

// 3. A server that is simply broken must fail its connection, not be mistaken for a legacy
// one and hang waiting for an endpoint event that is never coming.
{
	const site = await listen((req, res) => { res.writeHead(500).end('nope'); });
	const client = new McpHttpClient({ url: site.url });
	await assert.rejects(client.start(), /HTTP 500/);
	client.dispose();
	await site.stop();
}

// 4. Content flattening, which both transports share. A binary block is described, never
// inlined: a screenshot's base64 is re-sent on every later agent step, and one of them
// exceeds the whole per-request allowance on a small backend.
assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
assert.equal(flattenContent([{ type: 'resource', resource: { uri: 'file:///x', mimeType: 'application/pdf' } }]),
	'(resource file:///x (application/pdf) — binary content not shown)');
assert.equal(flattenContent([{ type: 'resource', resource: { uri: 'file:///x', text: 'inline text' } }]), 'inline text');
assert.equal(flattenContent([]), '(no output)');
assert.equal(flattenContent(undefined), '(no output)');

console.log('PASS test-mcp-http.mjs');
