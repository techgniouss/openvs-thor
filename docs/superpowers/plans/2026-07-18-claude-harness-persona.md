# Claude-Harness Persona Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make openvs-chat behave like Claude Code on any backing model: layered Claude-style system prompts, auto-injected environment snapshot, universal `<thinking>` scaffold, and live todo tracking in Agent mode.

**Architecture:** New pure-logic module `extensions/openvs-chat/src/persona/` (prompts, thinking parser, todo reducer, env snapshot). `chatViewProvider.ts` and `agent/agentRunner.ts` call into it; guardrails untouched. Thinking is reformatted into the existing inline `🤔 *Thinking…* … ---` markdown convention (there is no separate reasoning channel — see `openaiCompatible.ts:101-128`). Todos are the only webview change.

**Tech Stack:** TypeScript (VS Code extension host), vanilla JS webview (`media/main.js`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-18-claude-harness-persona-design.md`

## Global Constraints

- Tabs, not spaces. Single quotes except localized user-facing strings.
- Every new file starts with the OpenVS copyright header (copy from `src/agent/tools.ts:1-4`).
- No `any`/`unknown` unless unavoidable; JSDoc on exported functions/interfaces.
- Arrow functions over anonymous function expressions; `export function` over `export const` fns.
- Env snapshot hard caps: ≤1500 chars total, git status ≤20 lines, cache ~30 s.
- Typecheck gate after every code task: `npx tsc -p extensions/openvs-chat/tsconfig.json --noEmit` from repo root — must print nothing.
- Unit tests are standalone node scripts under `extensions/openvs-chat/scripts/` run against compiled `out/`; compile with `npx tsc -p extensions/openvs-chat/tsconfig.json` first (emits to `extensions/openvs-chat/out/`).
- Commit after each task with the message given in the task.

---

### Task 1: Prompt pack — `src/persona/prompts.ts`

**Files:**
- Create: `extensions/openvs-chat/src/persona/prompts.ts`
- Create: `extensions/openvs-chat/scripts/test-persona-prompts.mjs`

**Interfaces:**
- Produces: `personaBase(env: string, userBase: string): string`, `modeDoctrine(mode: PersonaMode, opts: ModeOptions): string`, `SUBAGENT_PREAMBLE: string`, `type PersonaMode = 'ask' | 'plan' | 'agent' | 'edit'`, `interface ModeOptions { inline?: boolean; readTools?: boolean }`. Consumed by Tasks 5, 6, 7.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-persona-prompts.mjs`:

```js
// Standalone unit test for src/persona/prompts.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-prompts.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/persona/prompts.js', import.meta.url));

// personaBase layers: identity first, env section when present, user base last.
const base = m.personaBase('cwd: /repo\nbranch: main', 'User custom rules');
assert.ok(base.startsWith('You are Thor'), 'identity must lead');
assert.ok(base.includes('# Environment'), 'env section present');
assert.ok(base.indexOf('# Environment') < base.indexOf('User custom rules'), 'user base after env');

// Empty env / empty user base: sections omitted, no double blank-line artifacts.
const bare = m.personaBase('', '');
assert.ok(bare.startsWith('You are Thor'));
assert.ok(!bare.includes('# Environment'));
assert.ok(!/\n{3,}/.test(bare), 'no triple newlines');

// Mode doctrines.
const agent = m.modeDoctrine('agent', {});
assert.ok(/AGENT mode/.test(agent));
assert.ok(/update_todos/.test(agent), 'agent doctrine references todo tool');
assert.ok(/<thinking>/.test(agent), 'agent doctrine includes thinking scaffold');
assert.ok(/verify/i.test(agent), 'agent doctrine demands verification');

const plan = m.modeDoctrine('plan', { readTools: true });
assert.ok(/PLAN mode/.test(plan));
assert.ok(/read_file/.test(plan), 'plan mentions read tools when readTools');
assert.ok(!/update_todos/.test(plan), 'no todo doctrine outside agent');

const planNoTools = m.modeDoctrine('plan', {});
assert.ok(!/read_file/.test(planNoTools));

const ask = m.modeDoctrine('ask', { readTools: true });
assert.ok(/ASK mode/.test(ask));
assert.ok(/<thinking>/.test(ask));

// Edit: no thinking scaffold (would corrupt code-block extraction), inline vs whole-file.
const editInline = m.modeDoctrine('edit', { inline: true });
assert.ok(/EDIT mode/.test(editInline));
assert.ok(!/<thinking>/.test(editInline), 'edit must not include thinking scaffold');
assert.ok(/selection/i.test(editInline));
const editFile = m.modeDoctrine('edit', {});
assert.ok(/COMPLETE updated file/i.test(editFile));

// Subagent preamble exists and carries the identity discipline.
assert.ok(m.SUBAGENT_PREAMBLE.includes('evidence'), 'subagent preamble carries evidence discipline');

console.log('test-persona-prompts: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run (repo root):
```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-prompts.mjs
```
Expected: FAIL — `Cannot find module '.../out/persona/prompts.js'`.

- [ ] **Step 3: Write the implementation**

Create `extensions/openvs-chat/src/persona/prompts.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Chat mode as seen by the persona prompt pack (mirrors ChatMode in chatViewProvider). */
export type PersonaMode = 'ask' | 'plan' | 'agent' | 'edit';

/** Options that vary a mode's doctrine. */
export interface ModeOptions {
	/** Edit mode: operating on an inline selection rather than a whole file. */
	inline?: boolean;
	/** Ask/Plan: the model has the read-only tool loop (read_file/list_dir/search_files). */
	readTools?: boolean;
}

/**
 * The identity and communication doctrine every request starts with, modeled on how
 * Claude Code presents itself: evidence-first, outcome-first, honest about failure.
 */
const IDENTITY = `You are Thor, the OpenVS coding agent — a senior software engineer working inside the user's editor.

Core discipline:
- Ground every claim in evidence: only describe code you have actually read. Never invent file contents, APIs, or behavior. If you are unsure, say so and check.
- Lead with the outcome. No preamble, no flattery, no filler, and do not restate the question.
- Report failures honestly: quote the actual error or output. Never claim something works without having verified it.
- Reference code as \`path:line\` so the user can jump to it. Respond in GitHub-flavored markdown.
- Prefer tight prose over padded lists; give short answers to simple questions.
- When you write or edit code, match the file's existing style, naming, and comment density. Do not add comments that explain the change itself — the code must stand on its own.`;

/**
 * Universal reasoning scaffold: models without native hidden reasoning are told to think
 * in tags. The thinking stream parser (persona/thinking.ts) reformats the tags into the
 * same inline "🤔 Thinking…" rendering that native reasoning models already get.
 */
const THINKING = `Before answering or acting, reason briefly inside <thinking>…</thinking>: what is actually being asked, what you must look at, and your approach. Keep it under 150 words. The final answer goes OUTSIDE the tags — never inside. Close the tag before your answer. If your model already reasons natively (hidden chain of thought), skip the tags entirely.`;

/** Agent-mode task tracking doctrine (the update_todos tool is registered in Agent mode). */
const TASKS = `Task tracking: for any task that takes 3 or more steps, first call update_todos with the full checklist (short, outcome-shaped items). Keep exactly one item in_progress at a time, and update the list the moment an item completes — never batch updates. If the plan changes, rewrite the list.`;

/**
 * Composes the head of the system prompt: identity, then the environment snapshot,
 * then the user's own configured base prompt. Rules and skills are appended by the
 * caller (ChatViewProvider.baseSystem) exactly as before.
 */
export function personaBase(env: string, userBase: string): string {
	const parts = [IDENTITY];
	if (env.trim()) {
		parts.push(`# Environment\n${env.trim()}`);
	}
	if (userBase.trim()) {
		parts.push(userBase.trim());
	}
	return parts.join('\n\n');
}

/**
 * The per-mode doctrine appended after the base prompt. Replaces the former one-line
 * mode suffixes in ChatViewProvider.buildSystemPrompt.
 */
export function modeDoctrine(mode: PersonaMode, opts: ModeOptions): string {
	if (mode === 'edit') {
		if (opts.inline) {
			return 'EDIT mode on a code selection. Return ONLY the revised code for the selection in one fenced block — no surrounding file, no commentary outside it. Preserve the file\'s indentation style exactly.';
		}
		return 'EDIT mode. The user gives a file; return the COMPLETE updated file in one fenced block, no commentary outside it unless asked. Preserve parts of the file you are not changing byte-for-byte.';
	}
	if (mode === 'agent') {
		return [
			`AGENT mode — you own the task end to end, with tools to read, list and search files, write and edit files, and run commands.`,
			`Work as a loop: understand → plan → execute → verify.`,
			`- Never guess a file path: locate code with search_files or list_dir, and read_file before you edit. Never edit a file you have not read in this run.`,
			`- Prefer edit_file (targeted replacement) over write_file; use write_file only for new files or intentional full rewrites.`,
			`- Batch independent reads together; make edits one at a time.`,
			`- After changing code, verify with run_command (typecheck, build, or tests) before declaring the task done. If verification fails, fix it — do not hand back a broken state.`,
			`- Ask the user only when genuinely blocked on a decision that is theirs to make; otherwise proceed.`,
			`- When done, summarize what changed (files and why) and how it was verified.`,
			TASKS,
			THINKING,
		].join('\n');
	}
	if (mode === 'plan') {
		const tools = opts.readTools
			? ' You have READ-ONLY tools (read_file, list_dir, search_files) — explore the real files FIRST and ground every step of the plan in what you found, naming actual paths.'
			: '';
		return `PLAN mode.${tools} Produce a concrete plan for exactly the stated requirement: goal, assumptions, ordered steps naming the files/components each touches, and risks or open questions. Do NOT write full implementations or whole files, and never claim to have made changes — you can only plan. If the request is ambiguous, state the interpretation you planned for.\n${THINKING}`;
	}
	const tools = opts.readTools
		? ' You have READ-ONLY tools (read_file, list_dir, search_files) — use them freely to open, explore, trace and debug any file, not just the ones the user has open. Trace the actual code before speculating.'
		: '';
	return `ASK mode (read-only).${tools} Answer directly, grounded in the actual code when relevant. You cannot modify files or run commands — if a change is needed, describe it and suggest switching to Agent mode.\n${THINKING}`;
}

/**
 * Identity discipline for spawned sub-agents (prefixed to their focused system prompt
 * in agentRunner.subagentSystem).
 */
export const SUBAGENT_PREAMBLE = 'Work like a senior engineer: ground every claim in evidence from files you actually read, report failures honestly with the real output, and never claim success without verifying.';
```

- [ ] **Step 4: Run test to verify it passes**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-prompts.mjs
```
Expected: `test-persona-prompts: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/persona/prompts.ts extensions/openvs-chat/scripts/test-persona-prompts.mjs
git commit -m "feat(persona): Claude-style layered prompt pack (identity, mode doctrines, thinking scaffold)"
```

---

### Task 2: Thinking stream parser — `src/persona/thinking.ts`

**Files:**
- Create: `extensions/openvs-chat/src/persona/thinking.ts`
- Create: `extensions/openvs-chat/scripts/test-persona-thinking.mjs`

**Interfaces:**
- Produces: `class ThinkingStreamParser { constructor(emit: (text: string) => void); push(delta: string): void; flush(): void }` and `formatThinking(text: string): string`. Consumed by Task 6.
- Conversion contract (matches the inline convention native reasoning models get in `openaiCompatible.ts:113-128`): `<thinking>` → `🤔 *Thinking…*\n\n`, `</thinking>` → `\n\n---\n\n`. Content between tags passes through. Unclosed tag at end of stream: `flush()` emits what was buffered so no text is ever lost.

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-persona-thinking.mjs`:

```js
// Standalone unit test for src/persona/thinking.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-thinking.mjs
import assert from 'node:assert/strict';

const { ThinkingStreamParser, formatThinking } = await import(new URL('../out/persona/thinking.js', import.meta.url));

/** Feeds deltas through a parser and returns everything it emitted. */
const run = deltas => {
	let out = '';
	const p = new ThinkingStreamParser(t => { out += t; });
	for (const d of deltas) { p.push(d); }
	p.flush();
	return out;
};

// Whole message in one delta.
assert.equal(
	run(['<thinking>plan it</thinking>Answer.']),
	'🤔 *Thinking…*\n\nplan it\n\n---\n\nAnswer.');

// Tags split across chunk boundaries (the streaming case).
assert.equal(
	run(['<thin', 'king>a', 'b</thi', 'nking>ok']),
	'🤔 *Thinking…*\n\nab\n\n---\n\nok');

// No tags: pure pass-through, byte-identical.
assert.equal(run(['hello ', 'world']), 'hello world');

// '<' that is not a thinking tag must not be swallowed (generics, HTML).
assert.equal(run(['a < b and <div>x</div>']), 'a < b and <div>x</div>');

// Unclosed tag: flush() must not lose the buffered content.
const unclosed = run(['<thinking>never closed. Answer here']);
assert.ok(unclosed.includes('never closed. Answer here'), 'unclosed content must survive flush');

// Partial open tag at end of stream flushes as literal text.
assert.equal(run(['tail <thin']), 'tail <thin');

// formatThinking: same conversion for complete (non-streamed) text.
assert.equal(
	formatThinking('<thinking>x</thinking>y'),
	'🤔 *Thinking…*\n\nx\n\n---\n\ny');
assert.equal(formatThinking('no tags'), 'no tags');

console.log('test-persona-thinking: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-thinking.mjs
```
Expected: FAIL — `Cannot find module '.../out/persona/thinking.js'`.

- [ ] **Step 3: Write the implementation**

Create `extensions/openvs-chat/src/persona/thinking.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';
const OPEN_MARK = '🤔 *Thinking…*\n\n';
const CLOSE_MARK = '\n\n---\n\n';

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagSuffix(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let len = max; len > 0; len--) {
		if (text.endsWith(tag.slice(0, len))) {
			return len;
		}
	}
	return 0;
}

/**
 * Streaming state machine that rewrites `<thinking>…</thinking>` blocks into the same
 * inline markdown convention native reasoning models already use ("🤔 *Thinking…*"
 * prefix, `---` separator — see openaiCompatible.ts). Text outside the tags passes
 * through untouched. Handles tags split across arbitrary chunk boundaries. On
 * malformed input (unclosed tag, partial tag at end of stream) `flush()` emits
 * whatever was buffered, so user-visible text is never dropped.
 */
export class ThinkingStreamParser {
	private buffer = '';
	private inThinking = false;

	constructor(private readonly emit: (text: string) => void) { }

	/** Feed one streamed delta; visible text is emitted synchronously. */
	push(delta: string): void {
		this.buffer += delta;
		for (; ;) {
			const tag = this.inThinking ? CLOSE_TAG : OPEN_TAG;
			const idx = this.buffer.indexOf(tag);
			if (idx !== -1) {
				const before = this.buffer.slice(0, idx);
				if (before) {
					this.emit(before);
				}
				this.emit(this.inThinking ? CLOSE_MARK : OPEN_MARK);
				this.inThinking = !this.inThinking;
				this.buffer = this.buffer.slice(idx + tag.length);
				continue;
			}
			// No full tag: emit everything except a trailing partial-tag candidate.
			const hold = partialTagSuffix(this.buffer, tag);
			const emitLen = this.buffer.length - hold;
			if (emitLen > 0) {
				this.emit(this.buffer.slice(0, emitLen));
				this.buffer = this.buffer.slice(emitLen);
			}
			return;
		}
	}

	/** Stream ended: emit anything still buffered (partial tags become literal text). */
	flush(): void {
		if (this.buffer) {
			this.emit(this.buffer);
			this.buffer = '';
		}
		this.inThinking = false;
	}
}

/** Applies the same tag→markdown conversion to a complete, non-streamed text. */
export function formatThinking(text: string): string {
	let out = '';
	const parser = new ThinkingStreamParser(t => { out += t; });
	parser.push(text);
	parser.flush();
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-thinking.mjs
```
Expected: `test-persona-thinking: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/persona/thinking.ts extensions/openvs-chat/scripts/test-persona-thinking.mjs
git commit -m "feat(persona): streaming <thinking> parser reusing inline reasoning rendering"
```

---

### Task 3: Todo state + tool — `src/persona/todos.ts`

**Files:**
- Create: `extensions/openvs-chat/src/persona/todos.ts`
- Create: `extensions/openvs-chat/scripts/test-persona-todos.mjs`

**Interfaces:**
- Consumes: `ToolSpec` from `../providers/types` (Task-independent, already exists).
- Produces: `type TodoStatus`, `interface TodoItem { content: string; status: TodoStatus }`, `UPDATE_TODOS_TOOL: ToolSpec` (name `update_todos`), `parseTodoUpdate(args: Record<string, unknown>): { items: TodoItem[] } | { error: string }`. Consumed by Task 7 (agentRunner + chatViewProvider) and Task 8 (webview renders the items).

- [ ] **Step 1: Write the failing test**

Create `extensions/openvs-chat/scripts/test-persona-todos.mjs`:

```js
// Standalone unit test for src/persona/todos.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-todos.mjs
import assert from 'node:assert/strict';

const { UPDATE_TODOS_TOOL, parseTodoUpdate } = await import(new URL('../out/persona/todos.js', import.meta.url));

assert.equal(UPDATE_TODOS_TOOL.name, 'update_todos');
assert.ok(UPDATE_TODOS_TOOL.description.length > 40, 'tool needs a real description');
assert.deepEqual(UPDATE_TODOS_TOOL.parameters.required, ['items']);

// Valid update.
const ok = parseTodoUpdate({ items: [
	{ content: 'Read the config', status: 'completed' },
	{ content: 'Patch the loader', status: 'in_progress' },
	{ content: 'Run typecheck', status: 'pending' },
] });
assert.ok('items' in ok);
assert.equal(ok.items.length, 3);
assert.equal(ok.items[1].status, 'in_progress');

// Empty list is valid (clears the panel).
assert.deepEqual(parseTodoUpdate({ items: [] }), { items: [] });

// Invalid shapes produce tool-level errors, never throw.
assert.ok('error' in parseTodoUpdate({}));
assert.ok('error' in parseTodoUpdate({ items: 'nope' }));
assert.ok('error' in parseTodoUpdate({ items: [{ content: '', status: 'pending' }] }));
assert.ok('error' in parseTodoUpdate({ items: [{ content: 'x', status: 'doing' }] }));
assert.ok('error' in parseTodoUpdate({ items: [{ status: 'pending' }] }));

// Content is trimmed and capped so the panel cannot be flooded.
const long = parseTodoUpdate({ items: [{ content: '  ' + 'x'.repeat(500) + '  ', status: 'pending' }] });
assert.ok('items' in long);
assert.ok(long.items[0].content.length <= 200);
assert.ok(!long.items[0].content.startsWith(' '));

console.log('test-persona-todos: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-todos.mjs
```
Expected: FAIL — `Cannot find module '.../out/persona/todos.js'`.

- [ ] **Step 3: Write the implementation**

Create `extensions/openvs-chat/src/persona/todos.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolSpec } from '../providers/types';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item of the agent's visible task checklist. */
export interface TodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MAX_ITEMS = 30;
const MAX_CONTENT = 200;

/**
 * Task-checklist tool offered to the top-level agent (TodoWrite semantics: every call
 * replaces the whole list). Mutates chat UI state only — never the workspace — so it
 * is auto-approved and not guarded.
 */
export const UPDATE_TODOS_TOOL: ToolSpec = {
	name: 'update_todos',
	description: 'Replace your visible task checklist. Send the FULL list every time (it overwrites the previous one). Use it at the start of any multi-step task, keep exactly one item in_progress, and update it immediately when an item completes. An empty list clears the checklist.',
	parameters: {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				description: 'The complete, ordered checklist.',
				items: {
					type: 'object',
					properties: {
						content: { type: 'string', description: 'Short, outcome-shaped description of the step.' },
						status: { type: 'string', enum: STATUSES, description: 'Current state of this step.' },
					},
					required: ['content', 'status'],
				},
			},
		},
		required: ['items'],
	},
};

/**
 * Validates an update_todos call's arguments into a clean item list. Returns an
 * error string (for the tool result) instead of throwing on bad model output.
 */
export function parseTodoUpdate(args: Record<string, unknown>): { items: TodoItem[] } | { error: string } {
	const raw = args.items;
	if (!Array.isArray(raw)) {
		return { error: 'update_todos requires an "items" array (send the complete checklist).' };
	}
	if (raw.length > MAX_ITEMS) {
		return { error: `Too many todo items (${raw.length}); keep the checklist under ${MAX_ITEMS}.` };
	}
	const items: TodoItem[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) {
			return { error: 'Each todo item must be an object with "content" and "status".' };
		}
		const content = typeof (entry as Record<string, unknown>).content === 'string'
			? ((entry as Record<string, unknown>).content as string).trim().slice(0, MAX_CONTENT)
			: '';
		const status = (entry as Record<string, unknown>).status;
		if (!content) {
			return { error: 'Todo "content" must be a non-empty string.' };
		}
		if (typeof status !== 'string' || !STATUSES.includes(status as TodoStatus)) {
			return { error: `Todo "status" must be one of: ${STATUSES.join(', ')}.` };
		}
		items.push({ content, status: status as TodoStatus });
	}
	return { items };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-todos.mjs
```
Expected: `test-persona-todos: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/persona/todos.ts extensions/openvs-chat/scripts/test-persona-todos.mjs
git commit -m "feat(persona): update_todos tool spec and validator"
```

---

### Task 4: Environment snapshot — `src/persona/envContext.ts`

**Files:**
- Create: `extensions/openvs-chat/src/persona/envContext.ts`

**Interfaces:**
- Produces: `buildEnvContext(): Promise<string>` — capped plain-text block (may be `''` when no workspace). Consumed by Task 5.
- Uses the `vscode` API and `child_process.execFile` — not unit-testable outside the extension host; gate is typecheck + Task 9 manual verification.

- [ ] **Step 1: Write the implementation**

Create `extensions/openvs-chat/src/persona/envContext.ts`:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as vscode from 'vscode';

const CACHE_MS = 30_000;
const MAX_CHARS = 1_500;
const MAX_STATUS_LINES = 20;
const MAX_OPEN_TABS = 15;

let cached: { at: number; text: string } | undefined;

/** Runs git with the given args in `cwd`, resolving to stdout or '' on any failure. */
function git(cwd: string, args: string[]): Promise<string> {
	return new Promise(resolve => {
		execFile('git', args, { cwd, timeout: 3_000, maxBuffer: 64_000 }, (err, stdout) => {
			resolve(err ? '' : stdout.trim());
		});
	});
}

/** Filenames of open editor tabs, active-first, capped. */
function openTabs(): string[] {
	const names: string[] = [];
	const active = vscode.window.activeTextEditor?.document.uri.toString();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.input instanceof vscode.TabInputText) {
				const uri = tab.input.uri;
				const rel = vscode.workspace.asRelativePath(uri);
				if (uri.toString() === active) {
					names.unshift(rel);
				} else {
					names.push(rel);
				}
			}
		}
	}
	return [...new Set(names)].slice(0, MAX_OPEN_TABS);
}

/**
 * Builds the environment snapshot injected into every system prompt (Claude Code
 * style): workspace root, platform, date, git branch/status, open editor tabs.
 * Every probe fails soft (section omitted); result is cached for {@link CACHE_MS}
 * and hard-capped at {@link MAX_CHARS} characters.
 */
export async function buildEnvContext(): Promise<string> {
	if (cached && Date.now() - cached.at < CACHE_MS) {
		return cached.text;
	}
	const lines: string[] = [];
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (root?.scheme === 'file') {
		lines.push(`Workspace root: ${root.fsPath}`);
	} else if (root) {
		lines.push(`Workspace root: ${root.toString()} (virtual)`);
	}
	lines.push(`Platform: ${process.platform}`);
	lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);

	if (root?.scheme === 'file') {
		const cwd = root.fsPath;
		const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
		if (branch) {
			lines.push(`Git branch: ${branch}`);
			const status = await git(cwd, ['status', '--porcelain']);
			if (status) {
				const statusLines = status.split('\n');
				const shown = statusLines.slice(0, MAX_STATUS_LINES);
				const more = statusLines.length > shown.length ? `\n… ${statusLines.length - shown.length} more` : '';
				lines.push(`Git status:\n${shown.join('\n')}${more}`);
			} else {
				lines.push('Git status: clean');
			}
		}
	}

	const tabs = openTabs();
	if (tabs.length) {
		lines.push(`Open editors (active first): ${tabs.join(', ')}`);
	}

	const text = lines.join('\n').slice(0, MAX_CHARS);
	cached = { at: Date.now(), text };
	return text;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/persona/envContext.ts
git commit -m "feat(persona): fail-soft environment snapshot (git, platform, open tabs)"
```

---

### Task 5: Wire prompt pack + env into ChatViewProvider

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts` — `baseSystem()` (line ~112), `buildSystemPrompt()` (line ~959), and the `CONCISE` constant (line 99).

**Interfaces:**
- Consumes: `personaBase`, `modeDoctrine` (Task 1), `buildEnvContext` (Task 4).
- Produces: `baseSystem()` now returns identity + env + user base + rules + skills; `buildSystemPrompt(mode, base, inline, readTools)` keeps its exact signature (both call sites at lines ~710 and ~805 stay untouched). Auto mode inherits everything automatically because `handleAutoSend` passes `baseSystem()` as `baseSystemPrompt` (line ~770).

- [ ] **Step 1: Add imports**

In `extensions/openvs-chat/src/chatViewProvider.ts`, next to the existing imports at the top of the file, add:

```ts
import { buildEnvContext } from './persona/envContext';
import { modeDoctrine, personaBase } from './persona/prompts';
```

- [ ] **Step 2: Rewrite `baseSystem()`**

Replace (at line ~112):

```ts
	private async baseSystem(): Promise<string> {
		let base = await this.rules.composeSystem(this.registry.getSystemPrompt());
```

with:

```ts
	private async baseSystem(): Promise<string> {
		const env = await buildEnvContext();
		let base = await this.rules.composeSystem(personaBase(env, this.registry.getSystemPrompt()));
```

(The rest of the method — skills loop, return — is unchanged. `rules.composeSystem` prepends rule-file content to its argument; identity and env stay at the head of the final prompt because `composeSystem` appends the argument after the rules — verify the ordering in `src/rules.ts` when editing: if `composeSystem(x)` puts rules BEFORE `x`, swap to `personaBase(env, await this.rules.composeSystem(this.registry.getSystemPrompt()))` instead so identity leads.)

- [ ] **Step 3: Replace `buildSystemPrompt()` body**

Replace the whole method (lines ~959-979) with:

```ts
	private buildSystemPrompt(mode: ChatMode, base: string, inline = false, readTools = false): string {
		return `${base}\n\n${modeDoctrine(mode, { inline, readTools })}\n\n${ChatViewProvider.CONCISE}`;
	}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json --noEmit`
Expected: no output. If `ChatMode` and `PersonaMode` disagree, the error will name the union mismatch — `ChatMode` includes `'auto'`? It does not (auto is a provider, not a mode) — but if the compiler reports extra members, map explicitly: `modeDoctrine(mode as PersonaMode, …)` is NOT allowed; instead extend `PersonaMode` in `prompts.ts` to match `ChatMode` exactly.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "feat(persona): wire identity, env snapshot and mode doctrines into every prompt"
```

---

### Task 6: Wire thinking parser into streaming paths

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts` — `runStreaming` (line ~830), `runReadOnlyAgent` (line ~885), `runAgent` (line ~904).

**Interfaces:**
- Consumes: `ThinkingStreamParser`, `formatThinking` (Task 2).
- Behavior: streamed deltas pass through a parser before `post({ type: 'token' … })`; each agent step gets a fresh parser (created in `onStepStart`, flushed in `onStepEnd`); `agentStepEnd`'s authoritative content is `formatThinking(content)`. Raw text (with tags) still accumulates in `full`/`messages`, so Edit-mode code-block extraction and the model's own context are untouched.

- [ ] **Step 1: Add import**

```ts
import { ThinkingStreamParser, formatThinking } from './persona/thinking';
```

- [ ] **Step 2: Wrap `runStreaming` tokens**

In `runStreaming` (line ~830), replace:

```ts
		const { text: full } = await streamChatWithContinuation(provider, {
			messages,
			...params,
			onToken: delta => post({ type: 'token', delta }),
		});
```

with:

```ts
		const thinking = new ThinkingStreamParser(text => post({ type: 'token', delta: text }));
		const { text: full } = await streamChatWithContinuation(provider, {
			messages,
			...params,
			onToken: delta => thinking.push(delta),
		});
		thinking.flush();
```

- [ ] **Step 3: Wrap the agent callback sets**

Both `runReadOnlyAgent` (line ~893) and `runAgent` (line ~934) pass the same callback shape. In EACH of the two, replace:

```ts
			onStepStart: () => post({ type: 'agentStepStart' }),
			onToken: delta => post({ type: 'token', delta }),
			onStepEnd: content => post({ type: 'agentStepEnd', content }),
```

with:

```ts
			onStepStart: () => { stepThinking = new ThinkingStreamParser(text => post({ type: 'token', delta: text })); post({ type: 'agentStepStart' }); },
			onToken: delta => stepThinking?.push(delta),
			onStepEnd: content => { stepThinking?.flush(); stepThinking = undefined; post({ type: 'agentStepEnd', content: formatThinking(content) }); },
```

and immediately before each `await runner.run(…)` call add the holder:

```ts
		let stepThinking: ThinkingStreamParser | undefined;
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 5: Re-run the pure-module tests (regression)**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-thinking.mjs
```
Expected: `test-persona-thinking: all assertions passed`

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "feat(persona): route <thinking> blocks through streaming parser in all chat paths"
```

---

### Task 7: `update_todos` in the agent loop

**Files:**
- Modify: `extensions/openvs-chat/src/agent/agentRunner.ts` — `AgentCallbacks` (line ~13), `tools()` (line ~89), `runTools()` (line ~155), `subagentSystem()` (line ~262).
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts` — `runAgent` (line ~904).

**Interfaces:**
- Consumes: `UPDATE_TODOS_TOOL`, `parseTodoUpdate`, `TodoItem` (Task 3); `SUBAGENT_PREAMBLE` (Task 1).
- Produces: `AgentCallbacks.onTodos?(items: TodoItem[]): void`; host posts `{ type: 'todos', items }` (consumed by Task 8). Tool registered only for the top-level, write-capable agent (`depth === 0 && !readOnly`).

- [ ] **Step 1: Extend agentRunner**

In `extensions/openvs-chat/src/agent/agentRunner.ts`:

Add to the imports:

```ts
import { SUBAGENT_PREAMBLE } from '../persona/prompts';
import { TodoItem, UPDATE_TODOS_TOOL, parseTodoUpdate } from '../persona/todos';
```

Add to `AgentCallbacks` (after `onNote`):

```ts
	/** The agent replaced its visible task checklist (top-level agent only). */
	onTodos?(items: TodoItem[]): void;
```

In `tools()` (line ~89), after `const base = [...AGENT_TOOLS];` add:

```ts
		if (this.depth === 0) {
			base.push(UPDATE_TODOS_TOOL);
		}
```

In `runTools()` (line ~163), inside the `for (const call of calls)` loop, directly after the `spawn_subagent` interception:

```ts
			if (call.name === UPDATE_TODOS_TOOL.name) {
				callbacks.onToolStart(call);
				const parsed = parseTodoUpdate(call.args);
				const outcome = 'error' in parsed
					? { result: parsed.error, isError: true }
					: (callbacks.onTodos?.(parsed.items),
						{ result: `Checklist updated (${parsed.items.length} item(s)).`, isError: false });
				callbacks.onToolEnd(call, outcome.result, outcome.isError);
				outcomes.push({ call, ...outcome });
				continue;
			}
```

In `subagentSystem()` (line ~262), change the return to prepend the shared discipline:

```ts
	return `${role} ${SUBAGENT_PREAMBLE} You were given one focused goal and do not see the parent conversation. ` +
		`Accomplish exactly that goal using your tools, then end with a concise summary of what you found or changed. Do not ask follow-up questions.`;
```

- [ ] **Step 2: Wire the host side**

In `chatViewProvider.ts` `runAgent` (line ~934), add to the callbacks object passed to `runner.run` (after `onNote`):

```ts
			onTodos: items => post({ type: 'todos', items }),
```

And directly before that `await runner.run(…)`, reset the panel for the new run:

```ts
		post({ type: 'todos', items: [] });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p extensions/openvs-chat/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 4: Run todo unit test (regression)**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-todos.mjs
```
Expected: `test-persona-todos: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/agent/agentRunner.ts extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "feat(persona): update_todos tool in agent loop with host todos channel"
```

---

### Task 8: Todo checklist panel in the webview

**Files:**
- Modify: `extensions/openvs-chat/media/main.js` — session state, message dispatch switch (`case 'info'` block at line ~1783 is a good anchor), render pipeline.
- Modify: `extensions/openvs-chat/media/main.css` — panel styles.

**Interfaces:**
- Consumes: host message `{ type: 'todos', sessionId, items: { content, status }[] }` (Task 7). Statuses: `pending` | `in_progress` | `completed`.
- Behavior: per-session list; empty `items` hides the panel; panel shows for the active session only and re-renders on tab switch.

- [ ] **Step 1: Add the render function and state**

In `media/main.js`, near `sessionFor` (line ~61), add:

```js
	/** Renders the agent's task checklist for the active session (hidden when empty). */
	function renderTodos() {
		let panel = document.getElementById('todoPanel');
		if (!panel) {
			panel = document.createElement('div');
			panel.id = 'todoPanel';
			panel.className = 'todo-panel hidden';
			els.messages.parentElement.insertBefore(panel, els.messages);
		}
		const items = (cur() && cur().todos) || [];
		if (!items.length) {
			panel.classList.add('hidden');
			panel.innerHTML = '';
			return;
		}
		const icon = s => s === 'completed' ? '●' : s === 'in_progress' ? '◐' : '○';
		panel.innerHTML = '<div class="todo-title">Tasks</div>' + items.map(t =>
			`<div class="todo-item todo-${t.status}"><span class="todo-icon">${icon(t.status)}</span>${escapeHtml(t.content)}</div>`
		).join('');
		panel.classList.remove('hidden');
	}
```

- [ ] **Step 2: Handle the message**

In the host-message `switch`, next to `case 'info':` (line ~1783), add:

```js
				case 'todos': {
					const s = sessionFor(msg);
					s.todos = Array.isArray(msg.items) ? msg.items : [];
					if (s.id === activeSessionId) { renderTodos(); }
					break;
				}
```

- [ ] **Step 3: Re-render on tab switch**

Find the function that repaints the transcript when switching sessions (`renderAll` — it is called at line ~1777). At the end of `renderAll`'s body, add:

```js
		renderTodos();
```

- [ ] **Step 4: Styles**

Append to `media/main.css`:

```css
.todo-panel {
	margin: 6px 8px 0;
	padding: 6px 10px;
	border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
	border-radius: 6px;
	font-size: 12px;
	background: var(--vscode-editorWidget-background);
}
.todo-panel.hidden { display: none; }
.todo-title { font-weight: 600; margin-bottom: 4px; opacity: 0.8; }
.todo-item { display: flex; gap: 6px; padding: 1px 0; align-items: baseline; }
.todo-icon { flex: none; }
.todo-completed { opacity: 0.55; text-decoration: line-through; }
.todo-in_progress { font-weight: 600; }
```

- [ ] **Step 5: Sanity check the webview JS parses**

Run: `node --check extensions/openvs-chat/media/main.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add extensions/openvs-chat/media/main.js extensions/openvs-chat/media/main.css
git commit -m "feat(persona): live task checklist panel in chat webview"
```

---

### Task 9: Full verification

**Files:** none created — verification only.

- [ ] **Step 1: Full extension compile**

Run (repo root): `npm run gulp compile-extensions`
Expected: completes without errors for openvs-chat.

- [ ] **Step 2: All persona unit tests**

```
npx tsc -p extensions/openvs-chat/tsconfig.json
node extensions/openvs-chat/scripts/test-persona-prompts.mjs
node extensions/openvs-chat/scripts/test-persona-thinking.mjs
node extensions/openvs-chat/scripts/test-persona-todos.mjs
```
Expected: three `all assertions passed` lines.

- [ ] **Step 3: Manual Extension Development Host checklist**

Launch (`F5` in this repo, or `--extensionDevelopmentPath=extensions/openvs-chat`), then verify:

1. **Ask mode** — ask "what does src/rules.ts do?"; answer is grounded, a `🤔 *Thinking…*` block precedes it (tag-scaffold models), and no literal `<thinking>` text appears.
2. **Plan mode** — request a plan; output names real files, no implementations.
3. **Agent mode** — give a multi-step task ("add a comment header to X and typecheck"); the Tasks panel appears, items progress ○→◐→●, verification command runs before the final summary.
4. **Edit mode** (inline code action) — returns clean code, no thinking artifacts.
5. **Weak model check** — repeat step 3 on a small OpenAI-compatible/local model; loop discipline should visibly improve vs. before.
6. **No-git workspace** — open a folder without git; sends still work (env section simply shorter).

- [ ] **Step 4: Report results**

Report each checklist item's outcome honestly. Fix anything that failed before proceeding.

---

## Self-Review (done at plan time)

- **Spec coverage:** prompt pack → Task 1/5; env snapshot → Task 4/5; thinking → Task 2/6; todos → Task 3/7/8; subagent identity → Task 7; Auto-mode inheritance → Task 5 (via `baseSystem`); error handling (fail-soft env, flush-on-malformed, tool-error strings) → Tasks 2/3/4; verification → Task 9.
- **Deviation from spec, intentional:** spec said thinking routes to "the existing reasoning channel"; investigation showed that channel IS inline markdown (`openaiCompatible.ts:113-128`), so the parser emits the same convention. Spec's intent (reuse existing rendering) preserved.
- **Type consistency:** `TodoItem`/`parseTodoUpdate` names match across Tasks 3/7/8; `PersonaMode` mirrors `ChatMode`; `personaBase`/`modeDoctrine` signatures identical at definition (Task 1) and call sites (Task 5).
