// Throwaway build-gate: proves the Antigravity OAuth + CloudCode endpoints still work.
// The upstream repo was archived 2026-07-17, so this may 404 / invalid_client — that is the
// whole point of running it before building the provider.
//
// Run (from extensions/openvs-chat):
//   node scripts/antigravity-probe.mjs
// Secret is read from ANTIGRAVITY_CLIENT_SECRET env, else from .secrets/antigravity.txt.
// Approve the Google login in the browser when prompted.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const REDIRECT = 'http://localhost:51121/oauth-callback';
const BASE = 'https://cloudcode-pa.googleapis.com';
const SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
	'https://www.googleapis.com/auth/cclog',
	'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

const here = dirname(fileURLToPath(import.meta.url));
function readSecret() {
	if (process.env.ANTIGRAVITY_CLIENT_SECRET) {
		return process.env.ANTIGRAVITY_CLIENT_SECRET.trim();
	}
	try {
		return readFileSync(join(here, '..', '.secrets', 'antigravity.txt'), 'utf8').trim();
	} catch {
		return '';
	}
}

const SECRET = readSecret();
if (!SECRET || SECRET.startsWith('GOCSPX-REPLACE')) {
	console.error('No client secret. Set ANTIGRAVITY_CLIENT_SECRET or fill .secrets/antigravity.txt');
	process.exit(2);
}

const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());

function waitForCode() {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			const u = new URL(req.url, 'http://localhost:51121');
			if (u.pathname !== '/oauth-callback') { res.writeHead(404).end(); return; }
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<h2>Received. Return to the terminal.</h2>');
			server.close();
			resolve(u.searchParams.get('code'));
		});
		server.listen(51121, '127.0.0.1', () => {
			const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
			url.searchParams.set('client_id', CLIENT_ID);
			url.searchParams.set('redirect_uri', REDIRECT);
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('scope', SCOPES);
			url.searchParams.set('code_challenge', challenge);
			url.searchParams.set('code_challenge_method', 'S256');
			url.searchParams.set('access_type', 'offline');
			url.searchParams.set('prompt', 'consent');
			console.log('\n1) Open this URL in a browser, sign in, approve:\n\n' + url.toString() + '\n\n2) Then wait — the terminal will continue automatically.\n');
		});
	});
}

const code = await waitForCode();
if (!code) { console.error('No authorization code received.'); process.exit(1); }

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		client_id: CLIENT_ID, client_secret: SECRET, code,
		grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: verifier,
	}).toString(),
});
const token = await tokenRes.json().catch(() => ({}));
console.log('[1/3] token exchange:', tokenRes.status);
if (!token.access_token) {
	console.error('FAILED at token exchange. If error is invalid_client, the secret was revoked (repo archived). Body:', JSON.stringify(token).slice(0, 300));
	process.exit(1);
}
const access = token.access_token;

const load = await fetch(`${BASE}/v1internal:loadCodeAssist`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
	body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'WINDOWS', pluginType: 'GEMINI' } }),
});
const loadJson = await load.json().catch(() => ({}));
const project = typeof loadJson.cloudaicompanionProject === 'string'
	? loadJson.cloudaicompanionProject
	: loadJson.cloudaicompanionProject?.id;
console.log('[2/3] loadCodeAssist:', load.status, '| projectId:', project);

const gen = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json', Accept: 'text/event-stream',
		Authorization: `Bearer ${access}`,
		'User-Agent': 'antigravity/1.18.3 windows/amd64',
		'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
	},
	body: JSON.stringify({
		model: 'gemini-3-pro-low',
		project,
		request: { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] },
	}),
});
console.log('[3/3] streamGenerateContent:', gen.status);
const text = await gen.text();
console.log('--- first 800 chars of response body ---\n' + text.slice(0, 800));
console.log('\nGATE:', gen.status === 200 ? 'PASS ✅ backend live — proceed to build' : 'FAIL ❌ backend dead/blocked — stop');
process.exit(gen.status === 200 ? 0 : 1);
