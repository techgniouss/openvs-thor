# Claude-Harness Persona for openvs-chat ("Thor intelligence") — Design

**Date:** 2026-07-18
**Branch:** feat/replace-copilot-with-openvs-chat
**Status:** Approved

## Goal

Make the openvs-chat extension ("Thor") behave like Claude Code regardless of which
backing model is selected: rich layered system prompts, an auto-injected environment
snapshot, a universal thinking scaffold, and Claude-style task/todo tracking in the
agent loop. Pure prompt-and-harness work — no provider or guardrail changes.

## Current state (what this replaces)

- Base system prompt is the user's `openvsChat.systemPrompt` setting (default empty)
  plus rules (`src/rules.ts`) and active skills, composed in
  `ChatViewProvider.baseSystem()` (`src/chatViewProvider.ts:112`).
- Mode "doctrine" is a single appended sentence per mode in
  `ChatViewProvider.buildSystemPrompt()` (`src/chatViewProvider.ts:959-979`), plus the
  shared `CONCISE` constant.
- No environment context (git, OS, cwd, open files, date) reaches the model.
- Agent loop (`src/agent/agentRunner.ts`) has tools read/list/search/write/edit/run +
  `spawn_subagent`, but no task tracking, no read-before-edit or verify-before-done
  doctrine.
- Webview (`media/main.js`) already renders a collapsible reasoning block for
  providers that stream `reasoning_content` (DeepSeek-R1 style).

## Architecture

New module directory `extensions/openvs-chat/src/persona/`:

```
src/persona/
  prompts.ts      — layered prompt pack: identity, communication doctrine,
                    mode doctrines, tool policy, task doctrine, thinking scaffold
  envContext.ts   — environment snapshot builder (git/OS/cwd/open files/date)
  thinking.ts     — streaming <thinking> tag parser → reasoning channel
  todos.ts        — todo state + update_todos tool definition
```

`chatViewProvider.ts` and `agentRunner.ts` call into this module; they do not grow
prompt text of their own. Guardrails (`agent/guardrails.ts`) are untouched — hard
enforcement stays in code, persona is soft steering.

## 1. Prompt pack (`prompts.ts`)

Composition order for every request:

```
identity → environment snapshot → mode doctrine → thinking scaffold
→ task doctrine (agent mode only) → user systemPrompt setting → rules → skills
```

`composePrompt(mode, env, userBase)` returns the assembled system prompt. The
existing `baseSystem()` continues to append rules and skills; only the head layers
are new.

**Identity + communication doctrine** (all modes), modeled on Claude Code:

- "You are Thor, the OpenVS coding agent."
- Lead with the outcome; no preamble, flattery, or filler.
- Report failures honestly, quoting actual output; never claim success without
  having verified it.
- Reference code as `path:line`. Answer in GitHub-flavored markdown.
- Match the existing code style of the file being edited; no explanatory comments
  addressed to the reviewer.
- Concise prose over padded lists; do not restate the question.

**Mode doctrines** (full rewrites of the current one-liners):

- **Ask** — read-only. Ground answers in real files via the read tools; trace code
  before speculating. If a change is needed, describe it and point to Agent mode.
- **Plan** — explore with read tools first, then produce goal, assumptions, ordered
  steps naming files/components, and risks/open questions. Never implement, never
  claim changes were made.
- **Agent** — explicit loop: understand → plan (todos) → execute → verify. Read a
  file before editing it. Prefer targeted `edit_file` over whole-file `write_file`.
  Never guess paths — search first. After writes, verify (typecheck/build/test via
  `run_command`) before summarizing. Batch independent reads. Ask the user only when
  truly blocked.
- **Edit** — same contract as today (complete file / selection in one fenced block),
  tightened wording.

## 2. Environment snapshot (`envContext.ts`)

`buildEnvContext()` returns a capped plain-text block injected as a prompt layer:

- Workspace root path and platform (win32/darwin/linux), today's date.
- Git: current branch, ahead/behind, `git status --porcelain` capped at 20 lines.
- Open editor tab filenames (names only, not contents — Ask mode already attaches
  contents separately).

Fail-soft: any probe that errors (no git, no workspace) is omitted. Result cached
for ~30 s to avoid running git on every keystroke-send. Hard budget ≤1500 chars.

## 3. Thinking scaffold (`thinking.ts`)

- Prompt layer instructs every model: before answering or calling tools, reason
  briefly inside `<thinking>…</thinking>`; keep it short; never put the final
  answer inside the tags.
- `ThinkingStreamParser` is a state machine fed token deltas; it strips
  `<thinking>` blocks from the visible stream and emits their content on the
  existing reasoning channel (same webview path `reasoning_content` uses), so the
  UI's collapsible reasoning block renders it. Handles tags split across chunks.
- Applied in `runStreaming` and the agent-step streaming path. Models with native
  reasoning (R1, o-series) that ignore the instruction lose nothing — parser is a
  pass-through when no tags appear.

## 4. Todos (`todos.ts` + webview)

- New agent tool `update_todos`: input is the **complete** todo list
  `{ items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }`,
  replacing previous state (TodoWrite semantics). Auto-approved — it mutates chat
  state only, never the workspace.
- Task doctrine layer (agent mode): use todos for any multi-step task; exactly one
  `in_progress` at a time; mark items completed immediately when done; keep items
  short and outcome-shaped.
- State is per chat session, held by the host; host posts `{ type: 'todos', items }`
  to the webview on every update.
- `media/main.js` renders a live checklist panel pinned above the transcript for the
  active session (pending ○ / in-progress ◐ / completed ●). The list resets when a
  new agent run starts in that session; it persists (collapsed) after a run ends so
  the user can see what was completed.

## 5. Wiring

- `ChatViewProvider.buildSystemPrompt()` → delegates to `composePrompt()`.
- `resolveContext()` unchanged; env snapshot is a prompt layer, not attached context.
- `agentRunner.ts`: registers `update_todos` (main agent only, not subagents),
  handles its result inline; subagent system prompts get the identity +
  communication layers too.
- Auto mode (`auto/orchestrator.ts`) inherits everything via `baseSystemPrompt`.
- Token budget: persona layers ≈ 2–3 k tokens per request — accepted trade-off.

## Error handling

- Env probes fail-soft (omit section, never block a send).
- Thinking parser must never drop user-visible text: on malformed/unclosed tags it
  flushes buffered content to the visible stream.
- `update_todos` validates statuses; invalid input returns a tool error string, does
  not throw.

## Testing / verification

- No existing test suite in openvs-chat. Pure functions (`composePrompt`,
  `ThinkingStreamParser`, todo reducer) written side-effect-free so unit tests can
  be added later.
- Gate: `tsc --noEmit` on the extension + `npm run gulp compile-extensions`.
- Manual verification in Extension Development Host: each mode's prompt visible via
  a debug log, thinking block renders, todo panel updates during a multi-step agent
  task, weak model (e.g. small OpenAI-compatible local model) visibly follows the
  loop.

## Out of scope

- Context compaction / summarization, provider changes, guardrail changes,
  subagent orchestration redesign, MCP changes.
