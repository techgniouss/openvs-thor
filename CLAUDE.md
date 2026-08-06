# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is **OpenVS**, a fork of the `microsoft/vscode` ("Code - OSS") monorepo. It is the
full VS Code editor source tree (`src/`, `build/`, `extensions/`, `test/`, `scripts/`) plus
one custom first-party extension, **`extensions/openvs-chat`**, which adds a built-in,
multi-provider AI chat panel (an alternative to Copilot Chat). Recent work in this repo has
been focused almost entirely on `openvs-chat` — treat that extension as the primary area of
active development unless told otherwise; everything else is upstream VS Code.

## Build, compile, watch

- `npm run compile` — full one-shot compile (client + copilot extension).
- `npm run watch` — incremental watch build of client, extensions, and copilot (what you
  want running during development). `npm run watchd` runs it detached (`deemon`).
- `npm run typecheck-client` — type-check `src/` only (`src/tsconfig.json`), no emit. Use
  this after editing core VS Code sources instead of a full compile.
- To type-check changes under `extensions/openvs-chat`, run the gulp extension-compile task:
  `npm run gulp compile-extensions` (there is no per-extension `tsc` script; the extension's
  own `tsconfig.json` is picked up by that task).
- `npm run valid-layers-check` — enforces the `base` → `platform` → `editor` → `workbench`
  layering rules; run this if you touch imports across those layers.
- `npm run eslint` / `npm run stylelint` / `npm run hygiene` — lint TS/CSS and repo hygiene
  checks (copyright headers, whitespace, etc.) respectively.

## Tests

- `npm run test-node` — unit tests under `test/unit/node` (mocha, tdd style).
  Filter with `--grep <pattern>`, e.g. `npx mocha test/unit/node/index.js --delay --ui=tdd --grep "MyThing"`.
- `npm run test-browser` — browser-context unit tests (installs Playwright first).
- `npm run test-extension` — extension-host tests via `vscode-test`.
- `scripts/test.bat` (Windows) — general unit test entry point; accepts `--grep <pattern>`.
- `scripts/test-integration.bat` — integration tests (`*.integrationTest.ts` and tests under
  `extensions/`).
- `npm test --prefix extensions/openvs-chat` — the extension's own suite (`pretest`
  compiles first, since the tests import from `out/`). Run one file directly while
  iterating: `node extensions/openvs-chat/scripts/test-tools.mjs`.
  `npm run typecheck --prefix extensions/openvs-chat` is the fast no-emit check, and it
  covers `media/main.js` too — that file runs under `// @ts-check` with
  `media/webview.d.ts` supplying the host globals, which is the only type safety the
  webview has. Keep it at zero errors; the moment it drifts, the pragma stops being read
  as a signal.
- Anything reaching the `vscode` API is tested by stubbing that module through
  `Module._load` — see `test-tools.mjs`, which drives the real tool layer against an
  in-memory workspace. Prefer that over asserting on mocks.
- `test-webview.mjs` guards the host↔webview contract statically (element ids, message
  types in both directions, prompt field names, script load order). `media/main.js` is one
  large IIFE that can't be imported, so this is what stands in for it — if you add a
  message type or an element id, that test catches the half you forgot.
- `test-model-axes.mjs` asserts that every model a provider *suggests* is actually usable
  on all three per-model axes, each of which is a hand-maintained regex table in a
  different file: `toolModelPatterns` (Agent mode), `visionModelPatterns` (image
  attachments), and `contextWindow.ts` (the conversation budget). All three fail *silently*
  — a miss doesn't error, it quietly removes Agent mode, or blocks images, or drops the
  budget to the 32k default so compaction fires from the first few file reads. Nothing else
  checks the tables against the model lists they describe, and both are edited whenever a
  provider is added or a vendor renames a model.
- `test-prompt-cards.mjs` runs the real approval/question cards (`media/prompts.js`)
  against a small DOM stand-in. That module is deliberately written with
  createElement/textContent and direct child references — **no `innerHTML`, no
  `querySelector`** — which is what lets the stand-in stay faithful without an HTML parser
  or a selector engine. Keep it that way when editing it.
- Rendering *appearance* still has to be checked by hand in the Extension Development Host
  (`F5` from this repo, or launch VS Code with
  `--extensionDevelopmentPath=extensions/openvs-chat`).

**MANDATORY:** always check for compilation errors before running tests or declaring work
done, and fix them first. Do not run tests while there are compile errors. Do not use
`npm run compile` as a substitute for the watch/typecheck flow above during iterative work.

## Core VS Code architecture (`src/vs`)

Layered, dependency-injected architecture — lower layers must never import from higher ones:

- `src/vs/base/` — foundation utilities, cross-platform abstractions.
- `src/vs/platform/` — platform services and the DI infrastructure.
- `src/vs/editor/` — the text editor (Monaco): language services, syntax highlighting, editing.
- `src/vs/workbench/` — the application shell (web + desktop):
  - `workbench/browser/` — core UI (parts, layout, actions)
  - `workbench/services/` — service implementations
  - `workbench/contrib/` — feature contributions (git, debug, search, terminal, etc.)
  - `workbench/api/` — extension host / VS Code extension API implementation
- `src/vs/code/` — Electron main-process specifics.
- `src/vs/server/` — remote/server specifics.
- `src/vs/sessions/` — the Agent Sessions window, a dedicated workbench layer for agentic
  workflows; sits alongside `workbench`, may import from it but not the reverse.

Conventions enforced across `src/`: services are injected via constructor parameters
(non-service params must come before service params); features register into registries /
extension points rather than being wired ad hoc; user-visible strings must be externalized
via `vs/nls` with placeholders (`{0}`), never string concatenation.

## `extensions/openvs-chat` architecture

A standard VS Code extension (webview-based sidebar view) with this module layout:

- `src/extension.ts` — activation entry point; wires the `ProviderRegistry`, `WebAuthManager`,
  `McpManager`, and `ChatViewProvider` together and registers all commands (`openvsChat.*`),
  the inline code-action provider, and the guided flows for `createSkill`, `mcpAdd`, and
  `mcpOpenConfig`.
- `src/chatViewProvider.ts` — the largest file; owns the webview, message protocol between
  webview UI (`media/main.js`) and the extension host, and dispatches the chat modes
  (**Ask** / **Plan** / **Agent**, plus the internal Edit mode behind inline code actions).
  Conversations are **multi-session**: the webview shows chat tabs, every send carries a
  `sessionId`, and the host keeps one `AbortController` per session so tabs stream in
  parallel. While a run streams, typed input is **queued** (Ask/Plan — auto-sent on
  completion) or **steers** the live agent run (injected as a user turn before the next
  loop step via `steerQueues`).
- `src/providers/` — one file per model backend (`openai.ts`, `anthropic.ts`, `nvidia.ts`,
  `openrouter.ts`, `groq.ts`, `mistral.ts`, `cloudflare.ts` (Workers AI), `kimi.ts`
  (Moonshot), `qwen.ts` (DashScope), `custom.ts` (any OpenAI-compatible endpoint —
  Ollama/LM Studio/vLLM/etc., no key required),
  `openaiCompatible.ts`) implementing the shared `ChatProvider` interface (`types.ts`),
  with `toolCalls.ts` holding the model-agnostic robustness layer: it repairs the malformed
  tool-call JSON weaker models emit (fences, Python literals, trailing commas, truncation)
  and recovers tool calls a model wrote into its prose (`<tool_call>`, `<function=…>`,
  fenced JSON) — `agentRunner.recoverTextToolCalls` applies the latter to every provider,
  and `tools.normalizeToolCall` maps other products' tool/argument names onto ours (including
  the keys *inside* `edit_file`'s batch array), with `asString`/`asNumber`/`asBoolean`
  coercing every model-supplied argument — `test-tool-conformance.mjs` is the matrix that
  keeps this honest and fails if a tool gains no case,
  looked up via `registry.ts`. NVIDIA and most other gateways reuse the OpenAI-compatible
  client — add a new backend by pointing a `baseUrl` setting at it, or by copying `kimi.ts`.
  Two backends need more than a base URL. Mistral validates every tool-call id against
  `^[a-zA-Z0-9]{9}$` and 400s the whole request otherwise, which our synthesized ids
  (`text_call_0` from prose recovery, `call_<index>` when a backend omits one) and any id
  carried over from a provider switch mid-conversation all fail. `toolCalls.shortToolCallId`
  rewrites them deterministically and `OpenAICompatibleProvider.toolCallId` applies it to
  the assistant turn and its tool result from one place, so the two can't disagree — keyed
  off the **model**, not the provider, because the same Mistral weights are served under a
  `mistralai/` prefix by OpenRouter, NVIDIA and Cloudflare too (the Mistral provider itself
  overrides it to always apply, since there the constraint is the API's, not the model's).
  Cloudflare Workers AI splits its credential in two: the token is a header, the *account
  id* is in the URL path, so it comes from `openvsChat.cloudflare.accountId` and
  `registry.getBaseUrl` substitutes it; its catalog also lives off the OpenAI-compatible
  surface, at `…/ai/models/search`.
  A backend that refuses `content` and `tool_calls` on one assistant message (NVIDIA) gets
  the narration as its own assistant turn ahead of the tool calls rather than losing it —
  without that record the model re-derives its plan, and re-reads the same files, on every
  step. `test-provider-messages.mjs` pins all three wire forms and the fallback between them.
  **Prompt caching is a first-class provider property** (`ProviderInfo.cachesPrompts`),
  because an agent step re-sends the whole conversation and whether that is expensive
  decides how eagerly the run compacts (`COMPACT_TRIGGER` vs `CACHED_COMPACT_TRIGGER` —
  compaction rewrites the middle, so on a caching backend it *destroys* the cached prefix
  and is worth doing later, not sooner). Anthropic sends explicit `cache_control`
  breakpoints on the system block and the moving tail; OpenAI caches automatically;
  OpenRouter needs explicit breakpoints for `anthropic/*` and `google/*` models and gets
  them from `wantsCacheBreakpoints`. Everything else declares nothing and compacts early.
  Anything that varies per turn must therefore stay **out** of the system prompt — that is
  why `persona/envContext.ts` splits its snapshot into `stable` (system prompt) and
  `volatile` (git status, open tabs; placed just ahead of the newest request).
  Everything that lands in the per-step prompt is budgeted, because it is paid for on every
  step: rules are capped at 12k chars, active skills at 16k each and 24k combined, and the
  tool schemas (~1.9k tokens built-in, unbounded once MCP servers connect) are charged
  against the context budget via `estimateToolsTokens` — counting only the messages
  understated every agent request by that whole amount.
  The shared client streams `reasoning_content` (DeepSeek-R1-style models) and uses a 150s
  first-byte timeout for chat POSTs (free tiers queue server-side). NVIDIA's model list is
  filtered to chat-capable models. Keys are stored in VS Code `SecretStorage`, never in
  plaintext settings; `OPENROUTER_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` env
  vars also work. `openai.ts` additionally routes through `chatgptBackend.ts` (the ChatGPT
  Codex Responses API) whenever the stored OpenAI credential is a ChatGPT OAuth token
  (detected via `isChatGptToken`) rather than an `sk-` API key. `src/oauth.ts` holds the
  shared `OAuthTokenStore` used by all web sign-in flows (Claude, ChatGPT, and OpenRouter's
  one-click PKCE sign-in via `signInOpenRouter`), refreshing tokens transparently near
  expiry.
- `src/agent/` — the Agent-mode tool loop: `tools.ts` (read/list/write files, run commands,
  plus `ask_user`, which blocks the loop on a multiple-choice question),
  `guardrails.ts` (protected paths, denied/allowed command regexes, approval policy, and
  `normalizeWorkspacePath` — the *single* place a model-supplied path is cleaned; both the
  guardrail check and the filesystem resolution must go through it or they validate one
  path and touch another), `agentRunner.ts` (the loop itself, including `spawn_subagent`
  delegation and the completion gate that refuses to call a run "done" while the model's
  own `update_todos` checklist has open items or it wrote files without verifying them).
  A run is bounded on **two** axes, because they come apart: `openvsChat.agent.maxSteps`
  caps how many times the model is asked (Full Auto extends itself to 2× that, nothing
  else does), and `openvsChat.agent.maxRunMinutes` caps how long the asking may take —
  on a queued free tier one step can stall for minutes without the step count moving.
  Sub-agents inherit the parent's *remaining* time rather than a fresh budget. Each
  top-level run closes with a note giving its elapsed time and peak prompt size;
  `openvsChat.agent.traceTiming` adds the same per step. Within a step, adjacent
  read-only tool calls run concurrently (`openvsChat.agent.parallelReads`) — the guards
  are evaluated in order before anything is dispatched, so batching can't be used to slip
  past the repeat-read breaker.
  Approvals and questions reach the user as inline cards in the chat tab that raised them,
  via the per-run `SessionApprover` in `chatViewProvider.ts` (host side) and
  `media/prompts.js` (rendering) — never as a global modal, so the card can carry a diff,
  say which tab is asking, offer "allow for this run", and take a written reason on denial
  (which is fed back to the model as the tool result).
  `shell.ts` picks the shell `run_command` executes through — on Windows it prefers the Git
  Bash that ships with Git over `cmd.exe`, because models emit POSIX syntax by default;
  `run_command` streams output through a rolling head+tail collector rather than buffering
  it, so a verbose build always yields a real exit code.
  `search_files` prefers the editor's own ripgrep via `workspace.findTextInFiles`, which
  is why `enabledApiProposals: ["findTextInFiles"]` is in the extension's package.json —
  that keeps this extension **built-in only** (a packaged VSIX would be refused). The
  manual file sweep remains as a feature-detected fallback, so removing the proposal
  degrades performance rather than breaking search.
- `src/auto/` — **Auto** role-routing mode: `router.ts` picks/validates per-role models
  (planning / implementation / review) from `openvsChat.auto.*` settings, honoring pinned
  models exactly and only falling back for auto-selected ones. Its `INFERENCE_CANDIDATES`
  list names *preferred* models from a few providers — it is not the list Auto supports;
  when none of them can run, `sweepCandidates` falls back to whatever the user actually
  holds a credential for, which is what keeps Auto usable for someone whose only key is a
  free provider. The sweep costs a credential read per provider, so it is walked only after
  the preferred list comes up empty, never concatenated onto it. `orchestrator.ts` runs the
  plan → implement → review pipeline (or a per-step decomposition when
  `openvsChat.auto.decompose` is set).
- `src/mcp/` — Model Context Protocol client (`client.ts`) and multi-server lifecycle
  manager (`manager.ts`); merges global (`openvsChat.mcp.servers`) and per-project
  (`.openvs/mcp.json` / `.vscode/mcp.json`) server configs; project overrides global; stdio
  servers only start in a trusted workspace.
- `src/rules.ts` — loads always-on "soft steering" instructions from `openvsChat.rules` plus
  **every** present file in `openvsChat.ruleFiles` (default `.openvs/rules.md`, `AGENTS.md`,
  `.github/copilot-instructions.md`, `.cursorrules`), each labelled with its source and
  probed across all workspace folders; prepended to every conversation. The combined block
  is capped at 12k chars — earlier files win, so order the setting by priority.
- `src/skills.ts` — activatable instruction packs; four ship bundled verbatim under
  `skills/*.md` (caveman, impeccable, uiux-pro-max, agent-browser), user skills can be added
  via settings or `.openvs/skills/*.md`. The `openvsChat.createSkill` command (also the
  "＋ New Skill" button in the panel and `/skill new`) scaffolds a workspace skill file.
  MCP servers can likewise be registered from the UI: `openvsChat.mcpAdd` writes to
  `.openvs/mcp.json` or the global setting, and the settings panel shows per-server status.
- `src/auth.ts` — `WebAuthManager`, the URI-handler-based OAuth/proxy sign-in flow
  (`openvsChat.<provider>.authUrl` → editor opens it → callback delivers `&token=`).
- `examples/auth-server/` — a runnable reference backend for the web sign-in flow
  (`node examples/auth-server/server.mjs`), supporting both interactive login and a
  shared-key/zero-config mode.

Guardrails in `agent/guardrails.ts` are hard-enforced in code (denied commands, protected
paths, workspace-root confinement, untrusted-workspace write blocking) and cannot be
overridden by model output; `rules.ts` content is soft steering only. Keep that distinction
when changing either. The *approval policy* is separate and defaults to `yolo` (no
confirmation cards for writes or commands) — the hard guardrails above still apply at every
policy, and `ask_user` remains how the agent raises a decision that is genuinely the user's.

## Coding guidelines (apply repo-wide, including `openvs-chat`)

- Tabs, not spaces.
- PascalCase for `type`/`enum` names; camelCase for functions, methods, properties, locals.
- Don't export types/functions unless shared across multiple components; don't add to the
  global namespace.
- JSDoc-style comments for functions/interfaces/enums/classes.
- Double quotes only for user-facing strings needing localization (externalized via
  `vs/nls`, placeholders not concatenation); single quotes otherwise.
- Title-style capitalization for command labels/buttons/menu items (short prepositions like
  "in"/"with"/"for" stay lowercase unless first/last word).
- Arrow functions over anonymous function expressions; only parenthesize a single arrow
  param when required by syntax (e.g. `x => x + x`, not `(x) => x + x`).
- Braces always required for loop/conditional bodies, opening brace on the same line.
- Prefer top-level `export function x(...) {...}` over `export const x = (...) => {...}` so
  stack traces show a real name.
- All files require the Microsoft copyright header (the openvs-chat files use an "OpenVS"
  variant — match the header already used in that directory).
- Prefer `async`/`await` over `Promise`/`.then()`.
- No `any`/`unknown` unless truly unavoidable — use a real type/interface.
- Register disposables immediately via `DisposableStore`/`MutableDisposable`/`DisposableMap`;
  don't attach a disposable created inside a repeatedly-called method to the containing
  class — return an `IDisposable` and let the caller register it.
- Don't drive control flow with events; prefer direct method calls between components.
  Events are for broadcasting state changes only.
- Avoid `bind()`/`call()`/`apply()` just to control `this` or partially apply args; prefer
  arrow functions/closures, reserving these for cases an API genuinely requires them.
- Service dependencies must be declared as constructor parameters, never pulled from
  `IInstantiationService` elsewhere.
- Use `IEditorService` (not `IEditorGroupsService.activeGroup.openEditor`) to open editors.
- Use `IHoverService` for tooltips, not ad hoc hover UI.
- Prefer correlated file watchers (`fileService.createWatcher`) over shared ones.
- Don't duplicate code — search for existing utilities/helpers/patterns first.
- Don't reach into another component's storage keys; add a proper API instead.
- Minimize assertions in tests — prefer one snapshot-style `assert.deepStrictEqual` over many
  precise assertions.
- Don't stub globals or use `any` casts to fake dependencies in tests; make the dependency
  injectable (optional constructor param defaulting to the real implementation) and inject a
  fake that implements the real interface.

## Finding related code

1. Semantic/file search first for general concepts.
2. Grep for exact error strings or function names.
3. Follow imports to find callers of a changed module.
4. Check `*/test/` folders — they reveal real usage and expected behavior.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
