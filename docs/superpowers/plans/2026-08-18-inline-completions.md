# Inline Completions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Copilot-style inline ghost-text completions to `extensions/openvs-chat`, driven by whatever model providers the user already has credentials for.

**Architecture:** A new isolated `src/completions/` module registers a `vscode.InlineCompletionItemProvider` using the `inlineCompletionsAdditions` proposed API. Requests prefer a real fill-in-the-middle endpoint where the backend has one (Mistral Codestral, any OpenAI-compatible `/completions` with `suffix`, which covers Ollama/LM Studio/vLLM) and fall back to a sanitized chat prompt everywhere else. The completion model is resolved independently of the chat model through a new `complete` role on the existing `RoleRouter`.

**Tech Stack:** TypeScript, VS Code extension API (proposed `inlineCompletionsAdditions`), Node `node:assert/strict` test scripts under `extensions/openvs-chat/scripts/`.

**Spec:** `docs/superpowers/specs/2026-08-18-inline-completions-design.md`

## Global Constraints

- **Tabs, not spaces.** PascalCase types, camelCase functions/locals.
- **Copyright header on every new file**, the OpenVS variant used throughout `extensions/openvs-chat`:
  ```
  /*---------------------------------------------------------------------------------------------
   *  Copyright (c) OpenVS. All rights reserved.
   *  Licensed under the MIT License. See License.txt in the project root for license information.
   *--------------------------------------------------------------------------------------------*/
  ```
- **JSDoc on every exported function, interface, and class.**
- **No `any` / `unknown`.** Prefer `export function x()` over `export const x = () =>`.
- **Single quotes** except user-facing localized strings. `async`/`await`, never `.then()`.
- **Non-interference contract (spec §3), enforced in every task:**
  - Completions MUST NOT call `setStreamIdleTimeout` (module-global at `providers/types.ts:475`). Use per-request `ReadSSEOptions.idleMs`.
  - Completions MUST NOT call `ProviderRegistry.setModel` (writes the **chat** model).
  - Completions MUST NOT call `adoptRequestCeiling`.
  - Completions MUST NOT use `rateLimits.fetchOpts()` (bundles `pace`). Use `noteOnlyOpts()` from Task 1.
  - `AUTO_ROLES` stays `['plan','code','review']`.
- **Tests:** standalone `.mjs` under `extensions/openvs-chat/scripts/`, `node:assert/strict`, importing from `../out/`. The runner **auto-discovers** `test-*.mjs` — no registration needed. Each file prints `all assertions passed` on success. Dependencies are injected (optional constructor params defaulting to the real implementation); never stub globals or cast to `any`.
- **Build:** `npx tsc -p extensions/openvs-chat/tsconfig.json` before running tests. `npm run typecheck --prefix extensions/openvs-chat` for the fast no-emit check. `npm run gulp compile-extensions` before declaring done.
- **Never commit secrets.** Scan staged diffs. Test fixtures use obviously-fake values.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/completions/types.ts` | Shared interfaces for the module | 1 |
| `src/providers/types.ts` *(modify)* | `completeFim?`, `fimModelPatterns`, `COMPLETION_FETCH_OPTS` | 1 |
| `src/providers/rateLimits.ts` *(modify)* | `noteOnlyOpts()` | 1 |
| `extensions/openvs-chat/package.json` *(modify)* | Proposal, settings, commands, keybinding | 1, 9 |
| `extensions/openvs-chat/tsconfig.json` *(modify)* | Proposal d.ts include | 1 |
| `src/completions/context.ts` | Document+position → prefix/suffix window, EOL, import header | 2 |
| `src/completions/exclusions.ts` | Secret/glob/scheme/trust denial | 3 |
| `src/completions/sanitize.ts` | Raw model text → ghost text (pure) | 4 |
| `src/completions/prompt.ts` | Chat-fallback prompt builder | 5 |
| `src/providers/openaiCompatible.ts` *(modify)* | `/completions` with `suffix` | 6 |
| `src/providers/mistral.ts` *(modify)* | `/v1/fim/completions` | 6 |
| `src/auto/router.ts` *(modify)* | `RoutedRole`, `complete` role | 7 |
| `src/completions/cache.ts` | Prefix/suffix keyed reuse | 8 |
| `src/completions/health.ts` | p95 latency, slow breaker | 8 |
| `src/completions/scheduler.ts` | Single-flight, quota floor | 8 |
| `src/completions/completionModel.ts` | Resolve provider+model, local probe | 7 |
| `src/completions/inlineProvider.ts` | The provider. Glue only. | 9 |
| `src/completions/statusBar.ts` | State display + toggle | 9 |
| `src/extension.ts` *(modify)* | Registration, lifecycle | 9 |
| `src/completions/stats.ts` | Acceptance rates | 10 |
| `media/main.js`, `src/chatViewProvider.ts` *(modify)* | Settings panel toggle | 11 |

---

### Task 1: Provider capability surface and proposal wiring

Adds the optional FIM capability to the provider contract, the completion-specific fetch
options, and the split rate-limit hook — all additive, all inert until Task 6. Ends with a
build that compiles and behaves identically.

**Files:**
- Modify: `extensions/openvs-chat/package.json`
- Modify: `extensions/openvs-chat/tsconfig.json`
- Modify: `extensions/openvs-chat/src/providers/types.ts`
- Modify: `extensions/openvs-chat/src/providers/rateLimits.ts`
- Create: `extensions/openvs-chat/src/completions/types.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-wire.mjs` (created here, extended in Task 6)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface FimRequest { readonly prefix: string; readonly suffix: string; readonly model: string; readonly apiKey: string; readonly baseUrl: string; readonly maxTokens: number; readonly stop: string[]; readonly signal: AbortSignal; }`
  - `ChatProvider.completeFim?(request: FimRequest): Promise<string>`
  - `ProviderInfo.fimModelPatterns?: string[]`
  - `COMPLETION_FETCH_OPTS: { timeoutMs: number; retries: number }`
  - `RateLimitTracker.noteOnlyOpts(model: string): { onResponse: (response: Response) => void }`
  - `modelSupportsFim(info: ProviderInfo, model: string): boolean`
  - From `completions/types.ts`: `CompletionWindow`, `CompletionOutcome`

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-wire.mjs`:

```js
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the completion transport contract. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-wire.mjs
import assert from 'node:assert/strict';

const types = await import(new URL('../out/providers/types.js', import.meta.url));
const rl = await import(new URL('../out/providers/rateLimits.js', import.meta.url));

// A completion request must not inherit the chat timeout: 150s of waiting for ghost text
// is dead weight, and a retried completion is stale by the time it lands.
assert.deepStrictEqual(types.COMPLETION_FETCH_OPTS, { timeoutMs: 2500, retries: 0 });

// modelSupportsFim: empty/absent patterns mean "no FIM", unlike toolModelPatterns where
// empty means "everything". A provider that says nothing must not be assumed capable.
const none = { fimModelPatterns: [] };
const some = { fimModelPatterns: ['codestral', 'qwen.*coder'] };
assert.strictEqual(types.modelSupportsFim(none, 'codestral-latest'), false);
assert.strictEqual(types.modelSupportsFim({}, 'codestral-latest'), false);
assert.strictEqual(types.modelSupportsFim(some, 'codestral-latest'), true);
assert.strictEqual(types.modelSupportsFim(some, 'Qwen2.5-Coder-7B'), true, 'case-insensitive');
assert.strictEqual(types.modelSupportsFim(some, 'mistral-large-latest'), false);

// noteOnlyOpts records headers but never paces: a completion that sleeps out a refill
// window arrives after the cursor moved. fetchOpts (chat/agent) keeps both halves.
{
	const tracker = new rl.RateLimitTracker();
	const opts = tracker.noteOnlyOpts('m');
	assert.deepStrictEqual(Object.keys(opts), ['onResponse']);
	assert.strictEqual('pace' in opts, false, 'completions must never pace');
	assert.deepStrictEqual(Object.keys(tracker.fetchOpts('m')).sort(), ['onResponse', 'pace'],
		'chat/agent path is unchanged');

	const headers = new Headers({
		'x-ratelimit-limit-tokens': '8000',
		'x-ratelimit-remaining-tokens': '1200',
		'x-ratelimit-reset-tokens': '30s',
	});
	opts.onResponse(new Response(null, { headers }));
	const snap = tracker.get('m');
	assert.strictEqual(snap.limitTokens, 8000);
	assert.strictEqual(snap.remainingTokens, 1200);
}

console.log('all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-wire.mjs
```

Expected: FAIL — `COMPLETION_FETCH_OPTS` is `undefined`.

- [ ] **Step 3: Add the provider contract additions**

In `extensions/openvs-chat/src/providers/types.ts`, beside the existing `STREAM_FETCH_OPTS`:

```ts
/**
 * Fetch options for an inline-completion POST. Deliberately unlike {@link STREAM_FETCH_OPTS}:
 * a completion whose answer arrives after the cursor moved is worthless, so the first-byte
 * window is short and there is no retry — a retried completion is stale by definition, and
 * on backends that meter failed requests (Groq) the retry also costs budget for nothing.
 */
export const COMPLETION_FETCH_OPTS = { timeoutMs: 2500, retries: 0 } as const;

/**
 * Whether `model` can be served by a real fill-in-the-middle endpoint on this provider.
 *
 * Note the inverted default relative to {@link modelSupportsTools}: an empty or absent
 * pattern list means *no* FIM, not "all models". A provider that has not been taught about
 * a FIM endpoint must never be assumed to have one, because the failure is a 404 on the
 * user's typing path rather than a degraded answer.
 */
export function modelSupportsFim(info: Pick<ProviderInfo, 'fimModelPatterns'>, model: string): boolean {
	return (info.fimModelPatterns ?? []).some(pattern => new RegExp(pattern, 'i').test(model));
}
```

Add to `ProviderInfo`:

```ts
	/**
	 * Case-insensitive regex sources marking which models this provider can serve through a
	 * fill-in-the-middle endpoint. Absent or empty means none — see {@link modelSupportsFim}
	 * for why this default is the opposite of {@link ProviderInfo.toolModelPatterns}.
	 */
	readonly fimModelPatterns?: string[];
```

Add to `ChatProvider`:

```ts
	/**
	 * Complete the text between `prefix` and `suffix` using a real fill-in-the-middle
	 * endpoint. Only defined by providers that have one; callers fall back to a chat prompt.
	 * Returns the insertion text alone — no prefix, no suffix, no fences.
	 */
	completeFim?(request: FimRequest): Promise<string>;
```

And the request type, near `ChatRequest`:

```ts
/** One fill-in-the-middle completion request. */
export interface FimRequest {
	/** Text immediately before the cursor. */
	readonly prefix: string;
	/** Text immediately after the cursor. */
	readonly suffix: string;
	readonly model: string;
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly maxTokens: number;
	/** Stop sequences; the caller sets these from the requested completion shape. */
	readonly stop: string[];
	readonly signal: AbortSignal;
}
```

- [ ] **Step 4: Add `noteOnlyOpts` to the tracker**

In `extensions/openvs-chat/src/providers/rateLimits.ts`, inside `RateLimitTracker`, directly
below `fetchOpts`:

```ts
	/**
	 * The recording half of {@link fetchOpts} without the pacing half.
	 *
	 * {@link fetchOpts} deliberately keeps the two together so a caller cannot record under
	 * one model while pacing against another. Inline completions need the split anyway, and
	 * for a reason that does not apply to chat: pacing means "send this later", and a
	 * completion has no later — the cursor will have moved. It skips the request instead.
	 * Readings are still recorded, because a real header beats a stale one for every caller.
	 */
	noteOnlyOpts(model: string): { onResponse: (response: Response) => void } {
		return { onResponse: response => this.note(model, response) };
	}
```

- [ ] **Step 5: Create the completion module's shared types**

Create `extensions/openvs-chat/src/completions/types.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The text around the cursor that a completion request is built from. */
export interface CompletionWindow {
	/** Text before the cursor, already truncated to the configured budget and LF-normalized. */
	readonly prefix: string;
	/** Text after the cursor, same treatment. */
	readonly suffix: string;
	/** The document's language id, e.g. `typescript`. */
	readonly languageId: string;
	/** Workspace-relative path, or the basename when the file is outside every folder. */
	readonly relativePath: string;
	/** The file's leading import/using/include block, when it was cut out of `prefix`. */
	readonly imports: string;
	/** The document's end-of-line sequence, re-applied to the completion before insertion. */
	readonly eol: '\n' | '\r\n';
}

/** Why a completion attempt produced nothing, for the status bar and the log. */
export type CompletionOutcome =
	| 'shown'
	| 'empty'
	| 'cancelled'
	| 'excluded'
	| 'disabled'
	| 'no-model'
	| 'paused-quota'
	| 'paused-slow'
	| 'timeout'
	| 'error';
```

- [ ] **Step 6: Wire the proposed API**

In `extensions/openvs-chat/package.json`, extend `enabledApiProposals`:

```json
  "enabledApiProposals": [
    "findTextInFiles",
    "contribSourceControlInputBoxMenu",
    "inlineCompletionsAdditions"
  ],
```

In `extensions/openvs-chat/tsconfig.json`, add to `include`:

```json
    "../../src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts"
```

- [ ] **Step 7: Compile and run the test**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-wire.mjs
```

Expected: `all assertions passed`.

- [ ] **Step 8: Verify nothing else broke**

```bash
npm run test --prefix extensions/openvs-chat
```

Expected: every pre-existing suite still passes. This is the non-interference check for
Task 1 — `types.ts` and `rateLimits.ts` are shared with chat and Agent.

- [ ] **Step 9: Commit**

```bash
git add extensions/openvs-chat/package.json extensions/openvs-chat/tsconfig.json extensions/openvs-chat/src/providers/types.ts extensions/openvs-chat/src/providers/rateLimits.ts extensions/openvs-chat/src/completions/types.ts extensions/openvs-chat/scripts/test-completion-wire.mjs
git commit -m "feat(completions): add FIM provider capability and completion fetch options"
```

---

### Task 2: Cursor window extraction

Turns a document and a position into the text a request is built from. Pure apart from the
`vscode` types it reads, so it is tested against a hand-rolled document stand-in rather
than a mock.

**Files:**
- Create: `extensions/openvs-chat/src/completions/context.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-context.mjs`

**Interfaces:**
- Consumes: `CompletionWindow` (Task 1).
- Produces: `buildWindow(doc: WindowDocument, offset: number, limits: WindowLimits): CompletionWindow`, `interface WindowDocument`, `interface WindowLimits`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-context.mjs`:

```js
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/context.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-context.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/context.js', import.meta.url));

const limits = { prefixChars: 20, suffixChars: 10, importChars: 200 };
const doc = (text, extra = {}) => ({
	text, languageId: 'typescript', relativePath: 'src/a.ts', eol: '\n', ...extra,
});

// Basic split at the cursor offset.
{
	const w = m.buildWindow(doc('const a = 1;\nconst b = '), 24, limits);
	assert.strictEqual(w.suffix, '');
	assert.ok(w.prefix.endsWith('const b = '));
	assert.strictEqual(w.languageId, 'typescript');
	assert.strictEqual(w.relativePath, 'src/a.ts');
}

// Windows are truncated from the near side: the characters closest to the cursor are the
// ones that matter, so prefix keeps its tail and suffix keeps its head.
{
	const w = m.buildWindow(doc('0123456789abcdefghijklmnopqrstuvwxyz'), 30, limits);
	assert.strictEqual(w.prefix.length, 20);
	assert.strictEqual(w.prefix, 'abcdefghijklmnopqrst', 'prefix keeps the 20 chars before the cursor');
	assert.strictEqual(w.suffix, 'uvwxyz', 'suffix is shorter than its cap here');
}

// File boundaries are not an error.
{
	assert.strictEqual(m.buildWindow(doc('abc'), 0, limits).prefix, '');
	assert.strictEqual(m.buildWindow(doc('abc'), 3, limits).suffix, '');
}

// CRLF: the window is normalized to LF so the overlap arithmetic in sanitize.ts is not
// thrown off by a stray \r, but the document's real EOL is carried for re-application.
{
	const w = m.buildWindow(doc('let x = 1;\r\nlet y = 2;\r\n', { eol: '\r\n' }), 24, limits);
	assert.strictEqual(w.eol, '\r\n');
	assert.ok(!w.prefix.includes('\r'), 'window is LF-normalized');
}

// The import block is extracted so it can be re-attached even when the cursor is far past
// it and the prefix window has slid off the top of the file.
{
	const text = 'import { readFile } from "fs";\nimport path from "path";\n\n' + 'x\n'.repeat(400) + 'const q = ';
	const w = m.buildWindow(doc(text), text.length, { prefixChars: 40, suffixChars: 10, importChars: 200 });
	assert.ok(w.imports.includes('import { readFile } from "fs";'));
	assert.ok(w.imports.includes('import path from "path";'));
	assert.ok(!w.prefix.includes('import'), 'the prefix window has slid past the imports');
}

// A file with no import block yields an empty string, not undefined.
assert.strictEqual(m.buildWindow(doc('const a = 1;'), 12, limits).imports, '');

// applyEol converts back on the way out, and leaves an LF document alone.
assert.strictEqual(m.applyEol('a\nb', '\r\n'), 'a\r\nb');
assert.strictEqual(m.applyEol('a\nb', '\n'), 'a\nb');

console.log('all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-context.mjs
```

Expected: FAIL — cannot find module `../out/completions/context.js`.

- [ ] **Step 3: Write the implementation**

Create `extensions/openvs-chat/src/completions/context.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionWindow } from './types';

/**
 * The parts of a text document this module needs. Declared structurally rather than taken
 * as a `vscode.TextDocument` so the windowing logic can be tested without an editor.
 */
export interface WindowDocument {
	readonly text: string;
	readonly languageId: string;
	readonly relativePath: string;
	readonly eol: '\n' | '\r\n';
}

/** Character budgets for the pieces of a {@link CompletionWindow}. */
export interface WindowLimits {
	readonly prefixChars: number;
	readonly suffixChars: number;
	/** Cap on the extracted import block, so a generated file's 500-line header can't dominate. */
	readonly importChars: number;
}

/** Line starts that count as part of a file's leading import block, across common languages. */
const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|#include\b|using\b|require\b|const\s+\{?[\w,\s}]*\}?\s*=\s*require\(|package\b|use\s+\S+;)/;

/**
 * Extracts the text around `offset` that a completion request is built from.
 *
 * Both windows are truncated from the far side: the characters nearest the cursor are the
 * ones that determine the completion, so the prefix keeps its tail and the suffix its head.
 * Everything is normalized to LF — the overlap arithmetic in `sanitize.ts` compares model
 * output against these strings, and a stray `\r` on one side of that comparison silently
 * defeats it. The document's real EOL travels on the window so {@link applyEol} can put it
 * back before the text is inserted.
 */
export function buildWindow(doc: WindowDocument, offset: number, limits: WindowLimits): CompletionWindow {
	const text = doc.text.replace(/\r\n/g, '\n');
	// The offset was measured against the original text; \r removal shifts it left by one
	// per preceding CRLF, so recompute it rather than trusting the caller's number.
	const removed = countCrLf(doc.text.slice(0, offset));
	const cursor = Math.max(0, Math.min(text.length, offset - removed));
	const before = text.slice(0, cursor);
	const after = text.slice(cursor);
	return {
		prefix: before.slice(-limits.prefixChars),
		suffix: after.slice(0, limits.suffixChars),
		languageId: doc.languageId,
		relativePath: doc.relativePath,
		imports: extractImports(text, limits.importChars),
		eol: doc.eol,
	};
}

/** How many CRLF pairs occur in `text`. */
function countCrLf(text: string): number {
	let count = 0;
	for (let i = text.indexOf('\r\n'); i !== -1; i = text.indexOf('\r\n', i + 2)) {
		count++;
	}
	return count;
}

/**
 * The file's leading import block, capped at `maxChars`.
 *
 * Sent separately from the prefix because in any file longer than the prefix budget the
 * window has slid past the top, and without the imports the model invents library names
 * instead of using the ones the file actually pulls in. Scanning stops at the first
 * non-blank, non-import line so a file body is never swept up.
 */
function extractImports(text: string, maxChars: number): string {
	const kept: string[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim() || line.trimStart().startsWith('//')) {
			continue;
		}
		if (!IMPORT_LINE.test(line)) {
			break;
		}
		kept.push(line);
	}
	return kept.join('\n').slice(0, maxChars);
}

/** Re-applies a document's end-of-line sequence to LF-normalized text before insertion. */
export function applyEol(text: string, eol: '\n' | '\r\n'): string {
	return eol === '\n' ? text : text.replace(/\n/g, '\r\n');
}
```

- [ ] **Step 4: Compile and run the test**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-context.mjs
```

Expected: `all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/completions/context.ts extensions/openvs-chat/scripts/test-completion-context.mjs
git commit -m "feat(completions): extract cursor window with CRLF and import handling"
```

---

### Task 3: Exclusions — secrets, globs, schemes, trust

The guard that decides whether a request may be built at all. Completions transmit file
content on every typing pause, so without this the feature is a continuous exfiltration
channel. Written before anything can make a network call.

**Files:**
- Create: `extensions/openvs-chat/src/completions/exclusions.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-exclusions.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `isExcluded(target: ExclusionTarget, settings: ExclusionSettings): ExclusionReason | undefined`, `interface ExclusionTarget`, `interface ExclusionSettings`, `type ExclusionReason`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-exclusions.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-exclusions.mjs
```

Expected: FAIL — cannot find module `../out/completions/exclusions.js`.

- [ ] **Step 3: Write the implementation**

Create `extensions/openvs-chat/src/completions/exclusions.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Why a document or position is not eligible for a completion request. */
export type ExclusionReason =
	| 'secret-file'
	| 'secret-line'
	| 'scheme'
	| 'user-glob'
	| 'language'
	| 'untrusted';

/** The document and position facts the guard needs. */
export interface ExclusionTarget {
	/** Workspace-relative path, forward slashes. */
	readonly relativePath: string;
	readonly scheme: string;
	readonly languageId: string;
	/** The full text of the line the cursor is on. */
	readonly cursorLine: string;
}

/** User configuration the guard consults. */
export interface ExclusionSettings {
	readonly excludeFiles: string[];
	readonly trusted: boolean;
	readonly allowUntrusted: boolean;
	readonly disabledLanguages: string[];
}

/**
 * Document schemes a completion may be offered in. An allowlist rather than a denylist:
 * VS Code delivers the SCM commit box, the output panel, the debug REPL, diff sides and
 * search editors through the same provider API, and a new one can appear in any release.
 */
const ALLOWED_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell']);

/**
 * Paths that may hold credentials. Denied before any content is read, and not overridable
 * from settings — a user who wants completions inside their private key has made a mistake,
 * not a configuration choice.
 */
const SECRET_PATHS: RegExp[] = [
	/(^|\/)\.env($|\.)/i,
	/\.(pem|key|jks|p12|pfx|keystore)$/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/(^|\/)\.(npmrc|pypirc|netrc|pgpass)$/i,
	/(^|\/)credentials(\.json)?$/i,
	/(^|\/)service-account.*\.json$/i,
];

/**
 * Credential shapes that must never leave the machine inside a completion window.
 *
 * Checked against the cursor line rather than the whole window on purpose: this is a
 * last-resort guard for a secret pasted into otherwise ordinary source, and scanning a 3 kB
 * window on every keystroke would cost more than it saves. The file-level rules above are
 * what catch a file that is *made* of secrets.
 */
const SECRET_LINE: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{10,}/,
	/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/**
 * Whether a completion may be requested here, and if not, why.
 *
 * Order matters. The secret rules run first and are not overridable, because every other
 * rule is a preference and this one is a leak. Trust is checked after them so that enabling
 * `completions.untrusted` never re-admits a credential file.
 */
export function isExcluded(target: ExclusionTarget, settings: ExclusionSettings): ExclusionReason | undefined {
	if (SECRET_PATHS.some(pattern => pattern.test(target.relativePath))) {
		return 'secret-file';
	}
	if (SECRET_LINE.some(pattern => pattern.test(target.cursorLine))) {
		return 'secret-line';
	}
	if (!ALLOWED_SCHEMES.has(target.scheme)) {
		return 'scheme';
	}
	if (!settings.trusted && !settings.allowUntrusted) {
		return 'untrusted';
	}
	if (settings.disabledLanguages.includes(target.languageId)) {
		return 'language';
	}
	if (settings.excludeFiles.some(glob => globToRegExp(glob).test(target.relativePath))) {
		return 'user-glob';
	}
	return undefined;
}

/**
 * Compiles a simple glob to a regex, one character at a time.
 *
 * A double star spans path separators, a single star does not, and `?` is one
 * non-separator character. A double star followed by a separator also matches zero
 * segments, so a pattern anchored two directories deep still matches a file one deep.
 * Written as a single pass rather than a chain of `.replace()` calls with placeholder sentinels: the
 * sentinel version is only correct while no pattern can contain a sentinel, which is the
 * kind of assumption that holds until it does not.
 *
 * Deliberately small — the editor's own matcher is not reachable from a pure module, and
 * these patterns are evaluated on the typing path.
 */
function globToRegExp(glob: string): RegExp {
	let body = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*' && glob[i + 1] === '*') {
			if (glob[i + 2] === '/') {
				body += '(?:.*/)?';
				i += 2;
			} else {
				body += '.*';
				i += 1;
			}
			continue;
		}
		if (ch === '*') {
			body += '[^/]*';
			continue;
		}
		if (ch === '?') {
			body += '[^/]';
			continue;
		}
		body += ESCAPE_IN_GLOB.test(ch) ? `\\${ch}` : ch;
	}
	return new RegExp(`^${body}$`);
}

/** Regex metacharacters that must be escaped when they appear literally in a glob. */
const ESCAPE_IN_GLOB = /[.+^${}()|[\]\\]/;
```

- [ ] **Step 4: Compile and run the test**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-exclusions.mjs
```

Expected: `all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/completions/exclusions.ts extensions/openvs-chat/scripts/test-completion-exclusions.mjs
git commit -m "feat(completions): deny completions in credential files and non-editor schemes"
```

---

### Task 4: Sanitizer

The load-bearing component of the chat fallback. Chat models return fenced markdown, prose
preambles, a restated prefix and a duplicated suffix; this turns that into ghost text or
into nothing. Entirely pure.

**Files:**
- Create: `extensions/openvs-chat/src/completions/sanitize.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-sanitize.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `sanitizeCompletion(raw: string, window: SanitizeWindow, limits: SanitizeLimits): string`, `interface SanitizeWindow`, `interface SanitizeLimits`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-sanitize.mjs`:

```js
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/sanitize.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-sanitize.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/sanitize.js', import.meta.url));

const limits = { maxLines: 6 };
const w = (prefix, suffix = '') => ({ prefix, suffix });

// One table, one snapshot — each row is a failure class a real model produced.
const cases = [
	['plain continuation passes through',
		'sum += n;', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['fenced block is unwrapped',
		'```ts\nsum += n;\n```', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['prose preamble around a fence is dropped',
		'Here is the completion:\n```ts\nsum += n;\n```\nHope that helps!',
		w('for (const n of xs) {\n\t'), 'sum += n;'],

	['prose with no fence and no continuation yields nothing',
		'Sure! I can help you complete this loop.', w('for (const n of xs) {\n\t'), ''],

	['restated prefix is removed',
		'for (const n of xs) {\n\tsum += n;', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['restated suffix is removed so brackets are not doubled',
		'sum += n;\n}', w('for (const n of xs) {\n\t', '\n}'), 'sum += n;'],

	['runaway output is capped at maxLines',
		Array.from({ length: 20 }, (_, i) => `line${i};`).join('\n'), w('function f() {\n\t'),
		Array.from({ length: 6 }, (_, i) => `line${i};`).join('\n')],

	['output is cut where the block exits',
		'sum += n;\n\t}\n\treturn sum;\n}\n\nfunction other() {}',
		w('function f() {\n\tfor (const n of xs) {\n\t\t'), 'sum += n;'],

	['a completion equal to text already present is discarded',
		'sum += n;', w('for (const n of xs) {\n\tsum += n;'), ''],

	['inline thinking is stripped',
		'<think>They want the accumulator.</think>sum += n;', w('for (const n of xs) {\n\t'), 'sum += n;'],

	['whitespace-only output is nothing',
		'   \n  \n', w('const a = '), ''],

	['leading newline is preserved when the model opens a new line',
		'\n\treturn sum;', w('function f() {\n\tlet sum = 0;'), '\n\treturn sum;'],
];

assert.deepStrictEqual(
	cases.map(([name, raw, win]) => [name, m.sanitizeCompletion(raw, win, limits)]),
	cases.map(([name, , , expected]) => [name, expected]),
);

console.log('all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-sanitize.mjs
```

Expected: FAIL — cannot find module `../out/completions/sanitize.js`.

- [ ] **Step 3: Write the implementation**

Create `extensions/openvs-chat/src/completions/sanitize.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The cursor context a completion is judged against. LF-normalized (see `context.ts`). */
export interface SanitizeWindow {
	readonly prefix: string;
	readonly suffix: string;
}

/** Shape limits applied to a completion. */
export interface SanitizeLimits {
	/** Hard cap on returned lines. Automatic requests use a small value; explicit ones more. */
	readonly maxLines: number;
}

/**
 * Turns a model's raw reply into insertable ghost text, or into an empty string when there
 * is nothing usable in it.
 *
 * This exists because none of the backends here are completion models. Asked to continue
 * code, a chat model returns a fenced block, a sentence introducing the block, the prefix it
 * was given, and the suffix it was given — often all four. Each rule below corresponds to a
 * failure actually observed from the free-tier models this extension targets, and they run
 * in a fixed order because later rules assume earlier ones have already fired.
 */
export function sanitizeCompletion(raw: string, window: SanitizeWindow, limits: SanitizeLimits): string {
	let text = stripThinking(raw);
	text = unwrapFence(text, window);
	text = stripRestatedPrefix(text, window.prefix);
	text = stripRestatedSuffix(text, window.suffix);
	text = capLines(text, limits.maxLines);
	text = cutAtBlockExit(text, window.prefix);
	if (!text.trim()) {
		return '';
	}
	// A suggestion identical to what is already there is not a suggestion.
	if (window.suffix.startsWith(text)) {
		return '';
	}
	return text;
}

/** Removes an inline reasoning block. `reasoning_content` is dropped at the provider layer;
 *  this catches models that write the same thing into ordinary content instead. */
function stripThinking(text: string): string {
	return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

/**
 * Keeps only the code when the model wrapped its answer in a fence, and drops leading prose
 * when it did not.
 *
 * When a fence is present it is unambiguous: everything outside it is commentary. Without
 * one, a line is treated as prose if it reads as a sentence and does not continue the
 * prefix's own indentation or syntax — the conservative reading, since returning prose as
 * ghost text is far worse than returning nothing.
 */
function unwrapFence(text: string, window: SanitizeWindow): string {
	const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/.exec(text);
	if (fence) {
		return trimTrailingNewline(fence[1]);
	}
	if (!/^\s*(here|sure|certainly|of course|okay|ok\b|this |the |i )/i.test(text)) {
		return text;
	}
	// Prose with no fence: keep only from the first line that plausibly is code.
	const lines = text.split('\n');
	const start = lines.findIndex(line => looksLikeCode(line, window.prefix));
	return start === -1 ? '' : lines.slice(start).join('\n');
}

/** Whether a line reads as code rather than as a sentence about code. */
function looksLikeCode(line: string, prefix: string): boolean {
	if (!line.trim()) {
		return false;
	}
	if (/[{};()=<>[\]]/.test(line)) {
		return true;
	}
	// An indented line inside an indented context is probably a continuation.
	const indent = /\n([ \t]*)$/.exec(prefix)?.[1] ?? '';
	return indent.length > 0 && line.startsWith(indent);
}

/**
 * Drops a restated prefix. Models frequently echo the code they were given before adding
 * to it; inserted verbatim that duplicates whatever is already on screen. The longest
 * suffix of the prefix that the output opens with is the overlap to remove.
 */
function stripRestatedPrefix(text: string, prefix: string): string {
	const max = Math.min(prefix.length, text.length);
	for (let n = max; n > 0; n--) {
		if (text.startsWith(prefix.slice(-n))) {
			return text.slice(n);
		}
	}
	return text;
}

/**
 * Drops a restated suffix, which is what produces doubled closing brackets: the model
 * closes the block the editor has already closed below the cursor.
 */
function stripRestatedSuffix(text: string, suffix: string): string {
	if (!suffix) {
		return text;
	}
	const max = Math.min(suffix.length, text.length);
	for (let n = max; n > 0; n--) {
		if (text.endsWith(suffix.slice(0, n))) {
			return text.slice(0, text.length - n);
		}
	}
	return text;
}

/** Hard cap on length. A model asked for one line will sometimes write a module. */
function capLines(text: string, maxLines: number): string {
	const lines = text.split('\n');
	return lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n');
}

/**
 * Stops the completion where it leaves the block the cursor is in.
 *
 * A model given a cursor inside a function will sometimes finish the function, close it,
 * and start the next one. The signal for that is a line that both dedents *and* opens with
 * a closing bracket — dedent alone is not enough: a weaker free-tier model that skips
 * indentation entirely produces flat, unindented multi-line output that looks identical to
 * a block exit on line two under a pure indent comparison, and truncating that down to one
 * line is a far worse failure than leaving a few extra lines for `capLines` to bound.
 */
function cutAtBlockExit(text: string, prefix: string): string {
	const indent = /(?:^|\n)([ \t]*)[^\n]*$/.exec(prefix)?.[1] ?? '';
	if (!indent) {
		return text;
	}
	const lines = text.split('\n');
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			continue;
		}
		const lineIndent = /^[ \t]*/.exec(line)?.[0] ?? '';
		const closesBlock = /^[ \t]*[}\)\]]/.test(line);
		if (lineIndent.length < indent.length && closesBlock) {
			return lines.slice(0, i).join('\n').replace(/\s+$/, '');
		}
	}
	return text;
}

/** Removes a single trailing newline left by a fence's closing line. */
function trimTrailingNewline(text: string): string {
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}
```

- [ ] **Step 4: Compile and run the test**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-sanitize.mjs
```

Expected: `all assertions passed`. If a row fails, fix the rule rather than the expectation
— each row is a real observed model output.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/completions/sanitize.ts extensions/openvs-chat/scripts/test-completion-sanitize.mjs
git commit -m "feat(completions): sanitize chat-model output into insertable ghost text"
```

---

### Task 5: Chat-fallback prompt

The prompt used on backends with no FIM endpoint. Small, but it is what decides how much
work the sanitizer has to do, so it is tested for shape.

**Files:**
- Create: `extensions/openvs-chat/src/completions/prompt.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-prompt.mjs`

**Interfaces:**
- Consumes: `CompletionWindow` (Task 1).
- Produces: `buildChatPrompt(window: CompletionWindow): ChatMessage[]`, `COMPLETION_STOP: string[]`, `FIM_STOP: string[]`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-prompt.mjs`:

```js
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/prompt.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-prompt.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/prompt.js', import.meta.url));

const window = {
	prefix: 'function add(a, b) {\n\t',
	suffix: '\n}\n',
	languageId: 'javascript',
	relativePath: 'src/math.js',
	imports: 'import assert from "assert";',
	eol: '\n',
};

const msgs = m.buildChatPrompt(window);

// Exactly two turns: a system instruction and the cursor context. No conversation history
// belongs here — a completion is stateless and every extra token is paid per keystroke.
assert.strictEqual(msgs.length, 2);
assert.strictEqual(msgs[0].role, 'system');
assert.strictEqual(msgs[1].role, 'user');

// The instruction must forbid the exact artifacts sanitize.ts otherwise has to repair.
const system = msgs[0].content.toLowerCase();
for (const rule of ['no explanation', 'no markdown', 'do not repeat']) {
	assert.ok(system.includes(rule), `system prompt must state: ${rule}`);
}

// The user turn carries language, path, imports, and the split around the cursor.
const user = msgs[1].content;
assert.ok(user.includes('javascript'));
assert.ok(user.includes('src/math.js'));
assert.ok(user.includes('import assert from "assert";'));
assert.ok(user.includes(window.prefix));
assert.ok(user.includes(window.suffix));

// An empty import block must not leave a dangling empty section.
const bare = m.buildChatPrompt({ ...window, imports: '' });
assert.ok(!/imports:\s*\n\s*\n/i.test(bare[1].content));

// Stop sequences cut the two runaway shapes: a new fence and a paragraph break.
assert.deepStrictEqual(m.COMPLETION_STOP, ['```', '\n\n\n']);

// FIM gets its own, shorter stop: a real FIM endpoint never emits a fence (it isn't a chat
// model), and a triple newline is far too loose a bound for a ~96-token completion. Reusing
// COMPLETION_STOP on the FIM path — which an earlier draft of this plan did — leaves an
// inert stop token and one that is too permissive to matter.
assert.deepStrictEqual(m.FIM_STOP, ['\n\n']);

console.log('all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-prompt.mjs
```

Expected: FAIL — cannot find module `../out/completions/prompt.js`.

- [ ] **Step 3: Write the implementation**

Create `extensions/openvs-chat/src/completions/prompt.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '../providers/types';
import { CompletionWindow } from './types';

/**
 * Stop sequences for the chat fallback. A fence marks the model starting to explain itself;
 * a triple newline marks it having finished the code and moved on to prose.
 */
export const COMPLETION_STOP: string[] = ['```', '\n\n\n'];

/**
 * Stop sequences for a real fill-in-the-middle request. Deliberately not
 * {@link COMPLETION_STOP}: a FIM endpoint is not a chat model, so it never emits a fence —
 * that stop token would simply never fire — and a triple newline is far looser than a
 * ~96-token completion needs. A single blank line is the right bound here.
 */
export const FIM_STOP: string[] = ['\n\n'];

/**
 * Instruction for the chat fallback path.
 *
 * Every prohibition here maps to a repair rule in `sanitize.ts`. Stating them does not make
 * the sanitizer optional — weaker free-tier models ignore the instruction routinely — but it
 * measurably reduces how often the repair is needed, and repair is lossy.
 */
const SYSTEM = [
	'You are a code completion engine. Continue the code at the cursor.',
	'Output only the text to insert. No explanation, no commentary, no markdown, no code fences.',
	'Do not repeat any code that appears before or after the cursor.',
	'Complete the current statement or block only. Stop as soon as it is finished.',
].join(' ');

/**
 * Builds the two-turn prompt for a completion on a backend with no fill-in-the-middle
 * endpoint. Stateless by design: no conversation history, no rules block, no skills. An
 * agent step can afford a large prompt because it runs a handful of times; this runs once
 * per typing pause, and everything in it is paid for again each time.
 */
export function buildChatPrompt(window: CompletionWindow): ChatMessage[] {
	const parts = [
		`Language: ${window.languageId}`,
		`File: ${window.relativePath}`,
	];
	if (window.imports.trim()) {
		parts.push(`Imports in this file:\n${window.imports}`);
	}
	parts.push(
		`Code before the cursor:\n${window.prefix}`,
		`Code after the cursor:\n${window.suffix}`,
		'Insert at the cursor:',
	);
	return [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: parts.join('\n\n') },
	];
}
```

- [ ] **Step 4: Compile and run the test**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-prompt.mjs
```

Expected: `all assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/completions/prompt.ts extensions/openvs-chat/scripts/test-completion-prompt.mjs
git commit -m "feat(completions): add stateless chat-fallback completion prompt"
```

---

### Task 6: Fill-in-the-middle transport

Gives real FIM to the backends that have it. One change to `openaiCompatible.ts` covers
`custom.ts` — Ollama, LM Studio and vLLM all serve the legacy `/completions` shape with a
`suffix` field — which is what makes a local ~100 ms zero-quota completion model possible.

**Files:**
- Modify: `extensions/openvs-chat/src/providers/openaiCompatible.ts`
- Modify: `extensions/openvs-chat/src/providers/mistral.ts`
- Modify: `extensions/openvs-chat/src/providers/custom.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-wire.mjs` (extend from Task 1)

**Interfaces:**
- Consumes: `FimRequest`, `COMPLETION_FETCH_OPTS`, `modelSupportsFim` (Task 1); `RateLimitTracker.noteOnlyOpts` (Task 1).
- Produces: `OpenAICompatibleProvider.completeFim`, `OpenAICompatibleProvider.fimUrl(baseUrl)`, `OpenAICompatibleProvider.fimBody(request)`; `MistralProvider` overrides of both.

- [ ] **Step 1: Write the failing test**

Append to `extensions/openvs-chat/scripts/test-completion-wire.mjs`, before the final
`console.log`:

```js
// --- FIM wire formats -------------------------------------------------------------------
// Pinned the same way test-provider-messages.mjs pins the chat shapes: the request body is
// the contract with the backend, and a silent change to it is a 400 on the typing path.
{
	const { OpenAICompatibleProvider } = await import(new URL('../out/providers/openaiCompatible.js', import.meta.url));
	const { MistralProvider } = await import(new URL('../out/providers/mistral.js', import.meta.url));
	const { CustomProvider } = await import(new URL('../out/providers/custom.js', import.meta.url));

	const req = {
		prefix: 'function add(a, b) {\n\t', suffix: '\n}\n', model: 'codestral-latest',
		apiKey: 'k', baseUrl: 'https://api.example.com/v1', maxTokens: 96,
		stop: ['\n\n'], signal: new AbortController().signal,
	};

	const custom = new CustomProvider();
	assert.strictEqual(custom.fimUrl(req.baseUrl), 'https://api.example.com/v1/completions',
		'OpenAI-compatible FIM is the legacy completions endpoint');
	assert.deepStrictEqual(JSON.parse(custom.fimBody(req)), {
		model: 'codestral-latest',
		prompt: 'function add(a, b) {\n\t',
		suffix: '\n}\n',
		max_tokens: 96,
		temperature: 0.1,
		stream: false,
		stop: ['\n\n'],
	});

	// Mistral serves FIM at its own path; La Plateforme does not expose /completions at all.
	const mistral = new MistralProvider();
	assert.strictEqual(mistral.fimUrl(req.baseUrl), 'https://api.example.com/v1/fim/completions');

	// Capability is opt-in per provider and per model.
	assert.ok(mistral.info.fimModelPatterns.length > 0);
	assert.strictEqual(types.modelSupportsFim(mistral.info, 'codestral-latest'), true);
	assert.strictEqual(types.modelSupportsFim(mistral.info, 'mistral-large-latest'), false,
		'only the coding models do FIM');
	assert.strictEqual(typeof mistral.completeFim, 'function');
	assert.strictEqual(typeof custom.completeFim, 'function');

	// A provider with no FIM endpoint must not inherit one by accident.
	const { AnthropicProvider } = await import(new URL('../out/providers/anthropic.js', import.meta.url));
	assert.strictEqual(new AnthropicProvider().completeFim, undefined,
		'Anthropic has no FIM endpoint and must fall back to the chat path');
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-wire.mjs
```

Expected: FAIL — `custom.fimUrl is not a function`.

- [ ] **Step 3: Implement FIM on the OpenAI-compatible base class**

In `extensions/openvs-chat/src/providers/openaiCompatible.ts`, add to the class, importing
`COMPLETION_FETCH_OPTS`, `FimRequest` and `modelSupportsFim` from `./types`:

```ts
	/**
	 * Where this backend serves fill-in-the-middle. The OpenAI-compatible default is the
	 * legacy `/completions` endpoint, which takes a `suffix` alongside `prompt` — that is
	 * what Ollama, LM Studio and vLLM all expose, so the local runners come free with this.
	 */
	protected fimUrl(baseUrl: string): string {
		return this.url(baseUrl, '/completions');
	}

	/** The request body for {@link fimUrl}. Non-streaming: a 96-token reply is one chunk. */
	protected fimBody(request: FimRequest): string {
		return JSON.stringify({
			model: request.model,
			prompt: request.prefix,
			suffix: request.suffix,
			max_tokens: request.maxTokens,
			// Near-greedy. A completion is a prediction of what the user was about to type,
			// not a creative act; sampling variance here reads to the user as flakiness.
			temperature: 0.1,
			stream: false,
			stop: request.stop,
		});
	}

	/**
	 * Complete between prefix and suffix using this backend's FIM endpoint.
	 *
	 * Uses {@link COMPLETION_FETCH_OPTS} rather than the streaming options, and
	 * `noteOnlyOpts` rather than `fetchOpts` — a completion records what the headers say but
	 * never sleeps waiting for a window, because by the time the window refills the cursor
	 * has moved. See the non-interference contract in the design spec.
	 */
	async completeFim(request: FimRequest): Promise<string> {
		if (!modelSupportsFim(this.info, request.model)) {
			throw new Error(`${this.info.label} has no FIM endpoint for ${request.model}`);
		}
		const response = await apiFetch(
			this.fimUrl(request.baseUrl),
			{ method: 'POST', headers: this.authHeaders(request.apiKey), body: this.fimBody(request) },
			request.signal,
			{ ...COMPLETION_FETCH_OPTS, ...this.rateLimits.noteOnlyOpts(request.model) },
		);
		const json = await response.json() as { choices?: { text?: string; message?: { content?: string } }[] };
		const choice = json.choices?.[0];
		return choice?.text ?? choice?.message?.content ?? '';
	}
```

- [ ] **Step 4: Point Mistral at its own FIM path**

In `extensions/openvs-chat/src/providers/mistral.ts`, add to `info`:

```ts
		// Codestral is the only Mistral family served by the FIM endpoint; the instruct
		// models reject it. Devstral is listed because the catalog serves it under both
		// names depending on tier.
		fimModelPatterns: ['codestral', 'devstral'],
```

and add the override:

```ts
	/**
	 * Mistral serves fill-in-the-middle at its own path rather than the legacy
	 * `/completions` endpoint, which La Plateforme does not expose at all.
	 */
	protected override fimUrl(baseUrl: string): string {
		return this.url(baseUrl, '/fim/completions');
	}
```

- [ ] **Step 5: Declare FIM capability on the local provider**

In `extensions/openvs-chat/src/providers/custom.ts`, add to `info`:

```ts
		// Local runners serve the legacy completions endpoint with `suffix`, so any model
		// whose name marks it as FIM-trained can use it. Named rather than left open,
		// because a non-FIM model on that endpoint continues the prompt with no awareness
		// of the suffix at all, which is worse than offering no completion.
		fimModelPatterns: ['coder', 'codellama', 'starcoder', 'codegemma', 'codestral', 'deepseek-coder', 'stable-code'],
```

- [ ] **Step 6: Compile and run the test**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-wire.mjs
```

Expected: `all assertions passed`.

- [ ] **Step 7: Verify chat and Agent are untouched**

```bash
npm run test --prefix extensions/openvs-chat
```

Expected: all suites pass, `test-provider-messages.mjs` included — it pins the chat wire
formats this task must not have disturbed.

- [ ] **Step 8: Commit**

```bash
git add extensions/openvs-chat/src/providers/openaiCompatible.ts extensions/openvs-chat/src/providers/mistral.ts extensions/openvs-chat/src/providers/custom.ts extensions/openvs-chat/scripts/test-completion-wire.mjs
git commit -m "feat(completions): add fill-in-the-middle transport for compatible backends"
```

---

### Task 7: Completion model routing

Adds the `complete` role to the existing router. Three of its rules are the inverse of what
the Auto roles want, which is the whole reason it cannot simply reuse `code`.

**Files:**
- Modify: `extensions/openvs-chat/src/auto/router.ts`
- Create: `extensions/openvs-chat/src/completions/completionModel.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-router.mjs`

**Interfaces:**
- Consumes: `RoleRouter`, `AutoRole`, `AUTO_ROLES`, `LIGHTWEIGHT`, `NOT_AUTO_SELECTED_MODELS`, `NOT_AUTO_INFERRED` (existing); `ProviderRegistry` (existing); `modelSupportsFim` (Task 1).
- Produces: `type RoutedRole = AutoRole | 'complete'`; `isCompletionExcluded(model): boolean`; `roleSettingKey(role): string`; `scoreForRole(role, model, isUserChoice, index): number`; `CompletionModelResolver` with `resolve(): Promise<ResolvedCompletionModel | undefined>` and `interface ResolvedCompletionModel { providerId: string; model: string; usesFim: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-router.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-router.mjs
```

Expected: FAIL — `m.isCompletionExcluded is not a function`.

- [ ] **Step 3: Widen the role type and add the tables**

In `extensions/openvs-chat/src/auto/router.ts`:

```ts
/**
 * Roles the router can resolve. {@link AutoRole} is the Auto *pipeline*'s set and must stay
 * as it is — {@link AUTO_ROLES} drives `resolveAll()` and the Auto settings rows, so adding
 * a member there would put a completion entry in both. `complete` is resolved on its own.
 */
export type RoutedRole = AutoRole | 'complete';
```

Widen `ROLE_LABELS`, `ROLE_SETTING` and `ROLE_AFFINITY` to `Record<RoutedRole, …>` and add:

```ts
// in ROLE_LABELS
	complete: 'Inline Completions',

// in ROLE_SETTING — one `provider:model` string, exactly like the Auto roles
	complete: 'completions.model',

// in ROLE_AFFINITY — deliberately NOT a copy of `code`, which matches deepseek/-r1/think
// and 70b/120b: every one of those is wrong for a model that must answer in under a second.
// Also deliberately excludes small/fast marketing terms (instant, flash, mini, a bare
// single-digit-b size) that LIGHTWEIGHT already matches: for the complete role LIGHTWEIGHT
// is a +2 bonus of its own via LIGHTWEIGHT_WEIGHT below; folding those terms in here as well
// would let a model win purely for sounding fast (llama-3.1-8b-instant) over one that is
// genuinely coder/FIM-specific (codestral-latest) but doesn't happen to have a fast-sounding
// name — the two signals must stay independent, not double-counted.
	complete: [/codestral|devstral|coder|-code|starcoder|codegemma|ministral/i],
```

Add the exclusion table and the two exported helpers:

```ts
/**
 * Models never used for inline completion, however capable.
 *
 * Reasoning models emit their thinking before any code, which for a completion means
 * seconds of latency and then a suggestion for a cursor position that no longer exists.
 * The {@link NOT_AUTO_SELECTED_MODELS} set is folded in for its own reason as well: this
 * endpoint fires on every typing pause, making it the worst possible place to spend a
 * user's credits without being asked.
 */
const NOT_COMPLETION_MODELS: RegExp[] = [
	/-?r1\b/i, /think/i, /qwq/i, /\bo[1-9]\b/i, /reason/i, ...NOT_AUTO_SELECTED_MODELS,
];

/** Whether `model` is barred from serving inline completions. See {@link NOT_COMPLETION_MODELS}. */
export function isCompletionExcluded(model: string): boolean {
	return NOT_COMPLETION_MODELS.some(pattern => pattern.test(model));
}

/** The settings key holding a role's `provider:model` pin. */
export function roleSettingKey(role: RoutedRole): string {
	return ROLE_SETTING[role];
}
```

- [ ] **Step 4: Invert the lightweight penalty for this role**

Rename the existing private `score` to an exported
`scoreForRole(role: RoutedRole, model: string, isUserChoice: boolean, index: number): number`,
keep every existing branch unchanged, and replace the `LIGHTWEIGHT` penalty with:

```ts
	// For the Auto roles a small checkpoint ranks below its larger sibling. For completion
	// the trade reverses: latency is the dominant quality term, because a suggestion that
	// arrives after the cursor moved scores zero no matter how good it is.
	const lightweight = LIGHTWEIGHT.test(model);
	if (role === 'complete') {
		score += lightweight ? LIGHTWEIGHT_WEIGHT : 0;
	} else if (lightweight) {
		score -= LIGHTWEIGHT_WEIGHT;
	}
```

Update the call site in `resolveRoleCandidates` to `scoreForRole`. Extract the existing
magic number used for the lightweight adjustment into `LIGHTWEIGHT_WEIGHT` so both branches
use one value.

- [ ] **Step 5: Allow the local provider into this role's pool**

`resolveRoleCandidates` and `resolveRole` both gain a trailing optional parameter,
`localReachable = false`. Every existing call site — `resolveAll`, the orchestrator, the
settings panel, and this task's own test asserting `AUTO_ROLES` — calls with 3 arguments and
is completely unaffected: `custom` stays excluded for those roles exactly as it is today.
Only a caller that explicitly passes `true` (the completion resolver, once it has confirmed
the local endpoint answers — see Step 6) admits it, and only for `role === 'complete'`.

Replace the flat `NOT_AUTO_INFERRED` test with a role-aware one, and drop any candidate
excluded by `isCompletionExcluded`:

```ts
	/**
	 * Which providers may be inferred for `role`.
	 *
	 * `custom` is kept out of the Auto roles because a local endpoint may not be running.
	 * For completion that reasoning inverts: a local FIM model answers in ~100 ms and costs
	 * no quota, which makes it the best backend available — and unlike the Auto case the
	 * premise is cheaply testable, so it is admitted when a reachability probe succeeds.
	 * `antigravity` stays out of every role.
	 */
	private inferable(role: RoutedRole, providerId: string, localReachable: boolean): boolean {
		if (providerId === 'antigravity') {
			return false;
		}
		if (providerId === 'custom') {
			return role === 'complete' && localReachable;
		}
		return !NOT_AUTO_INFERRED.has(providerId);
	}
```

Thread the new parameter through both public methods to `inferable`'s call site — the
signatures become `async resolveRoleCandidates(role: RoutedRole, needs: RoleNeeds = {}, memo: CredentialMemo = new Map(), localReachable = false)`
and `async resolveRole(role: RoutedRole, needs: RoleNeeds = {}, memo: CredentialMemo = new Map(), localReachable = false)`,
each simply forwarding its own `localReachable` to the other.

- [ ] **Step 6: Write the resolver**

Create `extensions/openvs-chat/src/completions/completionModel.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RoleRouter } from '../auto/router';
import { ProviderRegistry } from '../providers/registry';
import { modelSupportsFim } from '../providers/types';

/** The backend a completion request will be sent to. */
export interface ResolvedCompletionModel {
	readonly providerId: string;
	readonly model: string;
	/** True when the provider can serve this model through a real FIM endpoint. */
	readonly usesFim: boolean;
}

/** How long a local-endpoint reachability result is trusted before being re-probed. */
const PROBE_TTL_MS = 60_000;
/** How long a probe may take before it is treated as unreachable. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Decides which provider and model serve inline completions.
 *
 * Thin on purpose: ranking, credential inference and pin handling all belong to
 * {@link RoleRouter}, which is already tested. What lives here is the one thing the router
 * cannot decide from a pure table — whether the user's local endpoint is actually up.
 *
 * `RoleRouter` and `ProviderRegistry` are used only as parameter types below, so tsc elides
 * these two imports from the emitted JS — neither `../auto/router.js` nor
 * `../providers/registry.js` (both of which pull in `vscode` at module scope) actually loads
 * at runtime here, which is what lets `test-completion-router.mjs` exercise this class with
 * plain duck-typed stubs and no `vscode` stub.
 */
export class CompletionModelResolver {
	private probedAt = 0;
	private probeResult = false;
	private probing = false;

	constructor(
		private readonly router: RoleRouter,
		private readonly registry: ProviderRegistry,
	) { }

	/**
	 * The current completion backend, or undefined when nothing is eligible.
	 *
	 * Routes on the *last completed* local-endpoint probe, never on one still in flight —
	 * see {@link refreshProbeIfStale}. A stale probe under-admits `custom` for one extra
	 * cycle at worst; a blocking one pays a dead endpoint's connection timeout on every
	 * keystroke pause, which is the failure this design exists to avoid.
	 */
	async resolve(): Promise<ResolvedCompletionModel | undefined> {
		this.refreshProbeIfStale();
		const assignment = await this.router.resolveRole('complete', {}, new Map(), this.probeResult);
		if (!assignment.ready || !assignment.providerId || !assignment.model) {
			return undefined;
		}
		const info = this.registry.getProvider(assignment.providerId)?.info;
		return {
			providerId: assignment.providerId,
			model: assignment.model,
			usesFim: !!info && modelSupportsFim(info, assignment.model),
		};
	}

	/**
	 * Kicks a reachability probe when the cached result is older than {@link PROBE_TTL_MS},
	 * without ever being awaited by {@link resolve} — `resolve` is on the typing path, and a
	 * probe that blocks it pays a dead endpoint's connection timeout on every keystroke pause
	 * that lands during the check. `resolve` always routes on whatever the *previous* probe
	 * found; a probe kicked here updates `probeResult` for the call after it, once it lands.
	 */
	private refreshProbeIfStale(now = Date.now()): void {
		if (this.probing || now - this.probedAt < PROBE_TTL_MS) {
			return;
		}
		this.probing = true;
		this.probedAt = now;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		this.registry.listModels('custom', controller.signal)
			.then(() => { this.probeResult = true; })
			.catch(() => { this.probeResult = false; })
			.finally(() => { clearTimeout(timer); this.probing = false; });
	}
}
```

- [ ] **Step 7: Compile and run both router suites**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-router.mjs && node extensions/openvs-chat/scripts/test-auto-router.mjs
```

Expected: both print `all assertions passed`. `test-auto-router.mjs` is the regression check
that the Auto pipeline's own routing survived the widening unchanged.

- [ ] **Step 8: Commit**

```bash
git add extensions/openvs-chat/src/auto/router.ts extensions/openvs-chat/src/completions/completionModel.ts extensions/openvs-chat/scripts/test-completion-router.mjs
git commit -m "feat(completions): route a dedicated completion model with inverted ranking"
```

---

### Task 8: Cache, health and scheduling

The governance layer. Everything here exists to keep a per-keystroke feature from exhausting
the same free-tier budget agent runs depend on.

**Files:**
- Create: `extensions/openvs-chat/src/completions/cache.ts`
- Create: `extensions/openvs-chat/src/completions/health.ts`
- Create: `extensions/openvs-chat/src/completions/scheduler.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-scheduler.mjs`

**Interfaces:**
- Consumes: `RateLimitSnapshot` (existing).
- Produces: `CompletionCache` with `keyFor(model, prefix, suffix)`, `get(key)`, `set(key, value)`, `clear()`; `HealthTracker` with `record(ms)`, `isSlow()`, `reset()`; `CompletionScheduler` with `run<T>(work)`, `gate(snapshot, reserve, now)`, `dispose()`; `type GateResult = 'ok' | 'paused-quota' | 'paused-slow'`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-scheduler.mjs`:

```js
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the completion governance layer. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-scheduler.mjs
import assert from 'node:assert/strict';

const cacheMod = await import(new URL('../out/completions/cache.js', import.meta.url));
const healthMod = await import(new URL('../out/completions/health.js', import.meta.url));
const schedMod = await import(new URL('../out/completions/scheduler.js', import.meta.url));

// --- cache ------------------------------------------------------------------------------
{
	const cache = new cacheMod.CompletionCache(4);
	const k = cache.keyFor('m', 'const a = ', ';\n');
	cache.set(k, '1');
	assert.strictEqual(cache.get(k), '1');

	// The key covers the model, so switching models cannot serve a stale suggestion...
	assert.strictEqual(cache.get(cache.keyFor('other', 'const a = ', ';\n')), undefined);
	// ...and the suffix, so an edit below the cursor invalidates it.
	assert.strictEqual(cache.get(cache.keyFor('m', 'const a = ', ';\n\nmore')), undefined);

	// Returning to a position already asked about is served locally. This is the case the
	// editor's own forward stability does not cover: backspacing over a rejected suggestion.
	cache.set(cache.keyFor('m', 'const ab', ''), 'c = 1;');
	assert.strictEqual(cache.get(cache.keyFor('m', 'const ab', '')), 'c = 1;');

	// Bounded: the oldest entry is evicted rather than growing without limit.
	for (let i = 0; i < 6; i++) { cache.set(cache.keyFor('m', `p${i}`, ''), `v${i}`); }
	assert.strictEqual(cache.get(cache.keyFor('m', 'p0', '')), undefined, 'evicted');
	assert.strictEqual(cache.get(cache.keyFor('m', 'p5', '')), 'v5', 'retained');
}

// --- health -----------------------------------------------------------------------------
{
	const health = new healthMod.HealthTracker(3000, 5);
	assert.strictEqual(health.isSlow(), false, 'no samples means no opinion');
	// A single slow response is not a verdict — free tiers have cold starts, and tripping
	// on the first request would disable the feature on every fresh session.
	health.record(9000);
	assert.strictEqual(health.isSlow(), false);
	for (let i = 0; i < 4; i++) { health.record(9000); }
	assert.strictEqual(health.isSlow(), true, 'a consistently slow backend trips the breaker');
	// Recovery needs no restart.
	for (let i = 0; i < 5; i++) { health.record(300); }
	assert.strictEqual(health.isSlow(), false);
	health.record(9000);
	health.reset();
	assert.strictEqual(health.isSlow(), false, 'reset forgets history on a model change');
}

// --- quota gate -------------------------------------------------------------------------
{
	const sched = new schedMod.CompletionScheduler();
	const now = 1_000_000;
	const fresh = extra => ({ limitTokens: 8000, remainingTokens: 6000, resetMs: 30_000, at: now, ...extra });

	assert.strictEqual(sched.gate(fresh(), 0.15, now), 'ok');
	// Below the reserve, automatic completions stand down so Agent keeps the remainder.
	assert.strictEqual(sched.gate(fresh({ remainingTokens: 400 }), 0.15, now), 'paused-quota');
	// No data is not the same as no budget: most backends report nothing, and refusing on
	// no evidence would disable the feature for them entirely.
	assert.strictEqual(sched.gate(undefined, 0.15, now), 'ok');
	assert.strictEqual(sched.gate(fresh({ limitTokens: undefined }), 0.15, now), 'ok');
	// A stale reading is discarded rather than trusted — the window has probably refilled.
	assert.strictEqual(sched.gate(fresh({ remainingTokens: 400, at: now - 600_000 }), 0.15, now), 'ok');
}

// --- single flight ----------------------------------------------------------------------
{
	const sched = new schedMod.CompletionScheduler();
	let firstAborted = false;
	const first = sched.run(signal => new Promise(resolve => {
		signal.addEventListener('abort', () => { firstAborted = true; resolve('first'); });
	}));
	const second = await sched.run(async () => 'second');
	assert.strictEqual(await first, undefined, 'a superseded request resolves undefined, not stale text');
	assert.strictEqual(firstAborted, true, 'a new request aborts the one in flight');
	assert.strictEqual(second, 'second');

	// Disposal aborts whatever is outstanding, so nothing survives the provider.
	let thirdAborted = false;
	const third = sched.run(signal => new Promise(resolve => {
		signal.addEventListener('abort', () => { thirdAborted = true; resolve('third'); });
	}));
	sched.dispose();
	assert.strictEqual(await third, undefined);
	assert.strictEqual(thirdAborted, true);
}

console.log('all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-scheduler.mjs
```

Expected: FAIL — cannot find module `../out/completions/cache.js`.

- [ ] **Step 3: Write the cache**

Create `extensions/openvs-chat/src/completions/cache.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How much of each side of the cursor identifies a cache entry. */
const KEY_PREFIX_CHARS = 1024;
const KEY_SUFFIX_CHARS = 512;
/** Joins the key parts. A control character, so it cannot occur in source text. */
const KEY_SEPARATOR = '\u0000';

/**
 * Remembers recent completions so a cursor position already asked about costs nothing.
 *
 * The editor's `enableForwardStability` already covers typing *through* a suggestion, which
 * is the common case. What it does not cover is coming back: backspacing over a rejected
 * suggestion, undoing, or moving away and returning — each of which would otherwise be a
 * fresh request against a metered free tier for an answer that is already known.
 *
 * Insertion-ordered and bounded, so a long editing session cannot grow it without limit.
 */
export class CompletionCache {
	private readonly entries = new Map<string, string>();

	constructor(private readonly maxEntries = 100) { }

	/**
	 * The identity of a cursor position for caching purposes.
	 *
	 * Includes the model, because the same position answered by a different backend is a
	 * different answer, and the suffix, because an edit below the cursor changes what a
	 * correct completion is even when everything above it is untouched.
	 */
	keyFor(model: string, prefix: string, suffix: string): string {
		return [model, prefix.slice(-KEY_PREFIX_CHARS), suffix.slice(0, KEY_SUFFIX_CHARS)].join(KEY_SEPARATOR);
	}

	get(key: string): string | undefined {
		return this.entries.get(key);
	}

	set(key: string, value: string): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		if (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) {
				this.entries.delete(oldest.value);
			}
		}
	}

	clear(): void {
		this.entries.clear();
	}
}
```

- [ ] **Step 4: Write the health tracker**

Create `extensions/openvs-chat/src/completions/health.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Watches how long a backend actually takes and trips a breaker when it is too slow to be
 * useful for completion.
 *
 * Necessary because the free tiers this extension targets queue requests server-side: a
 * model can be perfectly healthy and still take twenty seconds to start. With no breaker
 * that reads to the user as "inline completions do not work" — no error, nothing to act on.
 * With one, the feature stands down and says which setting to change.
 *
 * A single slow sample is never a verdict: a cold model's first request is expected to be
 * slow, and disabling on it would disable the feature on every fresh session.
 */
export class HealthTracker {
	private readonly samples: number[] = [];

	constructor(
		/** Latency above which a backend is considered unusable for completion, in ms. */
		private readonly slowMs = 3000,
		/** How many recent samples the verdict is drawn from. */
		private readonly window = 5,
	) { }

	/** Records one completed request's round-trip time. */
	record(ms: number): void {
		this.samples.push(ms);
		if (this.samples.length > this.window) {
			this.samples.shift();
		}
	}

	/**
	 * Whether the backend is currently too slow. Requires a full window of samples, so the
	 * breaker cannot trip on a cold start, and clears itself as soon as latency recovers.
	 */
	isSlow(): boolean {
		if (this.samples.length < this.window) {
			return false;
		}
		const sorted = [...this.samples].sort((a, b) => a - b);
		const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
		return p95 > this.slowMs;
	}

	/** Forgets history — used when the model changes, since the old latency says nothing. */
	reset(): void {
		this.samples.length = 0;
	}
}
```

- [ ] **Step 5: Write the scheduler**

Create `extensions/openvs-chat/src/completions/scheduler.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RateLimitSnapshot } from '../providers/rateLimits';

/** How long a rate-limit reading is trusted before it is treated as no information. */
const SNAPSHOT_TTL_MS = 300_000;

/** Whether a completion request may proceed, and if not, why it is standing down. */
export type GateResult = 'ok' | 'paused-quota' | 'paused-slow';

/**
 * Serializes completion requests and decides when not to send one at all.
 *
 * Debouncing is deliberately *not* done here: the editor applies `debounceDelayMs` from the
 * provider metadata before it ever calls us, which is strictly better because it costs no
 * work at all. What is left is the part the editor cannot do — keeping one request in flight,
 * and refusing to spend the tail of a token window that Agent mode is about to need.
 */
export class CompletionScheduler {
	private inFlight?: AbortController;

	/**
	 * Runs `work` as the only outstanding completion request, aborting any predecessor.
	 *
	 * Resolves undefined when this request was itself superseded, so a caller can tell
	 * "no suggestion" from "a newer keystroke won" without inspecting abort errors — and so
	 * a slow reply can never be rendered against a cursor that has since moved.
	 */
	async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		this.inFlight?.abort();
		const controller = new AbortController();
		this.inFlight = controller;
		try {
			const result = await work(controller.signal);
			return controller.signal.aborted ? undefined : result;
		} catch (err) {
			if (controller.signal.aborted) {
				return undefined;
			}
			throw err;
		} finally {
			if (this.inFlight === controller) {
				this.inFlight = undefined;
			}
		}
	}

	/**
	 * Whether there is enough of the token window left to spend on a completion.
	 *
	 * Conservative in both directions. Missing or stale data permits the request — refusing
	 * on no evidence would disable the feature on every backend that reports nothing, which
	 * is most of them. A fresh reading below the reserve refuses it, so a burst of typing
	 * cannot consume the budget an agent run is about to need.
	 *
	 * This governs *tokens* only. {@link RateLimitSnapshot} carries no request-count fields,
	 * so a daily request cap — which is what Groq's free tier actually meters — is invisible
	 * here, and is defended against by the editor debounce, the cache and the breaker instead.
	 */
	gate(snapshot: RateLimitSnapshot | undefined, reserve: number, now = Date.now()): GateResult {
		if (!snapshot || snapshot.limitTokens === undefined || snapshot.remainingTokens === undefined) {
			return 'ok';
		}
		if (now - snapshot.at >= SNAPSHOT_TTL_MS) {
			return 'ok';
		}
		return snapshot.remainingTokens < snapshot.limitTokens * reserve ? 'paused-quota' : 'ok';
	}

	/** Aborts anything outstanding. Called when the provider is disposed or disabled. */
	dispose(): void {
		this.inFlight?.abort();
		this.inFlight = undefined;
	}
}
```

- [ ] **Step 6: Compile and run the test**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-completion-scheduler.mjs
```

Expected: `all assertions passed`.

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/src/completions/cache.ts extensions/openvs-chat/src/completions/health.ts extensions/openvs-chat/src/completions/scheduler.ts extensions/openvs-chat/scripts/test-completion-scheduler.mjs
git commit -m "feat(completions): add cache, latency breaker and quota-aware scheduler"
```

---

### Task 9: The inline provider, status bar and registration

Wires the pieces into a working feature. First task where typing in the editor produces
ghost text.

**Files:**
- Create: `extensions/openvs-chat/src/completions/inlineProvider.ts`
- Create: `extensions/openvs-chat/src/completions/statusBar.ts`
- Modify: `extensions/openvs-chat/src/extension.ts`
- Modify: `extensions/openvs-chat/package.json`
- Test: `extensions/openvs-chat/scripts/test-completion-isolation.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `OpenVSInlineCompletionProvider`; `registerInlineCompletions(registry, router): vscode.Disposable`; `CompletionStatusBar` with `setEnabled(bool)`, `setOutcome(outcome, detail?)`, `dispose()`.

- [ ] **Step 1: Write the failing isolation test**

Create `extensions/openvs-chat/scripts/test-completion-isolation.mjs`:

```js
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Guards the non-interference contract in section 3 of the design spec. The completion path
// shares mutable state with chat and Agent, and touching any of it from here changes
// behaviour the user did not ask to change. Static because the point is that these calls
// must not exist at all, not that they happen to be unreachable today. Run:
//   node extensions/openvs-chat/scripts/test-completion-isolation.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src', 'completions');
const sources = fs.readdirSync(dir)
	.filter(f => f.endsWith('.ts'))
	.map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
assert.ok(sources.length >= 10, `expected the completions module to be complete, saw ${sources.length} files`);

const banned = [
	// Module-global in providers/types.ts: setting it changes chat's stall detection too.
	['setStreamIdleTimeout', 'pass ReadSSEOptions.idleMs per request instead'],
	// Writes openvsChat.<provider>.model, which is the CHAT model, not the completion one.
	['.setModel(', 'write openvsChat.completions.model instead'],
	// Belongs to the agent loop; a 96-token completion must not tighten an agent budget.
	['adoptRequestCeiling', 'completions must not adjust agent budgets'],
	// Bundles a `pace` hook that would sleep out a refill window; see noteOnlyOpts.
	['fetchOpts(', 'use rateLimits.noteOnlyOpts() so completions never pace'],
];

for (const [file, text] of sources) {
	for (const [needle, why] of banned) {
		assert.ok(!text.includes(needle), `${file} must not use ${needle} — ${why}`);
	}
}

// AUTO_ROLES must not have grown a completion entry.
const router = fs.readFileSync(path.join(here, '..', 'src', 'auto', 'router.ts'), 'utf8');
assert.match(router, /AUTO_ROLES: AutoRole\[\] = \['plan', 'code', 'review'\]/);

console.log('all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-isolation.mjs
```

Expected: FAIL — the completions module has fewer than 10 files.

- [ ] **Step 3: Write the status bar**

Create `extensions/openvs-chat/src/completions/statusBar.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CompletionOutcome } from './types';

/**
 * Shows what inline completions are doing, and why they are silent when they are.
 *
 * A checkbox can say on or off; it cannot say "paused because this backend has 400 tokens
 * left in the window" or "this file is excluded because it looks like a credential store".
 * Those are exactly the states a user would otherwise report as the feature being broken.
 */
export class CompletionStatusBar {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
		this.item.command = 'openvsChat.completions.toggle';
		this.item.show();
		this.setEnabled(true);
	}

	/** Renders the resting state for an enabled or disabled feature. */
	setEnabled(enabled: boolean): void {
		this.item.text = enabled ? '$(sparkle) Thor' : '$(circle-slash) Thor';
		this.item.tooltip = enabled
			? 'OpenVS Thor inline completions are on. Click to turn them off.'
			: 'OpenVS Thor inline completions are off. Click to turn them on.';
	}

	/** Renders the outcome of the most recent attempt. */
	setOutcome(outcome: CompletionOutcome, detail?: string): void {
		switch (outcome) {
			case 'paused-quota':
				this.item.text = '$(watch) Thor';
				this.item.tooltip = 'Paused: this provider\'s token window is nearly spent, leaving the remainder for Agent runs.';
				return;
			case 'paused-slow':
				this.item.text = '$(watch) Thor';
				this.item.tooltip = `Paused: this backend is too slow for inline completion${detail ? ` (${detail})` : ''}. Pin a smaller model in Settings.`;
				return;
			case 'no-model':
				this.item.text = '$(circle-slash) Thor';
				this.item.tooltip = 'No eligible completion model. Add a provider key, or pin one in Settings.';
				return;
			case 'error':
				this.item.text = '$(warning) Thor';
				this.item.tooltip = `Last completion failed${detail ? `: ${detail}` : ''}. See the OpenVS Thor Completions output channel.`;
				return;
			default:
				this.setEnabled(true);
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
```

- [ ] **Step 4: Write the inline provider**

Create `extensions/openvs-chat/src/completions/inlineProvider.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RoleRouter } from '../auto/router';
import { ChatProvider } from '../providers/types';
import { ProviderRegistry } from '../providers/registry';
import { FIM_STOP, buildChatPrompt } from './prompt';
import { CompletionCache } from './cache';
import { CompletionModelResolver, ResolvedCompletionModel } from './completionModel';
import { CompletionScheduler } from './scheduler';
import { CompletionStatusBar } from './statusBar';
import { CompletionWindow } from './types';
import { HealthTracker } from './health';
import { applyEol, buildWindow } from './context';
import { isExcluded } from './exclusions';
import { sanitizeCompletion } from './sanitize';

/** Settings read fresh per request, so a change takes effect without a reload. */
interface CompletionSettings {
	readonly maxLines: number;
	readonly prefixChars: number;
	readonly suffixChars: number;
	readonly maxTokens: number;
	readonly quotaReserve: number;
	readonly slowMs: number;
	readonly excludeFiles: string[];
	readonly disabledLanguages: string[];
	readonly allowUntrusted: boolean;
}

/** Cap on the extracted import block; see `context.ts`. */
const IMPORT_CHARS = 600;

/** How much more a user may get when they ask explicitly rather than just pausing. */
const INVOKE_LINE_MULTIPLIER = 4;

/**
 * Serves inline ghost-text completions from whichever model backend the user has.
 *
 * Glue only: windowing, exclusion, sanitizing, caching, gating and routing each live in
 * their own tested module. What is here is the order they run in and the mapping onto the
 * editor's provider contract.
 */
export class OpenVSInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private readonly cache = new CompletionCache();
	private readonly health: HealthTracker;
	private readonly scheduler = new CompletionScheduler();
	private readonly resolver: CompletionModelResolver;

	constructor(
		private readonly registry: ProviderRegistry,
		router: RoleRouter,
		private readonly status: CompletionStatusBar,
		private readonly log: vscode.OutputChannel,
	) {
		this.resolver = new CompletionModelResolver(router, registry);
		this.health = new HealthTracker(readSettings().slowMs);
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionList | undefined> {
		const settings = readSettings();
		const invoked = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
		const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');

		if (isExcluded({
			relativePath,
			scheme: document.uri.scheme,
			languageId: document.languageId,
			cursorLine: document.lineAt(position.line).text,
		}, {
			excludeFiles: settings.excludeFiles,
			trusted: vscode.workspace.isTrusted,
			allowUntrusted: settings.allowUntrusted,
			disabledLanguages: settings.disabledLanguages,
		})) {
			return undefined;
		}

		const resolved = await this.resolver.resolve();
		if (!resolved) {
			this.status.setOutcome('no-model');
			return undefined;
		}
		const provider = this.registry.getProvider(resolved.providerId);
		if (!provider) {
			return undefined;
		}

		// Both breakers govern automatic requests only. An explicit Alt+\ is the user saying
		// they will wait, and refusing it would leave no way to use a slow or nearly-spent
		// backend deliberately.
		if (!invoked && this.health.isSlow()) {
			this.status.setOutcome('paused-slow');
			return undefined;
		}
		if (!invoked && this.scheduler.gate(provider.rateLimit?.(resolved.model), settings.quotaReserve) !== 'ok') {
			this.status.setOutcome('paused-quota');
			return undefined;
		}

		const window = buildWindow({
			text: document.getText(),
			languageId: document.languageId,
			relativePath,
			eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
		}, document.offsetAt(position), {
			prefixChars: settings.prefixChars,
			suffixChars: settings.suffixChars,
			importChars: IMPORT_CHARS,
		});

		const key = this.cache.keyFor(resolved.model, window.prefix, window.suffix);
		const cached = this.cache.get(key);
		const text = cached ?? await this.request(provider, resolved, window, settings, invoked, token);
		if (!text) {
			return undefined;
		}
		if (cached === undefined) {
			this.cache.set(key, text);
		}

		// A real suggestion clears whatever paused/error state a prior request left behind —
		// without this, one early 'no-model'/'paused-quota'/'error' outcome sticks in the
		// status bar forever, even once completions start succeeding normally again, which is
		// exactly the "user reports the feature as broken" failure this status bar exists to
		// prevent.
		this.status.setOutcome('shown');

		// Anchored at the cursor as a zero-width replacement. When the suggest widget is open
		// the editor matches our text against `context.selectedCompletionInfo` itself and
		// declines to render a suggestion that does not extend the selected item.
		const item = new vscode.InlineCompletionItem(
			applyEol(text, window.eol),
			new vscode.Range(position, position),
		);
		const list = new vscode.InlineCompletionList([item]);
		// Without this the editor re-requests on every character the user types *through* the
		// suggestion — the largest single source of avoidable requests on a metered tier.
		list.enableForwardStability = true;
		return list;
	}

	/** Issues one request, preferring a real FIM endpoint and falling back to a chat prompt. */
	private async request(
		provider: ChatProvider,
		resolved: ResolvedCompletionModel,
		window: CompletionWindow,
		settings: CompletionSettings,
		invoked: boolean,
		token: vscode.CancellationToken,
	): Promise<string> {
		const apiKey = await this.registry.getApiKey(resolved.providerId) ?? '';
		const baseUrl = this.registry.getBaseUrl(resolved.providerId);
		const maxLines = invoked ? settings.maxLines * INVOKE_LINE_MULTIPLIER : settings.maxLines;
		const started = Date.now();

		const raw = await this.scheduler.run(async signal => {
			const linked = new AbortController();
			signal.addEventListener('abort', () => linked.abort());
			token.onCancellationRequested(() => linked.abort());
			if (resolved.usesFim && provider.completeFim) {
				return provider.completeFim({
					prefix: window.prefix, suffix: window.suffix, model: resolved.model,
					apiKey, baseUrl, maxTokens: settings.maxTokens,
					stop: FIM_STOP, signal: linked.signal,
				});
			}
			let text = '';
			await provider.streamChat({
				messages: buildChatPrompt(window),
				model: resolved.model, apiKey, baseUrl,
				maxTokens: settings.maxTokens, signal: linked.signal,
				onToken: delta => { text += delta; },
			});
			return text;
		}).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			this.log.appendLine(`${new Date().toISOString()} ${resolved.providerId}/${resolved.model} failed: ${message}`);
			this.status.setOutcome('error', message);
			return undefined;
		});

		if (raw === undefined) {
			return '';
		}
		const elapsed = Date.now() - started;
		this.health.record(elapsed);
		this.log.appendLine(`${new Date().toISOString()} ${resolved.providerId}/${resolved.model} ${elapsed}ms ${resolved.usesFim ? 'fim' : 'chat'}`);
		return sanitizeCompletion(raw, window, { maxLines });
	}

	/** Releases the in-flight request and cached suggestions. */
	dispose(): void {
		this.scheduler.dispose();
		this.cache.clear();
	}
}

/** Reads the `openvsChat.completions.*` settings. */
function readSettings(): CompletionSettings {
	const cfg = vscode.workspace.getConfiguration('openvsChat.completions');
	return {
		maxLines: cfg.get<number>('maxLines') ?? 6,
		prefixChars: cfg.get<number>('prefixChars') ?? 2000,
		suffixChars: cfg.get<number>('suffixChars') ?? 1000,
		maxTokens: cfg.get<number>('maxTokens') ?? 96,
		quotaReserve: cfg.get<number>('quotaReserve') ?? 0.15,
		slowMs: cfg.get<number>('slowMs') ?? 3000,
		excludeFiles: cfg.get<string[]>('excludeFiles') ?? [],
		disabledLanguages: cfg.get<string[]>('disabledLanguages') ?? [],
		allowUntrusted: cfg.get<boolean>('untrusted') ?? false,
	};
}

/**
 * Registers inline completions and keeps the registration in step with the enabled setting.
 *
 * Disabling disposes the provider rather than leaving it registered and returning nothing:
 * an off switch that still reads the document on every keystroke is not off.
 */
export function registerInlineCompletions(registry: ProviderRegistry, router: RoleRouter): vscode.Disposable {
	const status = new CompletionStatusBar();
	const log = vscode.window.createOutputChannel('OpenVS Thor Completions');
	let active: { provider: OpenVSInlineCompletionProvider; registration: vscode.Disposable } | undefined;

	const sync = () => {
		const cfg = vscode.workspace.getConfiguration('openvsChat.completions');
		const enabled = cfg.get<boolean>('enabled') ?? true;
		status.setEnabled(enabled);
		if (enabled === !!active) {
			return;
		}
		if (!enabled) {
			active?.provider.dispose();
			active?.registration.dispose();
			active = undefined;
			return;
		}
		const provider = new OpenVSInlineCompletionProvider(registry, router, status, log);
		const registration = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			provider,
			{
				displayName: 'OpenVS Thor',
				// The editor debounces before calling the provider, which is strictly cheaper
				// than debouncing after the call has already been made.
				debounceDelayMs: cfg.get<number>('debounceMs') ?? 250,
			},
		);
		active = { provider, registration };
	};

	sync();
	const watcher = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('openvsChat.completions')) {
			sync();
		}
	});

	return new vscode.Disposable(() => {
		watcher.dispose();
		active?.provider.dispose();
		active?.registration.dispose();
		status.dispose();
		log.dispose();
	});
}
```

- [ ] **Step 5: Add settings, commands and keybinding**

In `extensions/openvs-chat/package.json`, add to `contributes.configuration.properties`:

```json
"openvsChat.completions.enabled": { "type": "boolean", "default": true, "description": "Show inline code completions as you type." },
"openvsChat.completions.model": { "type": "string", "default": "", "description": "Pin the completion model as 'provider:model'. Empty selects one automatically from your configured providers." },
"openvsChat.completions.debounceMs": { "type": "number", "default": 250, "description": "How long to wait after you stop typing before requesting a completion." },
"openvsChat.completions.maxLines": { "type": "number", "default": 6, "description": "Maximum lines in an automatic completion. An explicit request allows four times this." },
"openvsChat.completions.prefixChars": { "type": "number", "default": 2000, "description": "Characters of context sent from before the cursor." },
"openvsChat.completions.suffixChars": { "type": "number", "default": 1000, "description": "Characters of context sent from after the cursor." },
"openvsChat.completions.maxTokens": { "type": "number", "default": 96, "description": "Maximum tokens a completion may generate." },
"openvsChat.completions.quotaReserve": { "type": "number", "default": 0.15, "description": "Fraction of a provider's token window kept in reserve for Agent runs. Automatic completions pause below it." },
"openvsChat.completions.slowMs": { "type": "number", "default": 3000, "description": "Latency above which a backend is treated as too slow for inline completion, pausing automatic requests." },
"openvsChat.completions.disabledLanguages": { "type": "array", "items": { "type": "string" }, "default": [], "description": "Language ids never to complete in, for example 'markdown'." },
"openvsChat.completions.excludeFiles": { "type": "array", "items": { "type": "string" }, "default": [], "description": "Glob patterns never sent to a completion model. Credential files are always excluded regardless of this setting." },
"openvsChat.completions.inComments": { "type": "boolean", "default": true, "description": "Offer completions while the cursor is in a comment." },
"openvsChat.completions.untrusted": { "type": "boolean", "default": false, "description": "Allow inline completions in untrusted workspaces. Off by default: file contents are sent to your model provider as you type." }
```

Add to `contributes.commands`:

```json
{ "command": "openvsChat.completions.toggle", "title": "Toggle Inline Completions", "category": "OpenVS Thor" },
{ "command": "openvsChat.completions.trigger", "title": "Trigger Inline Completion", "category": "OpenVS Thor" },
{ "command": "openvsChat.completions.showStats", "title": "Show Inline Completion Stats", "category": "OpenVS Thor" }
```

Add a `contributes.keybindings` array:

```json
[{ "command": "openvsChat.completions.trigger", "key": "alt+\\", "when": "editorTextFocus" }]
```

- [ ] **Step 6: Register from the extension entry point**

In `extensions/openvs-chat/src/extension.ts`, inside `activate`, after the `registry` exists.
`extension.ts` does not already hold a `RoleRouter` instance — `chatViewProvider.ts`
constructs its own (`new RoleRouter(registry, id => this.modelCache.get(id))`, passing a
model-catalog callback that improves tool-capability decisions for the `code`/`plan`/`review`
roles). Construct a second instance here instead of importing that one: `RoleRouter` holds no
state beyond its constructor arguments (`registry` and the optional catalog callback), and the
missing catalog callback is inert for the `complete` role specifically, since the
catalog-backed tool-capability check (`router.ts`, gated on `role === 'code'`) never runs for
`complete`.

```ts
	const router = new RoleRouter(registry);
	context.subscriptions.push(registerInlineCompletions(registry, router));
	context.subscriptions.push(vscode.commands.registerCommand('openvsChat.completions.toggle', async () => {
		const cfg = vscode.workspace.getConfiguration('openvsChat.completions');
		await cfg.update('enabled', !(cfg.get<boolean>('enabled') ?? true), vscode.ConfigurationTarget.Global);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('openvsChat.completions.trigger', async () => {
		await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
	}));
```

- [ ] **Step 7: Compile and run every suite**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && npm run test --prefix extensions/openvs-chat
```

Expected: all suites pass, `test-completion-isolation.mjs` included.

- [ ] **Step 8: Verify by hand in the Extension Development Host**

Press `F5`. In the new window, with at least one provider key configured:
1. Type a partial function body in a `.ts` file — ghost text appears, `Tab` accepts it.
2. Chat, Agent mode and Auto mode all still work. This task touched `extension.ts`.
3. Open a `.env` file and type. No request is made; the output channel stays silent.
4. Set `openvsChat.completions.enabled` to false — ghost text stops, status bar changes.
5. In a CRLF file, accept a multi-line completion and confirm no `^M` artifacts appear.

- [ ] **Step 9: Commit**

```bash
git add extensions/openvs-chat/src/completions/inlineProvider.ts extensions/openvs-chat/src/completions/statusBar.ts extensions/openvs-chat/src/extension.ts extensions/openvs-chat/package.json extensions/openvs-chat/scripts/test-completion-isolation.mjs
git commit -m "feat(completions): register inline completion provider with status bar and settings"
```

---

### Task 10: Acceptance statistics and the native model picker

Closes the loop. Without this there is no way to know whether any of the above produces
suggestions worth accepting, and the model dropdown the spec promised does not exist.

**Files:**
- Create: `extensions/openvs-chat/src/completions/stats.ts`
- Modify: `extensions/openvs-chat/src/completions/inlineProvider.ts`
- Modify: `extensions/openvs-chat/src/extension.ts`
- Test: `extensions/openvs-chat/scripts/test-completion-stats.mjs`

**Interfaces:**
- Consumes: `CompletionModelResolver` (Task 7).
- Produces: `CompletionStats` with `shown(model)`, `accepted(model)`, `rejected(model)`, `partial(model, chars)`, `rateFor(model)`, `report()`; `interface StatsRow { model: string; shown: number; accepted: number; rate: number | undefined }`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-completion-stats.mjs`:

```js
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/completions/stats.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-completion-stats.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/completions/stats.js', import.meta.url));

const stats = new m.CompletionStats();
// No samples means no opinion, not a zero score — a model must not be ranked last merely
// for being new, or the first bad run would permanently bury a good backend.
assert.strictEqual(stats.rateFor('a'), undefined);

for (let i = 0; i < 10; i++) { stats.shown('a'); }
for (let i = 0; i < 7; i++) { stats.accepted('a'); }
assert.strictEqual(stats.rateFor('a'), 0.7);

// A partial accept counts as an accept: the user took part of it, which is the signal.
// Scoring it as a rejection would punish exactly the multi-line completions worth having.
stats.shown('b');
stats.partial('b', 12);
assert.strictEqual(stats.rateFor('b'), undefined, 'one sample is not enough to rank on');
for (let i = 0; i < 9; i++) { stats.shown('b'); stats.rejected('b'); }
assert.strictEqual(Math.round(stats.rateFor('b') * 100), 10);

const report = stats.report();
assert.deepStrictEqual(report.map(r => r.model).sort(), ['a', 'b']);
assert.deepStrictEqual(
	report.find(r => r.model === 'a'),
	{ model: 'a', shown: 10, accepted: 7, rate: 0.7 },
);

console.log('all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node extensions/openvs-chat/scripts/test-completion-stats.mjs
```

Expected: FAIL — cannot find module `../out/completions/stats.js`.

- [ ] **Step 3: Write the stats module**

Create `extensions/openvs-chat/src/completions/stats.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Counters for one model. */
interface ModelStats {
	shown: number;
	accepted: number;
}

/** How many samples a model needs before its acceptance rate means anything. */
const MIN_SAMPLES = 10;

/** One model's record, for the stats command. */
export interface StatsRow {
	readonly model: string;
	readonly shown: number;
	readonly accepted: number;
	readonly rate: number | undefined;
}

/**
 * Tracks how often each model's suggestions are actually taken.
 *
 * This is the only measurement that says whether the feature *works*. Latency and error rate
 * say whether it runs; acceptance says whether what it produces was worth showing — which
 * matters more here than it would for a single-vendor product, because the model pool is
 * whatever free-tier backends the user happens to hold keys for and their quality varies
 * enormously.
 *
 * Local and in-memory. Nothing is transmitted anywhere.
 */
export class CompletionStats {
	private readonly byModel = new Map<string, ModelStats>();

	private entry(model: string): ModelStats {
		const existing = this.byModel.get(model);
		if (existing) {
			return existing;
		}
		const created: ModelStats = { shown: 0, accepted: 0 };
		this.byModel.set(model, created);
		return created;
	}

	shown(model: string): void {
		this.entry(model).shown++;
	}

	accepted(model: string): void {
		this.entry(model).accepted++;
	}

	/** Recorded so the model appears in {@link report} even when nothing is ever accepted. */
	rejected(model: string): void {
		this.entry(model);
	}

	/**
	 * A partial accept counts as an accept. A user taking one word of a suggestion is
	 * evidence it was on the right track, which is what this measures.
	 */
	partial(model: string, _chars: number): void {
		this.entry(model).accepted++;
	}

	/**
	 * Acceptance rate, or undefined below {@link MIN_SAMPLES} — undefined rather than zero,
	 * so a newly-tried model is ranked as unknown rather than as bad.
	 */
	rateFor(model: string): number | undefined {
		const stats = this.byModel.get(model);
		if (!stats || stats.shown < MIN_SAMPLES) {
			return undefined;
		}
		return stats.accepted / stats.shown;
	}

	/** Every model's record, for `openvsChat.completions.showStats`. */
	report(): StatsRow[] {
		return [...this.byModel.entries()].map(([model, stats]) => ({
			model,
			shown: stats.shown,
			accepted: stats.accepted,
			rate: this.rateFor(model),
		}));
	}
}
```

- [ ] **Step 4: Wire the lifecycle callbacks**

In `inlineProvider.ts` add `private readonly stats = new CompletionStats();` and
`private readonly itemModel = new WeakMap<vscode.InlineCompletionItem, string>();`, record
`this.itemModel.set(item, resolved.model)` before returning the list, and implement the
proposal's hooks on the class:

```ts
	/** The editor showed this item; `updatedInsertText` is the text after bracket repair. */
	handleDidShowCompletionItem(item: vscode.InlineCompletionItem, _updatedInsertText: string): void {
		const model = this.itemModel.get(item);
		if (model) {
			this.stats.shown(model);
		}
	}

	/**
	 * Word- or line-level accept. Counted as an accept — see {@link CompletionStats.partial}.
	 *
	 * The proposed API declares this method twice — once with a `PartialAcceptInfo` second
	 * argument, once (deprecated) with a plain `acceptedLength: number` — which TypeScript
	 * merges into one overloaded member when implementing the interface. A single signature
	 * naming only the new shape does not type-check; the parameter must accept both, with a
	 * runtime branch to read the char count out of whichever one arrived.
	 */
	handleDidPartiallyAcceptCompletionItem(item: vscode.InlineCompletionItem, infoOrLength: vscode.PartialAcceptInfo | number): void {
		const model = this.itemModel.get(item);
		if (!model) {
			return;
		}
		const chars = typeof infoOrLength === 'number' ? infoOrLength : infoOrLength.acceptedLength;
		this.stats.partial(model, chars);
	}

	/** Final disposition of a shown item. */
	handleEndOfLifetime(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
		const model = this.itemModel.get(item);
		if (!model) {
			return;
		}
		if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted) {
			this.stats.accepted(model);
		} else {
			this.stats.rejected(model);
		}
	}

	/** Exposed for `openvsChat.completions.showStats`. */
	report(): StatsRow[] {
		return this.stats.report();
	}
```

- [ ] **Step 5: Add the native model picker**

Still in `inlineProvider.ts`, on the same class. This is the model selector the spec calls
for — VS Code renders it in the inline-suggest UI, so no custom quick-pick is needed:

```ts
	private readonly onDidChangeModelInfoEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeModelInfo = this.onDidChangeModelInfoEmitter.event;
	private candidates: vscode.InlineCompletionModel[] = [];
	private currentModelId = '';

	/** Populated from the router's ranked candidates for the `complete` role. */
	get modelInfo(): vscode.InlineCompletionModelInfo | undefined {
		return this.candidates.length
			? { models: this.candidates, currentModelId: this.currentModelId }
			: undefined;
	}

	/**
	 * Persists the user's pick.
	 *
	 * Writes `openvsChat.completions.model`, never `ProviderRegistry.setModel` — that writes
	 * `openvsChat.<provider>.model`, which is the *chat* model, so routing the dropdown there
	 * would silently change the model the chat panel uses. This is one of the two calls
	 * `test-completion-isolation.mjs` exists to forbid.
	 */
	async setCurrentModelId(modelId: string): Promise<void> {
		await vscode.workspace.getConfiguration('openvsChat').update(
			'completions.model', modelId, vscode.ConfigurationTarget.Global);
		this.currentModelId = modelId;
		// The old backend's latency history and cached suggestions say nothing about the new one.
		this.health.reset();
		this.cache.clear();
		this.onDidChangeModelInfoEmitter.fire();
	}
```

Populate `candidates` from `router.resolveRoleCandidates('complete')` when the provider is
constructed and whenever configuration changes, mapping each `RoleAssignment` to
`{ id: `${a.providerId}:${a.model}`, name: `${a.model} (${a.providerLabel})` }`.

Three corrections found during task review, applied on top of the above:

- **Constructor purity.** `router` must reach `refreshModelCandidates` without editing
  Task 9's existing `router: RoleRouter,` constructor parameter (this file's changes must
  stay purely additive). Add a separate `private readonly router: RoleRouter;` field
  alongside `candidates`/`currentModelId`, and set it in the constructor body
  (`this.router = router;`, ahead of `this.resolver = new CompletionModelResolver(router, registry);`)
  rather than annotating the parameter itself.
- **No double-counting.** `handleDidPartiallyAcceptCompletionItem` must not call
  `stats.partial()`/`stats.accepted()` directly — a partial accept can be followed by a
  terminal `handleEndOfLifetime(Accepted)` for the *same* item, and counting both inflates
  the acceptance rate above what happened. Add
  `private readonly itemPartiallyAccepted = new WeakSet<vscode.InlineCompletionItem>();`;
  `handleDidPartiallyAcceptCompletionItem` only does `this.itemPartiallyAccepted.add(item)`.
  `handleEndOfLifetime` becomes the sole scoring point: `Accepted` → `stats.accepted(model)`;
  else, if `this.itemPartiallyAccepted.has(item)` → `stats.partial(model, 0)` (a partial
  accept is still evidence the suggestion was useful, per `CompletionStats.partial`'s own
  rationale); else → `stats.rejected(model)`.
- **`custom` must be reachable in the dropdown, not just in real requests.** Add a public
  getter to `CompletionModelResolver` (Task 7, `completionModel.ts`):
  `/** The last completed reachability probe's result — see {@link refreshProbeIfStale}. */`
  `get localReachable(): boolean { return this.probeResult; }`. Change
  `refreshModelCandidates` to call
  `this.router.resolveRoleCandidates('complete', {}, new Map(), this.resolver.localReachable)`
  — otherwise the dropdown can never list `custom` even when it is the model actually
  serving completions, since it defaults to `false`. This reflects the probe's state at
  construction/config-change time, not in real time; that's an accepted limitation, not a
  new gap.

Also wrap both `void this.refreshModelCandidates();` call sites (constructor and the
config-change listener) in `.catch(() => { });` — low-likelihood but free to close.

- [ ] **Step 6: Register the stats command**

In `extension.ts`, alongside the other completion commands, print the report to the output
channel — `registerInlineCompletions` returns the channel and the active provider so the
command can reach them.

- [ ] **Step 7: Compile and run every suite**

```bash
npx tsc -p extensions/openvs-chat/tsconfig.json && npm run test --prefix extensions/openvs-chat
```

Expected: all pass. `test-completion-isolation.mjs` in particular — it is what catches
`setModel` being used for the dropdown.

- [ ] **Step 8: Commit**

```bash
git add extensions/openvs-chat/src/completions/stats.ts extensions/openvs-chat/src/completions/inlineProvider.ts extensions/openvs-chat/src/extension.ts extensions/openvs-chat/scripts/test-completion-stats.mjs
git commit -m "feat(completions): track acceptance rate and expose the native model picker"
```

---

### Task 11: Settings panel toggle

The on/off switch in the extension's own settings panel, where providers and keys are
already configured. Last, because it is the only task touching the chat webview and it must
land on a feature that already works without it.

**Files — corrected against the real codebase; the three items below were wrong in the
original brief and were found by the Task 11 implementer, not by pre-flight review:**
- Modify: `extensions/openvs-chat/media/main.js` — runtime behavior (event listener,
  checked-state sync) only. The settings-panel **markup** does not live here.
- Modify: `extensions/openvs-chat/src/webviewHtml.ts` — the actual home of the settings
  panel's `<label class="setting-row">…` HTML (confirmed: `main.js` has zero `setting-row`
  occurrences; the existing `enableReview`/`enableDecompose` checkboxes are both declared in
  `webviewHtml.ts`, not `main.js`).
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts`
- Modify: `extensions/openvs-chat/src/remote/policy.ts` — every webview→host message case
  must be classified in `REMOTE_DENIED` (or the allow list beside it), enforced by
  `test-remote-policy.mjs`; a new case with no classification fails the *whole suite*, not
  just this task's own test. Add `'setCompletionsEnabled'` to `REMOTE_DENIED` alongside its
  nearest peer, `'setDecompose'` — a completions toggle is a local editor preference, not
  something a paired remote client drives.
- `extensions/openvs-chat/scripts/test-webview.mjs` needs **no edit at all** — it has no
  hand-maintained id/message table to append to. It derives its assertions by reading the
  real source files (`main.js`, the compiled `webviewHtml.js`, `chatViewProvider.ts` and the
  `session`/`remote` directories) and regex-extracting element ids and message types
  directly, so a real element/case that exists is picked up automatically; a real one that's
  missing is what makes the test fail. The "same tables" description below is wrong — there
  are none — but the *behavior* (write the row/handler/case, then let this test fail-then-pass
  around them) still holds; only the "edit the test's tables" framing is inaccurate.

**Interfaces:**
- Consumes: the `openvsChat.completions.enabled` setting (Task 9).
- Produces: webview→host message `{ type: 'setCompletionsEnabled', value: boolean }`; element id `completionsEnabled`.

- [ ] **Step 1: Confirm the starting state**

`test-webview.mjs` needs no edit (see above) — instead, run it once before touching anything
else, to see it currently pass with no knowledge of `completionsEnabled` at all:

```bash
node extensions/openvs-chat/scripts/test-webview.mjs
```

Expected: passes. This is the baseline; it will start asserting on `completionsEnabled`
automatically once Steps 3–4 add the real markup, handler, and case — nothing to author in
the test file itself.

- [ ] **Step 2: (informational — superseded by Step 1)**

The original plan expected a RED step here from editing hand-maintained tables in
`test-webview.mjs`. There is nothing to edit and nothing to fail yet; proceed to Step 3.

- [ ] **Step 3: Add the row to the webview**

The markup lives in `extensions/openvs-chat/src/webviewHtml.ts`, beside the existing
`enableReview`/`enableDecompose` checkboxes — not in `main.js`, whatever an earlier draft of
this step said. Follow their exact existing pattern (`<label class="review-toggle">…`):

```html
<label class="review-toggle"><input type="checkbox" id="completionsEnabled" /> Inline completions — suggest code as you type</label>
```

The runtime behavior — event listener, checked-state variable, and the `els` lookup entry
(the file runs under `// @ts-check`, so the id must be declared there) — belongs in
`extensions/openvs-chat/media/main.js`, beside the other setting handlers:

```js
	els.completionsEnabled?.addEventListener('change', () => {
		vscode.postMessage({ type: 'setCompletionsEnabled', value: !!els.completionsEnabled.checked });
	});
```

Reflecting the current value on open needs two sides, not one — `postConfig()`'s payload
(`chatViewProvider.ts`) carries no completions field today, so calling it alone (per Step 4)
gives the webview nothing to read. Add a field to that payload, next to the other simple
scalar fields it already sends (`systemPrompt`, `maxTokens`, `rules`, …):

```ts
			completionsEnabled: cfg.get<boolean>('completions.enabled') ?? true,
```

and read it in `media/main.js`'s `case 'config':` handler (`main.js:2416`), next to the other
`typeof msg.<field> === '<type>'` reads in that same block:

```js
				if (typeof msg.completionsEnabled === 'boolean' && els.completionsEnabled) {
					els.completionsEnabled.checked = msg.completionsEnabled;
				}
```

- [ ] **Step 4: Add the host case arm**

In `extensions/openvs-chat/src/chatViewProvider.ts`, in the existing message switch directly
beside `case 'setReviewEnabled'` — an additive arm only, in the same shape:

```ts
			case 'setCompletionsEnabled':
				await vscode.workspace.getConfiguration('openvsChat').update(
					'completions.enabled', !!message.value, vscode.ConfigurationTarget.Global);
				await this.postConfig();
				break;
```

Two corrections to the shape shown above, against `setReviewEnabled`'s actual code
(`chatViewProvider.ts:1325-1329`) rather than the sketch this plan originally gave: every
settings-mutation case in this switch ends with `await this.postConfig();` — the call that
re-sends the whole settings snapshot to the webview so the panel's own state (this checkbox
included) reflects what was just written, not just whatever the webview optimistically
displayed before the round trip — and every case in this switch uses `break;`, never
`return;`, to fall through to whatever runs after the switch rather than exiting the
handler outright.

The registration added in Task 9 already watches
`onDidChangeConfiguration('openvsChat.completions')`, so the toggle takes effect at once —
but one more piece of wiring is required first, or the full suite fails outright: add
`'setCompletionsEnabled'` to `REMOTE_DENIED` in `extensions/openvs-chat/src/remote/policy.ts`,
beside its nearest peer `'setDecompose'`. Every webview→host message case must be classified
there (allowed or denied to a paired remote client), enforced by `test-remote-policy.mjs` —
an unclassified new case fails that test, which is part of the full suite, not a check
specific to this task. A completions toggle is a local editor preference, not something a
phone pairing session should drive, so it belongs in `REMOTE_DENIED`.

- [ ] **Step 5: Typecheck and run every suite**

```bash
npm run typecheck --prefix extensions/openvs-chat && npx tsc -p extensions/openvs-chat/tsconfig.json && npm run test --prefix extensions/openvs-chat
```

Expected: all pass. The typecheck covers `media/main.js` through its `// @ts-check` pragma
and `media/webview.d.ts`, so a mistyped element id fails here rather than at runtime.

- [ ] **Step 6: Verify by hand in the Extension Development Host**

Press `F5` and open the OpenVS Thor settings panel:
1. The Inline Completions checkbox reflects the current setting.
2. Unticking it stops ghost text immediately and updates the status bar.
3. Chat, Agent mode, Auto mode and the existing model dropdowns all behave as before — this
   task touched the shared webview.

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/media/main.js extensions/openvs-chat/src/webviewHtml.ts extensions/openvs-chat/src/chatViewProvider.ts extensions/openvs-chat/src/remote/policy.ts
git commit -m "feat(completions): add an inline completions toggle to the settings panel"
```

---

### Task 12: Documentation and final verification

**Files:**
- Modify: `extensions/openvs-chat/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the feature in the extension README**

Add an "Inline Completions" section covering: what it does; that the model is chosen
separately from the chat model and can be pinned; the four on/off surfaces; that credential
files are never sent; that untrusted workspaces are off by default; and that a local FIM
model (Ollama with `qwen2.5-coder`) is the fastest and cheapest option available.

- [ ] **Step 2: Update the repository guide**

Add a paragraph to `CLAUDE.md` under the `extensions/openvs-chat` architecture section
describing `src/completions/`, in the style of the existing module descriptions: the FIM vs
chat split and why it exists, why the sanitizer is load-bearing rather than cosmetic, the
inverted routing rules for the `complete` role, and the non-interference constraints future
work has to preserve (`setStreamIdleTimeout`, `setModel`, `fetchOpts`, `AUTO_ROLES`).

- [ ] **Step 3: Full verification**

```bash
npm run typecheck --prefix extensions/openvs-chat && npm run gulp compile-extensions && npm run test --prefix extensions/openvs-chat
```

Expected: no type errors, extensions compile, every suite passes. Record the actual output.
Do not claim completion without it.

- [ ] **Step 4: Commit**

```bash
git add extensions/openvs-chat/README.md CLAUDE.md
git commit -m "docs: document inline completions"
```

---

## Self-Review

**Spec coverage.** Each spec section maps to a task. §3 non-interference → Task 1
(`noteOnlyOpts`) and Task 9 (`test-completion-isolation.mjs`). §4 API surface → Task 1
(wiring), Task 9 (`enableForwardStability`, `debounceDelayMs`), Task 10 (lifecycle hooks,
`modelInfo`). §5 architecture → Tasks 2–10. §6 routing → Task 7. §7 request shape → Tasks 1,
5, 6. §8 sanitizer → Task 4. §9 governance → Tasks 8 and 9. §10 safety → Task 2 (CRLF),
Task 3 (secrets, schemes, trust), Task 9 (`selectedCompletionInfo`, near-empty prefix).
§11 settings → Task 9. §11a on/off surfaces → Task 9 (setting, command, status bar) and
Task 11 (panel). §12 degradation → Task 9. §13 testing → distributed. §14 build order →
task order.

**Corrections made against the spec while planning.** The spec says new tests must be
"registered in `run-tests.mjs`"; the runner in fact auto-discovers `test-*.mjs`, so no
registration step appears in any task. The spec's `test-model-axes.mjs` extension is folded
into Task 6, where the `fimModelPatterns` tables it would check are introduced.

**Known deferrals, carried deliberately.** NES (`isInlineEdit`) is v2 per the approved
scope. `providerOptions` is declared unused. `completions.inComments` is contributed in
Task 9 and read by nothing: spec §10 already records that precise comment detection is not
attempted because the extension host has no tokenizer, so this is a forward declaration
rather than an oversight.

**Type consistency.** `CompletionWindow` (Task 1) is produced by `buildWindow` (Task 2) and
consumed by `buildChatPrompt` (Task 5) and `sanitizeCompletion` (Task 4) — the latter takes
the narrower `SanitizeWindow`, which `CompletionWindow` structurally satisfies. `FimRequest`
is defined in Task 1 and consumed in Task 6. `ResolvedCompletionModel` is defined in Task 7
and consumed in Task 9. `RoutedRole`, `isCompletionExcluded`, `roleSettingKey` and
`scoreForRole` are all introduced and used within Task 7. `CompletionOutcome` (Task 1) is
consumed by `statusBar.ts` (Task 9). `StatsRow` (Task 10) is returned by
`OpenVSInlineCompletionProvider.report()` in the same task.
