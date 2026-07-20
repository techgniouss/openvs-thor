# OpenVS-Chat Token Efficiency & Auto-Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the openvs-chat extension from re-sending unnecessary tokens (stale thinking blocks, whole-file dumps, uncapped skills/command output, blind auto-context), make the context budget model-aware, and auto-compact long conversations at 70% of the model's context window (Claude-Code style summarization instead of lossy trimming alone).

**Architecture:** Three pure, unit-testable modules carry the new logic — `persona/thinking.ts` gains `stripThinking`, new `agent/contextWindow.ts` resolves per-model windows/budgets, new `agent/compaction.ts` summarizes old turns. The extension-host glue (`chatViewProvider.ts`, `agentRunner.ts`, `tools.ts`, `anthropic.ts`) wires them in. The webview (`media/main.js`) learns one new message (`compacted`) so compaction persists across sends instead of re-running every turn.

**Tech Stack:** TypeScript (VS Code extension host), plain JS webview, node:assert test scripts against compiled `out/`.

## Global Constraints

- Tabs, not spaces. All files carry the OpenVS copyright header already present in each file — never remove it; new files copy it verbatim.
- Single quotes except user-facing localized strings; JSDoc comments on exported functions/classes; arrow functions over anonymous functions; braces always.
- No `any`/`unknown` unless truly unavoidable.
- Compile check after each host-side change: `npx tsc -p extensions/openvs-chat/tsconfig.json` (emits to `extensions/openvs-chat/out/`). Full extension build once at the end: `npm run gulp compile-extensions`.
- Existing test suites must keep passing: from repo root run
  `node extensions/openvs-chat/scripts/test-sse.mjs && node extensions/openvs-chat/scripts/test-agent-loop.mjs && node extensions/openvs-chat/scripts/test-context.mjs && node extensions/openvs-chat/scripts/test-persona-prompts.mjs && node extensions/openvs-chat/scripts/test-persona-thinking.mjs && node extensions/openvs-chat/scripts/test-persona-todos.mjs`
- `media/main.js` is saved in UTF-16; edit it with tools that preserve its existing encoding (do not re-save as UTF-8).
- Every new user-visible setting needs both a `package.json` entry and a `package.nls.json` string.
- MANDATORY (user CLAUDE.md): never stage/commit secrets; scan staged diff before each commit.

---

### Task 1: Strip stale thinking blocks from re-sent history

Ask/Plan streaming stores "🤔 *Thinking…* … ---" reasoning into the webview transcript, which is re-sent as history on every later send, forever. Strip it host-side when history arrives, so display keeps it but the wire never re-sends it.

**Files:**
- Modify: `extensions/openvs-chat/src/persona/thinking.ts` (append at end)
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:764` and `:821`
- Test: `extensions/openvs-chat/scripts/test-persona-thinking.mjs` (append)

**Interfaces:**
- Produces: `stripThinking(text: string): string` exported from `persona/thinking.ts` — removes every thinking block; also used by Task 8's summarizer.

- [ ] **Step 1: Write the failing tests**

Append to `extensions/openvs-chat/scripts/test-persona-thinking.mjs`:

```js
// stripThinking: removes rendered thinking blocks from committed transcript text.
{
	const s = m.stripThinking;
	assert.strictEqual(typeof s, 'function');
	assert.strictEqual(s('🤔 *Thinking…*\n\nsome reasoning here\n\n---\n\nThe answer.'), 'The answer.');
	// Multiple blocks (multi-step replies concatenated).
	assert.strictEqual(
		s('🤔 *Thinking…*\n\nA\n\n---\n\nfirst🤔 *Thinking…*\n\nB\n\n---\n\nsecond'),
		'firstsecond');
	// Unclosed block (stream ended mid-thinking): everything from the marker goes.
	assert.strictEqual(s('answer part\n\n🤔 *Thinking…*\n\ndangling'), 'answer part');
	// No block: text untouched (same string).
	assert.strictEqual(s('plain answer with --- a rule'), 'plain answer with --- a rule');
	assert.strictEqual(s(''), '');
}
console.log('test-persona-thinking stripThinking: all assertions passed');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-persona-thinking.mjs`
Expected: FAIL — `assert.strictEqual(typeof s, 'function')` fails (`undefined`).

- [ ] **Step 3: Implement `stripThinking`**

Append to `extensions/openvs-chat/src/persona/thinking.ts`:

```ts
/**
 * Matches a rendered thinking block: the OPEN_MARK, lazily up to the CLOSE_MARK
 * separator or end of text (a stream that died inside a thinking block never
 * emitted the separator — everything after the marker was reasoning).
 */
const THINKING_BLOCK = /🤔 \*Thinking…\*\n\n[\s\S]*?(?:\n\n---\n\n|$)/g;

/**
 * Removes rendered thinking blocks from a committed reply. The transcript shown to
 * the user keeps them, but re-sending past reasoning as history on every subsequent
 * turn is pure token waste — the model never needs its own stale thinking back.
 */
export function stripThinking(text: string): string {
	if (!text.includes(OPEN_MARK)) {
		return text;
	}
	return text.replace(THINKING_BLOCK, '').trim();
}
```

Note: `OPEN_MARK` already exists at the top of the file; the regex literal must use the same `…` (U+2026) character as `OPEN_MARK`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-persona-thinking.mjs`
Expected: PASS (all assertions, including the pre-existing ones).

- [ ] **Step 5: Wire into both send paths**

In `extensions/openvs-chat/src/chatViewProvider.ts`, the file already imports from `./persona/thinking`:

```ts
import { ThinkingStreamParser, formatThinking } from './persona/thinking';
```

Change to:

```ts
import { ThinkingStreamParser, formatThinking, stripThinking } from './persona/thinking';
```

Add this private method next to `configuredContextTokens()` (around line 1060):

```ts
/** History arrives from the webview with rendered thinking blocks still in past assistant turns; never re-send those. */
private sanitizeHistory(history: ChatMessage[]): ChatMessage[] {
	return history.map(m => m.role === 'assistant' ? { ...m, content: stripThinking(m.content) } : m);
}
```

In `handleSend` (line 764) change:

```ts
			const history: ChatMessage[] = message.messages ?? [];
```

to:

```ts
			const history: ChatMessage[] = this.sanitizeHistory(message.messages ?? []);
```

In `handleAutoSend` (line 821) change:

```ts
		const history: ChatMessage[] = message.messages ?? [];
```

to:

```ts
		const history: ChatMessage[] = this.sanitizeHistory(message.messages ?? []);
```

- [ ] **Step 6: Compile and run full suite**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` then all six test scripts (see Global Constraints).
Expected: 0 TypeScript errors, all suites pass.

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/src/persona/thinking.ts extensions/openvs-chat/src/chatViewProvider.ts extensions/openvs-chat/scripts/test-persona-thinking.mjs
git commit -m "fix(openvs-chat): stop re-sending stale thinking blocks as history"
```

---

### Task 2: `read_file` line paging + smaller default cap

`read_file` currently dumps up to 100 KB (~25k tokens) with no way to read part of a file. Add `offset`/`limit` line parameters and cap the default return at 48k chars with a paging note.

**Files:**
- Modify: `extensions/openvs-chat/src/agent/tools.ts:11` (constant), `:14-23` (tool spec), `:138-141` (dispatch), `:159-171` (`readFile`)

**Interfaces:**
- Produces: `read_file` tool accepts optional `offset` (1-based first line) and `limit` (line count); result may end with `[file has N lines; showing X–Y. Call read_file with offset=Z to continue.]`.

- [ ] **Step 1: Update the constant and tool spec**

In `extensions/openvs-chat/src/agent/tools.ts` replace:

```ts
const MAX_FILE_BYTES = 100_000;
```

with:

```ts
const MAX_FILE_BYTES = 100_000;
/** Default character cap for one read_file result — a whole-file dump eats the context budget for the rest of the run. */
const MAX_READ_CHARS = 48_000;
```

Replace the `read_file` spec entry:

```ts
	{
		name: 'read_file',
		description: 'Read the contents of a text file in the workspace. Paths are relative to the workspace root.',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
			required: ['path'],
		},
	},
```

with:

```ts
	{
		name: 'read_file',
		description: 'Read a text file in the workspace. Paths are relative to the workspace root. Large files are returned in pages — pass offset/limit to read a specific range instead of the whole file.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative file path.' },
				offset: { type: 'number', description: '1-based line number to start reading from. Omit to start at the top.' },
				limit: { type: 'number', description: 'Maximum number of lines to return. Omit for as much as fits.' },
			},
			required: ['path'],
		},
	},
```

- [ ] **Step 2: Update the dispatch**

In `executeTool`, replace:

```ts
			case 'read_file':
				return await readFile(root, String(call.args.path ?? ''), g);
```

with:

```ts
			case 'read_file':
				return await readFile(root, String(call.args.path ?? ''), g,
					typeof call.args.offset === 'number' ? call.args.offset : undefined,
					typeof call.args.limit === 'number' ? call.args.limit : undefined);
```

- [ ] **Step 3: Rewrite `readFile`**

Replace the whole `readFile` function:

```ts
async function readFile(root: vscode.Uri, path: string, g: Guardrails): Promise<ToolResult> {
	const guard = checkPath(root, path, false, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	const uri = resolve(root, path);
	const bytes = await vscode.workspace.fs.readFile(uri);
	if (bytes.byteLength > MAX_FILE_BYTES) {
		const head = new TextDecoder().decode(bytes.slice(0, MAX_FILE_BYTES));
		return { result: `${head}\n\n[truncated at ${MAX_FILE_BYTES} bytes]`, isError: false };
	}
	return { result: new TextDecoder().decode(bytes), isError: false };
}
```

with:

```ts
async function readFile(root: vscode.Uri, path: string, g: Guardrails, offset?: number, limit?: number): Promise<ToolResult> {
	const guard = checkPath(root, path, false, g);
	if (!guard.ok) {
		return { result: guard.reason ?? 'Path blocked.', isError: true };
	}
	const uri = resolve(root, path);
	const bytes = await vscode.workspace.fs.readFile(uri);
	// Decode at most 10× the page cap: enough for any offset the model asks for in
	// practice without pulling a multi-megabyte file through the decoder.
	const text = new TextDecoder().decode(bytes.slice(0, Math.max(MAX_FILE_BYTES * 10, MAX_READ_CHARS)));
	const lines = text.split('\n');
	const start = offset && offset > 0 ? Math.min(offset - 1, lines.length) : 0;
	const wanted = limit && limit > 0 ? lines.slice(start, start + limit) : lines.slice(start);

	// Enforce the char cap even inside an explicit range.
	const out: string[] = [];
	let chars = 0;
	for (const line of wanted) {
		if (chars + line.length + 1 > MAX_READ_CHARS) {
			break;
		}
		out.push(line);
		chars += line.length + 1;
	}
	const end = start + out.length;
	const whole = start === 0 && end >= lines.length && bytes.byteLength <= MAX_FILE_BYTES * 10;
	if (whole) {
		return { result: out.join('\n'), isError: false };
	}
	const note = `\n\n[file has ${lines.length} lines; showing ${start + 1}–${end}. Call read_file with offset=${end + 1} to continue.]`;
	return { result: out.join('\n') + note, isError: false };
}
```

- [ ] **Step 4: Compile and run suites**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` then the six test scripts.
Expected: 0 errors, all pass (tools.ts has no standalone suite — the agent-loop suite exercises the loop with fake tools).

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/agent/tools.ts
git commit -m "feat(openvs-chat): read_file line paging and 48k-char default cap"
```

---

### Task 3: Cap `run_command` output head+tail

Command output is capped at 100 KB and cut from the end — but errors live at the tail. Cap at 16k chars keeping head and tail.

**Files:**
- Modify: `extensions/openvs-chat/src/agent/tools.ts` (`runCommand`, add helper above it)

- [ ] **Step 1: Add the capping helper and use it**

Above `runCommand` in `extensions/openvs-chat/src/agent/tools.ts` add:

```ts
const MAX_CMD_OUTPUT = 16_000;

/** Keeps the start (what ran) and the end (where errors land) of long command output. */
function capCommandOutput(out: string): string {
	if (out.length <= MAX_CMD_OUTPUT) {
		return out;
	}
	const head = out.slice(0, 4_000);
	const tail = out.slice(-12_000);
	return `${head}\n[… ${out.length - 16_000} chars of output omitted …]\n${tail}`;
}
```

In `runCommand`, replace:

```ts
				const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, MAX_FILE_BYTES);
```

with:

```ts
				const out = capCommandOutput([stdout, stderr].filter(Boolean).join('\n'));
```

- [ ] **Step 2: Compile and run suites**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` then the six test scripts.
Expected: 0 errors, all pass.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/agent/tools.ts
git commit -m "feat(openvs-chat): cap run_command output head+tail at 16k chars"
```

---

### Task 4: Cap active-skill instructions in the system prompt

`uiux-pro-max.md` alone is 47 KB (~12k tokens) appended to every request while active. Rules are capped at 12 KB; skills get the same treatment at 16 KB per skill.

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:136-146` (`baseSystem`)

- [ ] **Step 1: Cap in `baseSystem`**

In `extensions/openvs-chat/src/chatViewProvider.ts`, replace the skill loop inside `baseSystem`:

```ts
		for (const skillId of this.activeSkillIds()) {
			const skill = await this.skills.get(skillId);
			if (skill?.instructions) {
				base = `${base}\n\n## Active skill: ${skill.name}\n${skill.instructions}`;
			}
		}
```

with:

```ts
		const MAX_SKILL_CHARS = 16_000;
		for (const skillId of this.activeSkillIds()) {
			const skill = await this.skills.get(skillId);
			if (skill?.instructions) {
				const instructions = skill.instructions.length > MAX_SKILL_CHARS
					? `${skill.instructions.slice(0, MAX_SKILL_CHARS)}\n\n…[skill truncated to fit the prompt budget]`
					: skill.instructions;
				base = `${base}\n\n## Active skill: ${skill.name}\n${instructions}`;
			}
		}
```

- [ ] **Step 2: Compile and run suites**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` then the six test scripts.
Expected: 0 errors, all pass.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "feat(openvs-chat): cap per-skill instructions at 16k chars in system prompt"
```

---

### Task 5: Ask-mode auto-context setting (active file only by default)

Ask mode silently attaches up to 32 KB of ALL open tabs on every send. Default becomes active-file-only; a setting restores old behavior or turns it off.

**Files:**
- Modify: `extensions/openvs-chat/package.json` (add setting after `openvsChat.agent.maxContextTokens` block, line ~360)
- Modify: `extensions/openvs-chat/package.nls.json` (new key near `config.agent.maxContextTokens`, line ~51)
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:1109-1111` (`resolveContext`), `:1120-1137` (`openEditorsContext`)

- [ ] **Step 1: Add the setting**

In `extensions/openvs-chat/package.json`, after the `openvsChat.agent.maxContextTokens` property block, add:

```json
        "openvsChat.ask.autoContext": {
          "type": "string",
          "enum": ["active", "tabs", "off"],
          "default": "active",
          "description": "%config.ask.autoContext%"
        },
```

In `extensions/openvs-chat/package.nls.json`, next to `config.agent.maxContextTokens`, add:

```json
  "config.ask.autoContext": "What Ask mode automatically attaches when you haven't attached anything: just the active file (default), every open editor tab, or nothing. Tool-capable models can read further files themselves either way.",
```

- [ ] **Step 2: Honor it in `resolveContext`**

Replace in `extensions/openvs-chat/src/chatViewProvider.ts`:

```ts
		if (mode === 'ask' && !attached) {
			return this.openEditorsContext();
		}
```

with:

```ts
		if (mode === 'ask' && !attached) {
			const auto = vscode.workspace.getConfiguration('openvsChat').get<string>('ask.autoContext') ?? 'active';
			if (auto === 'off') {
				return undefined;
			}
			return this.openEditorsContext(auto === 'active');
		}
```

- [ ] **Step 3: Add the `activeOnly` parameter to `openEditorsContext`**

Change its signature:

```ts
	private async openEditorsContext(): Promise<AttachedContext | undefined> {
```

to:

```ts
	private async openEditorsContext(activeOnly = false): Promise<AttachedContext | undefined> {
```

and immediately after the block that pushes the active editor URI:

```ts
		if (active) {
			seen.add(active.toString());
			uris.push(active);
		}
```

insert:

```ts
		if (activeOnly && uris.length) {
			return this.filesContext(uris);
		}
```

Then extract the existing collection loop's tail into the same code path: replace the remainder of the function body (the `for (const group ...)` loop through the final `return`) — keep the loop as-is, and replace the `parts`-building section and final return with a call `return this.filesContext(uris);`, moving that section into a new private method:

```ts
	/** Renders the given files (per-file and total capped) as one attached-context block. */
	private async filesContext(uris: vscode.Uri[]): Promise<AttachedContext | undefined> {
		const PER_FILE_CHARS = 8_000;
		const TOTAL_CHARS = 32_000;
		const active = vscode.window.activeTextEditor?.document.uri;
		const parts: string[] = [];
		let total = 0;
		let included = 0;
		for (const uri of uris) {
			let doc: vscode.TextDocument;
			try {
				doc = await vscode.workspace.openTextDocument(uri);
			} catch {
				continue; // non-text or unreadable tab — skip it
			}
			const name = vscode.workspace.asRelativePath(uri);
			let text = doc.getText();
			if (text.length > PER_FILE_CHARS) {
				text = `${text.slice(0, PER_FILE_CHARS)}\n… [truncated, ${text.length} chars total]`;
			}
			if (total + text.length > TOTAL_CHARS) {
				parts.push(`File: ${name} (${doc.languageId}) — open but omitted for length.`);
				continue;
			}
			total += text.length;
			included++;
			parts.push(`File: ${name} (${doc.languageId})${uri.toString() === active?.toString() ? ' [active editor]' : ''}\n\n${text}`);
		}
		if (!included) {
			return undefined;
		}
		return {
			label: `Open editors (${included} file${included === 1 ? '' : 's'})`,
			content: `These files are currently open in the user's editor:\n\n${parts.join('\n\n---\n\n')}`,
		};
	}
```

`openEditorsContext` becomes: build `uris` (active first, then tabs, deduped — existing logic), early-return `this.filesContext(uris)` when `activeOnly`, else `return this.filesContext(uris);` at the end. Delete the now-duplicated inline `parts` logic from `openEditorsContext`.

- [ ] **Step 4: Compile and run suites**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` then the six test scripts.
Expected: 0 errors, all pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/package.json extensions/openvs-chat/package.nls.json extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "feat(openvs-chat): ask.autoContext setting — attach active file only by default"
```

---

### Task 6: Model-aware context window resolution

Replace the blind 120k budget with a per-model window table. Budget = 80% of window minus response headroom. The 70% compaction trigger (Task 8/9) needs this window too.

**Files:**
- Create: `extensions/openvs-chat/src/agent/contextWindow.ts`
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:1061-1064` (`configuredContextTokens`) and call sites `:925`, `:991`, `:1029`
- Modify: `extensions/openvs-chat/package.json` (`openvsChat.agent.maxContextTokens` default → `0`), `extensions/openvs-chat/package.nls.json` (description)
- Test: `extensions/openvs-chat/scripts/test-context-window.mjs` (new)

**Interfaces:**
- Produces: `contextWindowFor(model: string): number` and `contextBudgetFor(model: string, maxOutputTokens: number, override?: number): number` from `agent/contextWindow.ts`. Task 8 and 9 consume `contextWindowFor`.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-context-window.mjs`:

```js
// Standalone unit test for src/agent/contextWindow.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-context-window.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/agent/contextWindow.js', import.meta.url));

// Known families resolve to their real windows.
assert.strictEqual(m.contextWindowFor('claude-fable-5'), 200_000);
assert.strictEqual(m.contextWindowFor('claude-sonnet-4-5-20250929'), 200_000);
assert.strictEqual(m.contextWindowFor('gpt-4o-mini'), 128_000);
assert.strictEqual(m.contextWindowFor('gpt-5'), 400_000);
assert.strictEqual(m.contextWindowFor('deepseek-ai/DeepSeek-R1'), 64_000);
assert.strictEqual(m.contextWindowFor('moonshot-v1-128k'), 128_000);
assert.strictEqual(m.contextWindowFor('qwen-max'), 128_000);
assert.strictEqual(m.contextWindowFor('meta/llama-3.1-70b-instruct'), 128_000);

// Unknown models get the conservative default.
assert.strictEqual(m.contextWindowFor('totally-unknown-model'), 32_000);
assert.strictEqual(m.contextWindowFor(''), 32_000);

// Budget: 80% of window minus response headroom, floored at the minimum.
assert.strictEqual(m.contextBudgetFor('claude-fable-5', 8_192), Math.floor(200_000 * 0.8) - 8_192);
assert.strictEqual(m.contextBudgetFor('totally-unknown-model', 8_192), Math.floor(32_000 * 0.8) - 8_192);
// A user override wins outright.
assert.strictEqual(m.contextBudgetFor('claude-fable-5', 8_192, 50_000), 50_000);
// Headroom can never push the budget below the floor.
assert.strictEqual(m.contextBudgetFor('totally-unknown-model', 30_000), 8_000);

console.log('test-context-window: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-context-window.mjs`
Expected: FAIL — cannot find `../out/agent/contextWindow.js`.

- [ ] **Step 3: Implement the module**

Create `extensions/openvs-chat/src/agent/contextWindow.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-model context-window resolution. The old fixed 120k budget overshot small
 * models (guaranteeing a wasted 400 round-trip before the halving fallback kicked
 * in) and undersold big ones. Patterns are matched in order — first hit wins —
 * against the raw model id, so gateway prefixes like `deepseek-ai/` still match.
 */

/** Conservative fallback for models we don't recognize. */
const DEFAULT_WINDOW = 32_000;

/** Floor below which shrinking the budget would starve the conversation entirely. */
const MIN_BUDGET = 8_000;

/** Share of the window offered to the conversation; the rest absorbs estimate error. */
const WINDOW_SHARE = 0.8;

const WINDOWS: Array<[RegExp, number]> = [
	[/claude/i, 200_000],
	[/gpt-5/i, 400_000],
	[/gpt-4\.1/i, 1_000_000],
	[/o[134](-mini|-pro)?\b/i, 200_000],
	[/gpt-4o|gpt-4-turbo/i, 128_000],
	[/deepseek-r1|deepseek-reasoner/i, 64_000],
	[/deepseek/i, 128_000],
	[/kimi-k2|moonshot.*256k/i, 256_000],
	[/kimi|moonshot/i, 128_000],
	[/qwen/i, 128_000],
	[/llama-?3\.[123]|llama-?4/i, 128_000],
	[/llama/i, 8_000],
	[/gemini/i, 1_000_000],
	[/mistral-large|mixtral-8x22b|ministral/i, 128_000],
	[/mistral|mixtral/i, 32_000],
];

/** The model's total context window in tokens (input + output). */
export function contextWindowFor(model: string): number {
	for (const [pattern, window] of WINDOWS) {
		if (pattern.test(model)) {
			return window;
		}
	}
	return DEFAULT_WINDOW;
}

/**
 * The estimated-token budget for the conversation sent to `model`: a share of the
 * window minus the response headroom, floored. An explicit user `override`
 * (openvsChat.agent.maxContextTokens > 0) wins outright.
 */
export function contextBudgetFor(model: string, maxOutputTokens: number, override?: number): number {
	if (override && override > 0) {
		return override;
	}
	return Math.max(MIN_BUDGET, Math.floor(contextWindowFor(model) * WINDOW_SHARE) - maxOutputTokens);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-context-window.mjs`
Expected: PASS.

- [ ] **Step 5: Wire into `chatViewProvider`**

Add the import in `extensions/openvs-chat/src/chatViewProvider.ts` next to the existing `./agent/context` import:

```ts
import { contextBudgetFor, contextWindowFor } from './agent/contextWindow';
```

Replace `configuredContextTokens` (lines 1060–1064):

```ts
	/** Estimated-token ceiling for the conversation, above which old tool output is trimmed. */
	private configuredContextTokens(): number {
		const configured = vscode.workspace.getConfiguration('openvsChat').get<number>('agent.maxContextTokens');
		return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_CONTEXT_TOKENS;
	}
```

with:

```ts
	/**
	 * Estimated-token ceiling for the conversation sent to `model`, above which old
	 * tool output is trimmed. Derived from the model's context window unless the user
	 * pinned an explicit openvsChat.agent.maxContextTokens.
	 */
	private configuredContextTokens(model: string, maxOutputTokens: number): number {
		const configured = vscode.workspace.getConfiguration('openvsChat').get<number>('agent.maxContextTokens');
		return contextBudgetFor(model, maxOutputTokens, typeof configured === 'number' ? configured : 0);
	}
```

Update the three call sites (each has `params` in scope):

- Line 925 (`runStreaming`): `trimMessages(messages, this.configuredContextTokens(params.model, params.maxTokens)),`
- Line 991 (`runReadOnlyAgent`): `maxContextTokens: this.configuredContextTokens(params.model, params.maxTokens),`
- Line 1029 (`runAgent`): `maxContextTokens: this.configuredContextTokens(params.model, params.maxTokens),`

Delete the now-unused `DEFAULT_CONTEXT_TOKENS` constant in `chatViewProvider.ts` (search for its declaration near the top; keep the one in `agentRunner.ts`, which remains the runner's own fallback).

- [ ] **Step 6: Update the setting default and description**

`extensions/openvs-chat/package.json` — change the `openvsChat.agent.maxContextTokens` block's `"default": 120000` to `"default": 0`.

`extensions/openvs-chat/package.nls.json` — replace the `config.agent.maxContextTokens` string with:

```json
  "config.agent.maxContextTokens": "Approximate token budget for the conversation sent to the model. 0 (default) sizes it automatically from the model's known context window. Set a positive number to pin it. Once exceeded, older turns are compacted/trimmed so long sessions don't fail with a context-length error.",
```

- [ ] **Step 7: Compile and run all suites (including the new one)**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json`, then the six existing scripts plus `node extensions/openvs-chat/scripts/test-context-window.mjs`.
Expected: 0 errors, all pass.

- [ ] **Step 8: Commit**

```bash
git add extensions/openvs-chat/src/agent/contextWindow.ts extensions/openvs-chat/src/chatViewProvider.ts extensions/openvs-chat/package.json extensions/openvs-chat/package.nls.json extensions/openvs-chat/scripts/test-context-window.mjs
git commit -m "feat(openvs-chat): model-aware context window and budget resolution"
```

---

### Task 7: Compaction module (pure, testable)

Summarize old turns into one compact user message when the conversation crosses 70% of the model's window. Pure module — the provider call is injected.

**Files:**
- Create: `extensions/openvs-chat/src/agent/compaction.ts`
- Modify: `extensions/openvs-chat/src/agent/context.ts:120` (export `dropOrphanToolResults`)
- Test: `extensions/openvs-chat/scripts/test-compaction.mjs` (new)

**Interfaces:**
- Consumes: `estimateMessagesTokens`, `dropOrphanToolResults` from `./context`; `ChatMessage` from `../providers/types`.
- Produces:
  - `shouldCompact(messages: ChatMessage[], contextWindow: number): boolean`
  - `compactMessages(messages: ChatMessage[], summarize: (messages: ChatMessage[], maxTokens: number) => Promise<string>): Promise<{ messages: ChatMessage[]; before: number; after: number; replaced: number } | undefined>`
  - `COMPACT_MARKER: string` (Tasks 8–10 use it)

- [ ] **Step 1: Export `dropOrphanToolResults`**

In `extensions/openvs-chat/src/agent/context.ts` change:

```ts
/** Removes `tool` messages whose matching assistant tool_call id is not present earlier. */
function dropOrphanToolResults(messages: ChatMessage[]): ChatMessage[] {
```

to:

```ts
/** Removes `tool` messages whose matching assistant tool_call id is not present earlier. */
export function dropOrphanToolResults(messages: ChatMessage[]): ChatMessage[] {
```

- [ ] **Step 2: Write the failing tests**

Create `extensions/openvs-chat/scripts/test-compaction.mjs`:

```js
// Standalone unit test for src/agent/compaction.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-compaction.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/agent/compaction.js', import.meta.url));
const big = n => 'x'.repeat(n);

const convo = (middleCount, middleSize) => [
	{ role: 'system', content: 'SYSTEM' },
	{ role: 'user', content: 'ORIGINAL REQUEST' },
	...Array.from({ length: middleCount }, (_, i) => ({ role: 'assistant', content: `step ${i}: ${big(middleSize)}` })),
	{ role: 'user', content: 'recent question' },
	{ role: 'assistant', content: 'recent answer' },
];

// shouldCompact: fires above 70% of the window, not below.
assert.strictEqual(m.shouldCompact(convo(2, 100), 100_000), false);
assert.strictEqual(m.shouldCompact(convo(40, 8_000), 100_000), true); // ~80k tokens > 70k

// compactMessages: middle replaced by one summary turn; head and recent tail intact.
{
	const messages = convo(20, 4_000);
	const seen = [];
	const res = await m.compactMessages(messages, async (msgs, maxTokens) => {
		seen.push({ count: msgs.length, maxTokens });
		return 'THE SUMMARY';
	});
	assert.ok(res, 'compaction produced a result');
	assert.strictEqual(res.messages[0].content, 'SYSTEM');
	assert.strictEqual(res.messages[1].content, 'ORIGINAL REQUEST');
	const summaryMsg = res.messages[2];
	assert.strictEqual(summaryMsg.role, 'user');
	assert.ok(summaryMsg.content.startsWith(m.COMPACT_MARKER), 'summary carries the marker');
	assert.ok(summaryMsg.content.includes('THE SUMMARY'));
	// The last 6 original turns survive verbatim.
	assert.deepStrictEqual(res.messages.slice(3), messages.slice(-6));
	assert.ok(res.before > res.after, 'token estimate shrank');
	assert.strictEqual(res.replaced, messages.length - 2 - 6);
	// The summarizer saw the compactable turns plus the instruction, with a small budget.
	assert.strictEqual(seen.length, 1);
	assert.ok(seen[0].maxTokens <= 2_000);
}

// Too little middle to compact → undefined (never loops on its own summary).
assert.strictEqual(await m.compactMessages(convo(2, 100), async () => 'S'), undefined);

// Summarizer failure or empty summary → undefined (caller falls back to trimming).
assert.strictEqual(await m.compactMessages(convo(20, 4_000), async () => { throw new Error('boom'); }), undefined);
assert.strictEqual(await m.compactMessages(convo(20, 4_000), async () => '   '), undefined);

// Orphaned tool results at the keep-boundary are dropped, not sent.
{
	const messages = [
		{ role: 'system', content: 'SYSTEM' },
		{ role: 'user', content: 'REQ' },
		...Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: big(4_000) + i })),
		// Tail starts with tool results whose calls sit in the compacted region.
		{ role: 'tool', content: 'orphan result', toolCallId: 'call-1' },
		{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
		{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
		{ role: 'user', content: 'q3' },
	];
	const res = await m.compactMessages(messages, async () => 'S');
	assert.ok(res);
	assert.ok(!res.messages.some(x => x.role === 'tool'), 'orphan tool result dropped');
}

console.log('test-compaction: all assertions passed');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-compaction.mjs`
Expected: FAIL — cannot find `../out/agent/compaction.js`.

- [ ] **Step 4: Implement the module**

Create `extensions/openvs-chat/src/agent/compaction.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage } from '../providers/types';
import { dropOrphanToolResults, estimateMessagesTokens } from './context';

/**
 * Conversation auto-compaction. Trimming (context.ts) is a lossy emergency valve —
 * it blanks old tool output and drops turns once the budget is already blown.
 * Compaction runs *before* that point: when the conversation crosses a share of the
 * model's context window, the old middle turns are replaced by a model-written
 * summary, preserving the task state in far fewer tokens.
 */

/** Share of the model's context window at which compaction kicks in. */
export const COMPACT_TRIGGER = 0.7;

/** Recent turns always kept verbatim — they carry the working state. */
const KEEP_RECENT_TURNS = 6;

/** Below this many compactable turns, a summary would cost more than it saves. */
const MIN_COMPACTABLE = 4;

/** Response budget for the summary itself. */
const SUMMARY_MAX_TOKENS = 1_500;

/** Prefix of the synthetic turn that replaces compacted history. */
export const COMPACT_MARKER = '[Conversation summary — earlier turns were compacted]';

const SUMMARY_PROMPT =
	'Summarize the conversation above for your own future reference; older turns will be ' +
	'replaced by this summary. Structure it as:\n' +
	'## Goal\n## Decisions & findings\n## Files read or changed (exact paths)\n' +
	'## Verification state (commands run, results)\n## Pending work\n' +
	'Be specific, keep exact paths and identifiers, stay under 400 words. Output only the summary.';

/** True when `messages` exceed the compaction share of `contextWindow` (estimated). */
export function shouldCompact(messages: ChatMessage[], contextWindow: number): boolean {
	return contextWindow > 0 && estimateMessagesTokens(messages) > contextWindow * COMPACT_TRIGGER;
}

/**
 * Replaces the compactable middle of `messages` (everything between the first user
 * turn and the last {@link KEEP_RECENT_TURNS}) with one summary turn produced by
 * `summarize`. Returns undefined when there is too little to compact or the
 * summarizer fails/returns nothing — callers then fall back to plain trimming.
 */
export async function compactMessages(
	messages: ChatMessage[],
	summarize: (messages: ChatMessage[], maxTokens: number) => Promise<string>,
): Promise<{ messages: ChatMessage[]; before: number; after: number; replaced: number } | undefined> {
	const firstUser = messages.findIndex(m => m.role === 'user');
	if (firstUser === -1) {
		return undefined;
	}
	const start = firstUser + 1;
	const end = messages.length - KEEP_RECENT_TURNS;
	if (end - start < MIN_COMPACTABLE) {
		return undefined;
	}
	let summary: string;
	try {
		summary = (await summarize(
			[...messages.slice(0, end), { role: 'user', content: SUMMARY_PROMPT }],
			SUMMARY_MAX_TOKENS,
		)).trim();
	} catch {
		return undefined;
	}
	if (!summary) {
		return undefined;
	}
	const compacted = dropOrphanToolResults([
		...messages.slice(0, start),
		{ role: 'user', content: `${COMPACT_MARKER}\n\n${summary}` },
		...messages.slice(end),
	]);
	return {
		messages: compacted,
		before: estimateMessagesTokens(messages),
		after: estimateMessagesTokens(compacted),
		replaced: end - start,
	};
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-compaction.mjs && node extensions/openvs-chat/scripts/test-context.mjs`
Expected: PASS (context suite still green after the export change).

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/agent/compaction.ts extensions/openvs-chat/src/agent/context.ts extensions/openvs-chat/scripts/test-compaction.mjs
git commit -m "feat(openvs-chat): conversation compaction module with 70% window trigger"
```

---

### Task 8: Auto-compaction inside the agent loop

Long agent runs are where conversations actually outgrow the window mid-flight. Before each step, compact when past 70% of the model's window; notify the user via the existing note channel.

**Files:**
- Modify: `extensions/openvs-chat/src/agent/agentRunner.ts` (imports, `AgentOptions`, constructor, `run` loop, new private method)
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:989-992` and `:1027-1030` (pass `contextWindow`)
- Modify: `extensions/openvs-chat/src/auto/orchestrator.ts:219` and `:287` (pass `contextWindow`)
- Test: `extensions/openvs-chat/scripts/test-agent-loop.mjs` (append)

**Interfaces:**
- Consumes: `shouldCompact`, `compactMessages` (Task 7); `contextWindowFor` (Task 6); `stripThinking` (Task 1).
- Produces: `AgentOptions.contextWindow?: number` — when set, the runner compacts at 70% of it.

- [ ] **Step 1: Write the failing test**

Open `extensions/openvs-chat/scripts/test-agent-loop.mjs`. It already stubs the `vscode` module via `Module._load` at the top (so `workspaceFolders: []` makes any real tool execution a harmless "No workspace folder is open" error result) and defines `fakeProvider(steps)`, `approver`, `params`, and `noopCallbacks()`. Reuse those — do not redefine them. Append:

```js
// Auto-compaction: when the conversation passes 70% of contextWindow, the runner
// summarizes old turns via streamChat before the next step.
{
	const big = 'x'.repeat(60_000); // ~15k estimated tokens per message
	let streamChatCalls = 0;
	const stepsSeen = [];
	// Built on the file's fakeProvider shape, plus a streamChat the compactor can call.
	const provider = {
		...fakeProvider([]),
		async streamChat(request) {
			streamChatCalls++;
			request.onToken('SUMMARY OF OLD TURNS');
			return { truncated: false };
		},
		async runAgentStep(request) {
			stepsSeen.push(request.messages);
			return { content: 'done', toolCalls: [], truncated: false };
		},
	};
	// contextWindow 50_000 → trigger at 35k estimated tokens; the two big seed turns cross it.
	const runner = new AgentRunner(provider, approver, 10, {
		readOnly: true,
		contextWindow: 50_000,
		maxContextTokens: 1_000_000, // keep trimming out of the way so compaction is what's tested
	});
	const cb = noopCallbacks();
	const seed = [
		{ role: 'system', content: 'SYS' },
		{ role: 'user', content: 'GOAL' },
		{ role: 'assistant', content: big },
		{ role: 'assistant', content: big },
		{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
		{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
		{ role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
	];
	const result = await runner.run(seed, params, cb);
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(streamChatCalls, 1, 'summarizer ran exactly once');
	assert.ok(cb.notes.some(n => n.includes('Compacted')), 'user was told about the compaction');
	// The first model step already saw the compacted conversation: summary marker present, big turns gone.
	const firstStep = stepsSeen[0];
	assert.ok(firstStep.some(msg => msg.content.includes('SUMMARY OF OLD TURNS')));
	assert.ok(!firstStep.some(msg => msg.content.length >= 60_000));
}
```

Note: if the suite's existing fakes use different field spellings, mirror the file's own conventions — the assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-agent-loop.mjs`
Expected: FAIL — `streamChatCalls` is 0 / no `Compacted` note.

- [ ] **Step 3: Implement in `AgentRunner`**

In `extensions/openvs-chat/src/agent/agentRunner.ts`:

Add imports:

```ts
import { compactMessages, shouldCompact } from './compaction';
import { stripThinking } from '../persona/thinking';
```

Extend `AgentOptions` (after `maxContextTokens`):

```ts
	/** Model context window in tokens; enables auto-compaction at 70% of it. 0/absent disables compaction. */
	contextWindow?: number;
```

Add the field and constructor line:

```ts
	private readonly contextWindow: number;
```

```ts
		this.contextWindow = opts?.contextWindow ?? 0;
```

In `run`, immediately after the steering-drain loop (after the `for (const note of this.steering?.() ?? [])` block) and before `callbacks.onStepStart();`, insert:

```ts
			// Compact ahead of the hard budget: replace old middle turns with a summary
			// once past the trigger share of the model's window, so the model keeps a
			// coherent task memory instead of trim markers.
			if (this.contextWindow && shouldCompact(messages, this.contextWindow)) {
				const compacted = await this.compact(messages, params);
				if (compacted) {
					messages.splice(0, messages.length, ...compacted.messages);
					callbacks.onNote(`Compacted the conversation (~${Math.round(compacted.before / 1000)}k → ~${Math.round(compacted.after / 1000)}k tokens).`);
				}
			}
```

Add the private method after `step`:

```ts
	/** Runs the summarizer through the same provider/model; failures return undefined so the run falls back to trimming. */
	private async compact(messages: ChatMessage[], params: AgentParams) {
		return compactMessages(messages, async (toSummarize, maxTokens) => {
			let text = '';
			await this.provider.streamChat({
				messages: toSummarize,
				model: params.model,
				apiKey: params.apiKey,
				baseUrl: params.baseUrl,
				maxTokens,
				signal: params.signal,
				onToken: delta => { text += delta; },
			});
			// Reasoning models stream their chain of thought through onToken too;
			// the stored summary must not carry it.
			return stripThinking(text);
		});
	}
```

- [ ] **Step 4: Pass `contextWindow` from the call sites**

`extensions/openvs-chat/src/chatViewProvider.ts` — both runner constructions gain one line:

`runReadOnlyAgent` (line ~989):

```ts
		const runner = new AgentRunner(provider, this, Math.min(configured, 8), {
			readOnly: true,
			maxContextTokens: this.configuredContextTokens(params.model, params.maxTokens),
			contextWindow: contextWindowFor(params.model),
		});
```

`runAgent` (line ~1027): add the same `contextWindow: contextWindowFor(params.model),` line to its options object.

`extensions/openvs-chat/src/auto/orchestrator.ts` — add the import:

```ts
import { contextWindowFor } from '../agent/contextWindow';
```

At line 219 and 287 the surrounding code resolves a model for the phase (the variable holding the model id is in scope right where the runner is built — at 219 it is the implement-phase attempt's model, at 287 the same for the decomposed step). Extend both option objects:

```ts
			const runner = new AgentRunner(provider, this.approver, this.maxSteps, { mcp: this.mcp, contextWindow: contextWindowFor(attempt.model) });
```

```ts
			const runner = new AgentRunner(provider, this.approver, this.maxSteps, { budget, mcp: this.mcp, contextWindow: contextWindowFor(attempt.model) });
```

(If the in-scope variable is named differently than `attempt.model` at either site, use the local name that carries the model id being passed to `runner.run`'s params.)

- [ ] **Step 5: Run tests**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json && node extensions/openvs-chat/scripts/test-agent-loop.mjs` then the other suites.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/agent/agentRunner.ts extensions/openvs-chat/src/chatViewProvider.ts extensions/openvs-chat/src/auto/orchestrator.ts extensions/openvs-chat/scripts/test-agent-loop.mjs
git commit -m "feat(openvs-chat): auto-compact agent conversations at 70% of model window"
```

---

### Task 9: Send-time history compaction (Ask/Plan and run seeds)

The webview re-sends the whole transcript every send. Compact the incoming history host-side before dispatch when it crosses the trigger, and tell the webview (Task 10) so it persists instead of re-compacting every turn.

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts` (`handleSend`, new private method, `HostToWebview` union)

**Interfaces:**
- Consumes: `shouldCompact`, `compactMessages`, `COMPACT_MARKER` (Task 7); `contextWindowFor` (Task 6).
- Produces: webview message `{ type: 'compacted', sessionId, runId, summary: string, replaced: number }` — `replaced` counts messages replaced from the START of the history array exactly as the webview sent it. Task 10 consumes this.

- [ ] **Step 1: Add the message type**

In `extensions/openvs-chat/src/chatViewProvider.ts`, find the `HostToWebview` (or equivalently named) union of `post` message shapes and add:

```ts
	| { type: 'compacted'; summary: string; replaced: number }
```

(the session/run envelope fields are added by `sessionPost` exactly as for other members — match the union's existing member style).

- [ ] **Step 2: Add imports and the compaction method**

Extend the existing imports:

```ts
import { COMPACT_MARKER, compactMessages, shouldCompact } from './agent/compaction';
```

Add the private method near `sanitizeHistory`:

```ts
	/**
	 * Compacts an oversized incoming history before dispatch: old turns are replaced by
	 * a model-written summary and the webview is told to persist the replacement, so
	 * the next send arrives already compacted instead of paying the summary again.
	 */
	private async compactHistory(
		provider: ChatProvider,
		history: ChatMessage[],
		params: { model: string; apiKey: string; baseUrl: string; signal: AbortSignal },
		post: SessionPost,
	): Promise<ChatMessage[]> {
		if (!shouldCompact(history, contextWindowFor(params.model))) {
			return history;
		}
		const res = await compactMessages(history, async (toSummarize, maxTokens) => {
			let text = '';
			await provider.streamChat({
				messages: toSummarize,
				model: params.model,
				apiKey: params.apiKey,
				baseUrl: params.baseUrl,
				maxTokens,
				signal: params.signal,
				onToken: delta => { text += delta; },
			});
			return stripThinking(text);
		});
		if (!res) {
			return history;
		}
		const summaryMsg = res.messages.find(m => m.content.startsWith(COMPACT_MARKER));
		post({ type: 'compacted', summary: summaryMsg?.content ?? '', replaced: res.replaced });
		post({ type: 'info', message: `Compacted ${res.replaced} earlier message(s) (~${Math.round(res.before / 1000)}k → ~${Math.round(res.after / 1000)}k tokens).` });
		return res.messages;
	}
```

- [ ] **Step 3: Call it in `handleSend`**

In `handleSend` (line ~764), after the sanitize line from Task 1, change:

```ts
			const history: ChatMessage[] = this.sanitizeHistory(message.messages ?? []);
```

to:

```ts
			const history: ChatMessage[] = await this.compactHistory(
				provider,
				this.sanitizeHistory(message.messages ?? []),
				{ model, apiKey: apiKey ?? '', baseUrl: params.baseUrl, signal: controller.signal },
				post,
			);
```

Note: `params` is declared above the `try` block and `controller` just after it — this line sits inside the `try`, both are in scope. `history` here is what the webview sent — no system prompt/context yet — so `compactMessages`'s "first user turn" anchor is the conversation's original request, which is exactly right.

(Leave `handleAutoSend` with sanitize-only: its agent path compacts inside the runner via Task 8, and its streaming path history is identical in shape — adding it there later is a two-line change, but Auto resolves providers per-role after this point, so it is out of scope for this task.)

- [ ] **Step 4: Compile and run suites**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` then all suites.
Expected: 0 errors, all pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "feat(openvs-chat): compact oversized history at send time with webview notification"
```

---

### Task 10: Webview persists compaction

Store the summary + how many transcript messages it supersedes; send only the summary + the tail from then on. Display stays untouched.

**Files:**
- Modify: `extensions/openvs-chat/media/main.js` (session shape, send payload at line ~1327, stream-type list at line ~1677, message handler switch, `saveState`/restore at lines ~165 and ~187)

**Interfaces:**
- Consumes: `{ type: 'compacted', summary, replaced }` from Task 9. `replaced` counts from the start of the last-sent payload; the payload's first element is the synthetic summary message whenever one exists.

- [ ] **Step 1: Extend the session shape and persistence**

In `media/main.js` (preserve its UTF-16 encoding):

Update the `Session` typedef (line ~31) to add `compactSummary` and `compactedUpTo`:

```js
	 * @typedef {{ id: string, title: string, messages: Msg[], streaming: boolean, pending: string|null, queue: string[], runMode?: string, compactSummary?: string, compactedUpTo?: number }} Session
```

In `saveState` (line ~187) persist them:

```js
			sessions: sessions.map(s => ({ id: s.id, title: s.title, messages: s.messages, queue: s.queue, compactSummary: s.compactSummary, compactedUpTo: s.compactedUpTo })),
```

In the restore path (line ~165) carry them back:

```js
				messages: Array.isArray(s.messages) ? s.messages : [],
				compactSummary: typeof s.compactSummary === 'string' ? s.compactSummary : undefined,
				compactedUpTo: typeof s.compactedUpTo === 'number' ? s.compactedUpTo : 0,
```

- [ ] **Step 2: Build the send payload from summary + tail**

At line ~1327 the send currently does:

```js
			messages: s.messages.filter(m => !m.kind && !(m.role === 'assistant' && m.content === '')),
```

Add a helper near `sendText` and use it:

```js
	/** The messages actually sent as history: compacted summary (if any) + the un-compacted tail. */
	function sendableMessages(s) {
		const real = s.messages.filter(m => !m.kind && !(m.role === 'assistant' && m.content === ''));
		const tail = real.slice(s.compactedUpTo || 0);
		return s.compactSummary ? [{ role: 'user', content: s.compactSummary }, ...tail] : tail;
	}
```

and replace the payload line with:

```js
			messages: sendableMessages(s),
```

- [ ] **Step 3: Handle the `compacted` message**

Add `'compacted'` to the chat-stream type list at line ~1677 (the array containing `'token', 'agentStepStart', …`).

In the message-handler switch (same block as `agentStepEnd`/`toolEnd`), add:

```js
			case 'compacted': {
				const s = sessionFor(msg);
				if (!s) { break; }
				// `replaced` counts from the start of what we last sent; if that payload led
				// with a previous summary message, it is included in the count and is not a
				// transcript message.
				const hadSummary = s.compactSummary ? 1 : 0;
				s.compactedUpTo = (s.compactedUpTo || 0) + Math.max(0, (msg.replaced || 0) - hadSummary);
				s.compactSummary = typeof msg.summary === 'string' && msg.summary ? msg.summary : s.compactSummary;
				saveState();
				break;
			}
```

- [ ] **Step 4: Reset on clear**

At line ~1370 (`s.messages = [];` — the clear-conversation path) also reset:

```js
		s.messages = [];
		s.compactSummary = undefined;
		s.compactedUpTo = 0;
```

Also in the two places a fresh session object is constructed (lines ~175/181 and ~451, plus the history-restore at ~533), no change is required beyond Step 1's restore mapping — new sessions simply have the fields undefined/0.

- [ ] **Step 5: Manual verification (no unit harness for the webview)**

Compile: `npx tsc -p extensions/openvs-chat/tsconfig.json` (host unchanged — should stay green).
Launch Extension Development Host (`F5`), then:
1. Set `openvsChat.agent.maxContextTokens` to `0` (auto) and chat with any model until the transcript is large (or temporarily set a small pinned budget to force it).
2. Confirm the "Compacted N earlier message(s)…" info line appears once.
3. Send another message; confirm no second compaction of the same turns (host log/notice appears only when the *new* tail outgrows the trigger again).
4. Reload the window; confirm the session restores and still sends compacted history (watch the notice not re-appear).

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/media/main.js
git commit -m "feat(openvs-chat): webview persists compacted history across sends"
```

---

### Task 11: Anthropic prompt caching

Every agent step re-bills the full system prompt + history at full input price. Two `cache_control` breakpoints (system, last message block) cut cached-input cost ~90% on Claude loops. No behavior change.

**Files:**
- Modify: `extensions/openvs-chat/src/providers/anthropic.ts` (`AnthropicBlock` type line ~237, `buildSystem` line ~221, both request bodies lines ~80-86 and ~145-156)

- [ ] **Step 1: Extend the block type**

Replace:

```ts
type AnthropicBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string };
```

with:

```ts
type CacheControl = { cache_control?: { type: 'ephemeral' } };
type AnthropicBlock = CacheControl & (
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string });
```

- [ ] **Step 2: Cache the system prompt**

Replace `buildSystem`:

```ts
function buildSystem(system: string, oauth: boolean): string | { type: 'text'; text: string }[] | undefined {
	if (!oauth) {
		return system || undefined;
	}
	const blocks: { type: 'text'; text: string }[] = [{ type: 'text', text: CLAUDE_CODE_SYSTEM }];
	if (system) {
		blocks.push({ type: 'text', text: system });
	}
	return blocks;
}
```

with:

```ts
function buildSystem(system: string, oauth: boolean): ({ type: 'text'; text: string } & CacheControl)[] | undefined {
	const blocks: ({ type: 'text'; text: string } & CacheControl)[] = [];
	if (oauth) {
		blocks.push({ type: 'text', text: CLAUDE_CODE_SYSTEM });
	}
	if (system) {
		blocks.push({ type: 'text', text: system });
	}
	if (!blocks.length) {
		return undefined;
	}
	// One breakpoint after the system prompt: tools + system form a stable prefix
	// the API can serve from cache on every subsequent step of a run.
	blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
	return blocks;
}
```

(Non-OAuth callers previously got a plain string; an array of text blocks is equally valid for the API, so both call sites keep working unchanged.)

- [ ] **Step 3: Cache the conversation prefix**

Add after `toAnthropicMessages`:

```ts
/**
 * Marks the final content block as a cache breakpoint, so the whole conversation up
 * to this request is a cache hit on the next step (the API caches the longest
 * previously-seen prefix; the moving breakpoint extends it step by step).
 */
function withCacheBreakpoint(msgs: AnthropicMsg[]): AnthropicMsg[] {
	const last = msgs[msgs.length - 1];
	const block = last?.content[last.content.length - 1];
	if (block) {
		block.cache_control = { type: 'ephemeral' };
	}
	return msgs;
}
```

In `streamChat`'s body change `messages: toAnthropicMessages(messages),` to `messages: withCacheBreakpoint(toAnthropicMessages(messages)),` — and the same in `runAgentStep`.

- [ ] **Step 4: Compile and run suites**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` then all suites.
Expected: 0 errors, all pass.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/providers/anthropic.ts
git commit -m "feat(openvs-chat): anthropic prompt caching via cache_control breakpoints"
```

---

### Task 12: Final verification pass

**Files:** none new.

- [ ] **Step 1: Full extension compile**

Run: `npm run gulp compile-extensions`
Expected: 0 errors.

- [ ] **Step 2: All test suites**

Run all seven scripts (six existing + `test-context-window.mjs` + `test-compaction.mjs` = eight total).
Expected: every script prints its "all assertions passed" line.

- [ ] **Step 3: Extension Dev Host smoke test (user-driven, list for hand-off)**

1. Ask mode with several tabs open → only the active file attaches by default.
2. Agent mode: model reads a >48k-char file → paged result with the offset note; model successfully pages.
3. Noisy build command → head+tail capped output, error at tail visible.
4. Long agent run past 70% of a small model's window → "Compacted the conversation…" notice, run continues coherently.
5. Long Ask conversation → send-time compaction notice once, then not again on the next send, and it survives a window reload.
6. Claude via Anthropic key: second agent step visibly faster/cheaper (cache hit — check API console usage if available).

- [ ] **Step 4: Commit any stragglers, push for review**

```bash
git status
git push -u origin feat/replace-copilot-with-openvs-chat
```

---

### Task 13: Collapse tool results to a one-line gist

A `read_file` call currently dumps up to 4,000 characters of file content straight into the chat transcript, burying the conversation. The full text stays available behind a native disclosure; the default view becomes one line. Display-only — what is sent to the model is unchanged.

**Files:**
- Modify: `extensions/openvs-chat/media/main.js` (`appendToolEl`, the `toolEnd` case, new `summarizeToolResult`)
- Modify: `extensions/openvs-chat/media/main.css` (`.tool-summary` rules near the existing `.tool-out` block at ~line 720)

- [ ] **Step 1: Wrap the tool output in a disclosure**

In `media/main.js` (preserve its UTF-16 encoding), replace `appendToolEl`:

```js
	function appendToolEl(name, args) {
		const wrap = document.createElement('div');
		wrap.className = 'tool running';
		const head = document.createElement('div');
		head.className = 'tool-head';
		head.textContent = `🔧 ${name}(${summarizeArgs(args)})`;
		const details = document.createElement('details');
		const summary = document.createElement('summary');
		summary.className = 'tool-summary';
		summary.textContent = 'running…';
		const out = document.createElement('pre');
		out.className = 'tool-out';
		details.appendChild(summary);
		details.appendChild(out);
		wrap.appendChild(head);
		wrap.appendChild(details);
		els.messages.appendChild(wrap);
		scrollToBottom();
		return { wrap, out, details, summary };
	}
```

- [ ] **Step 2: Add the gist function**

Directly after `summarizeArgs` in `media/main.js`:

```js
	/**
	 * One-line gist of a tool result. The full text stays one click away; a transcript
	 * that inlines every file the agent read is unreadable.
	 */
	function summarizeToolResult(name, result, isError) {
		const text = String(result);
		if (isError) {
			return text.split('\n')[0].slice(0, 120);
		}
		const lines = text.split('\n').length;
		if (name === 'read_file') {
			return `Read ${lines} line${lines === 1 ? '' : 's'}`;
		}
		if (name === 'list_dir') {
			return `${lines} ${lines === 1 ? 'entry' : 'entries'}`;
		}
		if (name === 'search_files') {
			return `${lines} match${lines === 1 ? '' : 'es'}`;
		}
		// write_file/edit_file confirmations are already a single short line.
		return lines === 1 && text.length <= 120 ? text : `${lines} line${lines === 1 ? '' : 's'} of output`;
	}
```

- [ ] **Step 3: Fill the gist on completion**

In the `toolEnd` case, replace the block that sets the output:

```js
			if (t) {
				t.wrap.classList.remove('running');
				t.wrap.classList.toggle('tool-error', !!msg.isError);
				t.out.textContent = String(msg.result).slice(0, 4000);
				toolEls.delete(key);
				scrollToBottom();
			}
```

with:

```js
			if (t) {
				t.wrap.classList.remove('running');
				t.wrap.classList.toggle('tool-error', !!msg.isError);
				t.out.textContent = String(msg.result).slice(0, 4000);
				t.summary.textContent = summarizeToolResult(msg.name, msg.result, msg.isError);
				// Failures stay open: an error the user has to click to discover is a bug report waiting to happen.
				t.details.open = !!msg.isError;
				toolEls.delete(key);
				scrollToBottom();
			}
```

- [ ] **Step 4: Style the summary line**

In `media/main.css`, immediately after the existing `.tool-out { … }` rule:

```css
.tool-summary {
	font-size: 0.85em; cursor: pointer; opacity: 0.8;
	user-select: none;
}
.tool-summary:hover { opacity: 1; }
details[open] > .tool-summary { margin-bottom: 4px; }
```

- [ ] **Step 5: Verify**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json` (host untouched — must stay clean).
Manual, in the Extension Development Host: run an Agent task that reads a file, lists a directory, searches, and runs a failing command. Confirm each tool block shows one summary line; clicking expands the full output; the failing command's block is already expanded.

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/media/main.js extensions/openvs-chat/media/main.css
git commit -m "feat(openvs-chat): collapse tool results to a one-line gist"
```

---

## Self-Review Notes

- **Spec coverage:** request-side waste (Tasks 1–5), response-side limits already exist (`maxTokens` + `CONCISE` — no change needed), model-aware budget (Task 6), 70%-auto-compaction (Tasks 7–10), cost polish (Task 11), verification (Task 12). The audit's "debug token log" nice-to-have was dropped — YAGNI; the compaction notices already surface token counts where it matters.
- **Type consistency:** `configuredContextTokens(model, maxTokens)` signature change (Task 6) is consumed as updated in Tasks 8–9; `contextWindow` option name is identical in Tasks 8 (definition) and 8's call sites; `COMPACT_MARKER`/`replaced` contract is shared verbatim between Tasks 7, 9, 10.
- **Known judgment calls:** Auto streaming path gets sanitize but not send-time compaction (Task 9 note); `media/main.js` has no unit harness — Task 10 verification is manual by design; Task 8's test may need fake-provider field spellings aligned with the suite's existing conventions.
