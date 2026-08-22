/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/exclusions.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-exclusions.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/exclusions.js', import.meta.url));

const open = { excludeFiles: [], trusted: true, allowUntrusted: false, disabledLanguages: [] };
const at = (relativePath, extra = {}) => ({
	relativePath, scheme: 'file', languageId: 'typescript', cursorLine: 'const a = 1;', ...extra,
});

// Ordinary source in a trusted workspace is allowed.
assert.strictEqual(m.isExcluded(at('src/app.ts'), open), undefined);

// Credential files are denied outright, regardless of user settings.
for (const p of ['.env', '.env.local', 'config/.env.production', 'certs/server.pem',
	'keys/private.key', 'android/app.jks', 'store.p12', '.ssh/id_rsa', '.npmrc', '.pypirc']) {
	assert.strictEqual(m.isExcluded(at(p), open), 'secret-file', `${p} must be denied`);
}
// ...but a file that merely mentions one is fine.
assert.strictEqual(m.isExcluded(at('docs/env-setup.md', { languageId: 'markdown' }), open), undefined);

// A credential on the cursor line is denied even in an allowed file: the window would
// carry it to the provider verbatim.
for (const line of ['const k = "sk-abc123def456";', 'token: ghp_AAAABBBBCCCC',
	'AKIAIOSFODNN7EXAMPLE', 'xoxb-1111-2222-abcd', '-----BEGIN RSA PRIVATE KEY-----']) {
	assert.strictEqual(m.isExcluded(at('src/app.ts', { cursorLine: line }), open), 'secret-line', line);
}
assert.strictEqual(m.isExcluded(at('src/app.ts', { cursorLine: 'const sketch = "ask-me";' }), open), undefined);

// Only real editable documents. The SCM commit box, output panel and debug REPL all
// deliver documents through this API and must never be completed into.
assert.strictEqual(m.isExcluded(at('a.ts', { scheme: 'untitled' }), open), undefined);
assert.strictEqual(m.isExcluded(at('a.ipynb', { scheme: 'vscode-notebook-cell' }), open), undefined);
for (const scheme of ['output', 'vscode-scm', 'debug', 'git', 'search-editor', 'vscode-chat-editing-snapshot-text-model']) {
	assert.strictEqual(m.isExcluded(at('a.ts', { scheme }), open), 'scheme', scheme);
}

// User globs.
assert.strictEqual(m.isExcluded(at('vendor/big.ts'), { ...open, excludeFiles: ['vendor/**'] }), 'user-glob');
assert.strictEqual(m.isExcluded(at('src/gen.g.ts'), { ...open, excludeFiles: ['**/*.g.ts'] }), 'user-glob');
assert.strictEqual(m.isExcluded(at('src/app.ts'), { ...open, excludeFiles: ['vendor/**'] }), undefined);

// Per-language opt-out.
assert.strictEqual(m.isExcluded(at('a.md', { languageId: 'markdown' }),
	{ ...open, disabledLanguages: ['markdown'] }), 'language');

// Untrusted workspaces are off unless explicitly enabled: opening an unfamiliar repo must
// not stream it to a third-party API on every keystroke.
assert.strictEqual(m.isExcluded(at('src/app.ts'), { ...open, trusted: false }), 'untrusted');
assert.strictEqual(m.isExcluded(at('src/app.ts'), { ...open, trusted: false, allowUntrusted: true }), undefined);
// A denied file stays denied even when untrusted mode was allowed.
assert.strictEqual(m.isExcluded(at('.env'), { ...open, trusted: false, allowUntrusted: true }), 'secret-file');

console.log('all assertions passed');
