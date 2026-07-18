/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reference "web sign-in" server for OpenVS AI Chat.
 *
 * This is the backend that the chat's "Sign in with web" button talks to. Point a
 * provider's auth URL at it, e.g.:
 *
 *   "openvsChat.nvidia.authUrl": "http://localhost:7345/login"
 *
 * The contract (see README.md) is:
 *   1. The editor opens  <authUrl>?redirect_uri=<editor-callback>&state=<nonce>&provider=<id>
 *   2. This server authenticates the user (here: a demo form, or a shared key)
 *   3. It redirects the browser back to  <redirect_uri>&token=<api-token>
 *   4. The editor's URI handler stores <api-token> as that provider's key.
 *
 * Two modes are demonstrated:
 *   - Shared key (zero-config for users): set env SHARED_KEY_<PROVIDER> and the server
 *     hands that key straight to the editor with no prompt — e.g. SHARED_KEY_NVIDIA=nvapi-...
 *   - Interactive (demo): otherwise it shows a page where the user pastes/obtains a token.
 *
 * A real deployment would replace the demo page with a genuine OAuth flow against the
 * provider (or your own identity service) and mint a short-lived, per-user token.
 *
 * Run with:  node server.mjs   (no dependencies; Node 18+)
 */

import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 7345);

// Optional proxy mode: when UPSTREAM + UPSTREAM_KEY are set, this server also forwards
// OpenAI-compatible /v1 requests to the real provider, injecting the real key on the
// server side so it never reaches the client. Combined with SESSION_TOKEN, users sign in
// and chat without ever holding a provider key. See README.md ("Keyless proxy").
const UPSTREAM = (process.env.UPSTREAM || '').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || '';
const SESSION_TOKEN = process.env.SESSION_TOKEN || '';

function html(strings, ...values) {
	return strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), '');
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, c =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Appends token to the editor callback URI (and state only if it isn't already present). */
function buildRedirect(redirectUri, token, state) {
	const sep = redirectUri.includes('?') ? '&' : '?';
	let url = `${redirectUri}${sep}token=${encodeURIComponent(token)}`;
	if (state && !/[?&]state=/.test(redirectUri)) {
		url += `&state=${encodeURIComponent(state)}`;
	}
	return url;
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);

	// Step 1+2: the editor sent the user here to authenticate.
	if (req.method === 'GET' && url.pathname === '/login') {
		const redirectUri = url.searchParams.get('redirect_uri') || '';
		const state = url.searchParams.get('state') || '';
		const provider = url.searchParams.get('provider') || 'provider';

		if (!redirectUri) {
			res.writeHead(400, { 'Content-Type': 'text/plain' });
			res.end('Missing redirect_uri');
			return;
		}

		// Zero-config path: hand a token to the client without prompting.
		//  - In proxy mode, that token is the SESSION_TOKEN (the real key stays on the server).
		//  - Otherwise it is a per-provider shared key handed directly to the client.
		const handoff = SESSION_TOKEN || process.env[`SHARED_KEY_${provider.toUpperCase()}`];
		if (handoff) {
			res.writeHead(302, { Location: buildRedirect(redirectUri, handoff, state) });
			res.end();
			return;
		}

		// Interactive demo path: collect a token, then redirect back to the editor.
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(html`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign in</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; }
  h1 { font-size: 1.3rem; } input, button { font-size: 1rem; padding: 8px; width: 100%; box-sizing: border-box; }
  button { margin-top: 12px; cursor: pointer; } .hint { color: #666; font-size: .85rem; }
</style></head>
<body>
  <h1>Sign in to ${escapeHtml(provider)}</h1>
  <p class="hint">This demo server hands a token back to your editor. In production this page
  would be a real ${escapeHtml(provider)} OAuth login that mints a token for you automatically.</p>
  <form method="POST" action="/complete">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
    <input type="hidden" name="state" value="${escapeHtml(state)}" />
    <input type="hidden" name="provider" value="${escapeHtml(provider)}" />
    <label>API token<br><input name="token" placeholder="paste a token" autofocus required /></label>
    <button type="submit">Authorize editor</button>
  </form>
</body></html>`);
		return;
	}

	// Step 3: receive the token and bounce the browser back to the editor.
	if (req.method === 'POST' && url.pathname === '/complete') {
		let body = '';
		req.on('data', chunk => { body += chunk; if (body.length > 1e6) { req.destroy(); } });
		req.on('end', () => {
			const form = new URLSearchParams(body);
			const redirectUri = form.get('redirect_uri') || '';
			const token = (form.get('token') || '').trim();
			const state = form.get('state') || '';
			if (!redirectUri || !token) {
				res.writeHead(400, { 'Content-Type': 'text/plain' });
				res.end('Missing redirect_uri or token');
				return;
			}
			res.writeHead(302, { Location: buildRedirect(redirectUri, token, state) });
			res.end();
		});
		return;
	}

	// Keyless proxy: forward OpenAI-compatible /v1 requests to the real provider.
	if (UPSTREAM && UPSTREAM_KEY && url.pathname.startsWith('/v1/')) {
		// Optionally require the session token the client received at sign-in.
		if (SESSION_TOKEN && req.headers['authorization'] !== `Bearer ${SESSION_TOKEN}`) {
			res.writeHead(401, { 'Content-Type': 'text/plain' });
			res.end('Invalid session token');
			return;
		}
		const upstreamUrl = `${UPSTREAM}${url.pathname.replace(/^\/v1/, '')}${url.search || ''}`;
		const chunks = [];
		req.on('data', chunk => { chunks.push(chunk); });
		req.on('end', async () => {
			try {
				const upstream = await fetch(upstreamUrl, {
					method: req.method,
					headers: {
						'Content-Type': req.headers['content-type'] || 'application/json',
						'Accept': req.headers['accept'] || 'application/json',
						'Authorization': `Bearer ${UPSTREAM_KEY}`,
					},
					body: chunks.length ? Buffer.concat(chunks) : undefined,
				});
				res.writeHead(upstream.status, {
					'Content-Type': upstream.headers.get('content-type') || 'application/json',
				});
				if (upstream.body) {
					Readable.fromWeb(upstream.body).pipe(res);
				} else {
					res.end();
				}
			} catch (err) {
				res.writeHead(502, { 'Content-Type': 'text/plain' });
				res.end(`Upstream request failed: ${err?.message || err}`);
			}
		});
		return;
	}

	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not found');
});

server.listen(PORT, () => {
	console.log(`OpenVS AI Chat reference auth server listening on http://localhost:${PORT}`);
	console.log(`Sign-in:  set a provider authUrl to http://localhost:${PORT}/login`);
	if (UPSTREAM && UPSTREAM_KEY) {
		console.log(`Proxy:    forwarding /v1 -> ${UPSTREAM} (set baseUrl to http://localhost:${PORT}/v1)`);
		console.log(`          client token required: ${SESSION_TOKEN ? 'yes (SESSION_TOKEN)' : 'no'}`);
	} else {
		console.log(`Proxy:    disabled (set UPSTREAM + UPSTREAM_KEY to enable keyless proxying)`);
	}
});
