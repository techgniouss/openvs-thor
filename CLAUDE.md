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
  The shared client streams reasoning through `reasoningDelta`, which accepts every spelling
  in use — `reasoning_content` (DeepSeek-R1-style), `reasoning` (Groq, OpenRouter) and the
  object-wrapped form — because a turn spent entirely thinking carries no `content` and no
  tool calls, so reading one spelling made those turns arrive as *empty replies* and the
  agent loop abandoned the run after four. It also raises a backend's **in-band stream
  error** (`throwStreamError`): NVIDIA NIM and other vLLM-based gateways report failures as
  an SSE event on an HTTP 200, and skipping them turned a stated provider error into the
  same silent "empty reply" stall. The Anthropic client has always raised these.
  A 150s first-byte timeout is used for chat POSTs (free tiers queue server-side). NVIDIA's model list is
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
  Sub-agents inherit the parent's *remaining* time rather than a fresh budget.
  A third bound is the backend's own **per-request token allowance**, which is unrelated to
  the model's context window and invisible to every catalog: Groq's free tier serves
  `qwen/qwen3.6-27b` with a 128k window and an 8k allowance, and counts the reserved
  `max_tokens` against it — so the default 8192 reservation alone exceeds the limit before
  any prompt is added, and no amount of trimming can rescue it. `providers/rateLimits.ts`
  reads that allowance off `x-ratelimit-*` / `anthropic-ratelimit-*` response headers (both
  spellings, three reset formats) into a per-model `RateLimitTracker` held on the provider
  singleton, and `agentRunner.adoptRequestCeiling` re-derives *both* budgets from it — reply
  reservation and conversation — before the request that would have broken it. It may only
  ever **tighten**: the allowance is tokens-per-request, not a window, so letting a roomy one
  raise the budget would trade a rate-limit rejection for a context-length one. When no
  header is offered the same ceiling is still learned from the HTTP 413 body
  (`parseTokenLimit`), one wasted request later. `apiFetch` also takes a `pace` hook: when a
  reading says the request cannot fit what is left of the current window, it waits out the
  refill instead of spending a request to be refused — Groq counts *failed* requests against
  the daily budget. All its backoff sleeps are abortable, so Stop is instant. Each
  top-level run closes with a ledger: elapsed time, *cumulative* estimated input tokens
  over the requests it took (compaction's own summarizer calls included), and the peak
  single prompt. Cumulative, because a step re-sends the whole conversation — the total is
  what grows with a long run, and a peak alone can't tell two steps from forty.
  `openvsChat.agent.traceTiming` adds per-step timing. Two distinct passes keep that total
  down, and they answer different questions. `trimMessages` is a *correctness* guard —
  it fires only when a request would not fit. `pruneToolOutput` is an *economy* pass: it
  elides tool output the model no longer needs sent regardless of budget (a read whose
  identical call recurs later, a read of a file a later `write_file` replaced wholesale —
  `edit_file` deliberately does not count, since a targeted edit leaves the old dump mostly
  accurate and eliding it would force a costlier re-read — and anything older than the kept
  turns). Measured on a synthetic 30-step run: 2455k → 1048k input tokens. Both passes work
  on a **copy**; the run's own transcript is never rewritten, so compaction and the
  truncation-carry splice still see full history. Pruning is skipped entirely when
  `cachesPrompts` is set — there, re-sending an old dump costs a fraction of its first
  price while eliding it rewrites the middle and throws the cached prefix away, the same
  trade `CACHED_COMPACT_TRIGGER` makes. Compaction is likewise judged on the *pruned* view,
  or a run would pay for a summarizer call to fix a size it no longer sends.
  **Anything that elides tool output must un-remember the corresponding read**
  (`forgetElidedReads`): the repeat-read breaker tells the model "its result is still above
  in this conversation", and if that result has been elided the model can neither see the
  content nor fetch it, and burns the step budget being refused. This applies to trimming
  too, which has always elided output — the deadlock predates pruning.
  `trimMessages` now exhausts **every** lever before giving up on its budget, including
  eliding the recent tool output it otherwise protects: one fresh `read_file` is 24k chars,
  so against a small budget that single result can exceed the whole allowance, and returning
  it anyway produced a request the caller then sent and the provider refused. It still
  cannot shrink the system prompt or the task itself, so a budget below those is returned
  over — the callers' floors keep the budget out of that region. The compaction summarizer is bounded the
  same way (`compactMessages`'s `maxInputTokens`) — unbounded it sent the entire conversation
  up to the tail, making it the *largest* request a run made, so on a tight allowance it
  failed twice and compaction disabled itself for the rest of the run. It is trimmed in two
  stages, before flattening (so bulky tool output can be told from narration) and after (because
  flattening adds a `[tool result] ` prefix per turn, and a bound measured before that is not
  the bound the request is judged by). Compaction also stops after two runs that leave the
  request still over the threshold: below a certain budget a summary plus one protected file
  read already exceeds it, so every further attempt buys a summarizer request and no relief.
  Tool *output* is sized to the budget too, via `ToolLimits`: `read_file`'s default 24k-char
  page is ~6k tokens, larger than the whole conversation budget on an 8k allowance, so the
  result was elided by trimming before the model could use a line of it. Reads are paged and
  name the offset to continue from, so a smaller page costs a call, not information.
  Both budget clamps also apply to the **plain streaming path** (`configuredContextTokens`
  and `effectiveMaxTokens` in `chatViewProvider.ts`) — a model without tool support, or Edit
  mode, has no agent loop to learn a ceiling in, so it has to be right on the first request.
  Within a step, adjacent
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
  models exactly and only falling back for auto-selected ones. Inference is built
  **from what the user actually holds a credential for** (`inferredPool`), never from a
  fixed table of vendor model ids: that table preferred paid frontier models nobody asked
  to spend on, and named exact ids an account may not be entitled to, so a run 404'd on its
  first request. Each credentialed provider contributes *several* models — the user's own
  selected one first, then that provider's suggestions — because representing a provider by
  one model disqualified the whole provider whenever that model failed the role's
  requirements. Candidates are then filtered by hard requirements (tool capability for
  `code`, vision when the request carries images, existence in the fetched catalog when
  there is one, and `NOT_AUTO_SELECTED_MODELS` — premium-billed models Auto must not choose
  on the user's behalf, though they stay pinnable) and ranked by `score`: the user's own
  pick outranks role affinity, which outranks the provider's own ordering. The chain is
  capped **per provider** as well as overall — five models behind one revoked key is not a
  fallback from anything. Credential reads
  are memoized per resolution pass (`CredentialMemo`), since this runs on the settings
  panel's render path and at the head of every run. `orchestrator.ts` runs the
  plan → implement → review pipeline (or a per-step decomposition when
  `openvsChat.auto.decompose` is set). Its **text phases are budgeted like every other
  request** — `streamBudgeted` + `requestBudgets`, the same pair the plain streaming path
  uses. Unbudgeted, the planner sent the conversation raw with the full configured
  reservation, so on a backend with a small per-request allowance an Auto run died in the
  planner, before the implementer — the one phase that learns a ceiling for itself — ever
  ran. Every Auto run closes with an `autoSummary` naming the model each role *actually*
  used — recorded into the session transcript with a `kind` (so it survives a tab switch,
  a reload and History, and is never sent back to a model as conversation) rather than
  merely drawn: after a runtime fallback the phase header no longer names the model that answered,
  and `test-auto-router.mjs` is what keeps the routing itself honest (nothing else exercises
  the real router — `test-agent-loop.mjs` drives the orchestrator against a stub).
- `src/completions/` — Copilot-style inline ghost-text completions, twelve small modules
  glued together by `inlineProvider.ts`'s `OpenVSInlineCompletionProvider`: `context.ts`
  (windows the prefix/suffix around the cursor, LF-normalized, with the file's import block
  extracted separately so a window that has slid past the top doesn't lose it),
  `exclusions.ts` (credential-file and secret-line denylist, scheme allowlist, trust and
  language gates — see below), `prompt.ts` (the FIM stop sequences and the chat-fallback
  two-turn prompt), `sanitize.ts` (repairs a chat model's reply into insertable text — see
  below), `cache.ts` (position → suggestion, covers backspacing over a rejected suggestion
  or undoing, which the editor's own `enableForwardStability` does not), `health.ts` (a
  p95-latency breaker so a backend that queues for twenty seconds stands down instead of
  reading as "the feature is broken"), `scheduler.ts` (one in-flight request at a time, plus
  a token-budget gate that gives way to a running Agent step), `completionModel.ts`
  (resolves the `complete` role to a provider+model, including a debounced, never-awaited
  reachability probe for the local endpoint), `statusBar.ts` and `stats.ts` (why the feature
  is silent right now, and whether what it *does* show is actually being accepted — the
  only measurement that says the feature works, since the model pool here is whatever
  free-tier backend the user happens to hold a key for and quality varies enormously), and
  `types.ts` (the shared `CompletionWindow`/`CompletionOutcome` shapes).
  **FIM vs. chat is a real fork, not a fallback formality**: a genuine fill-in-the-middle
  endpoint (Ollama/LM Studio's legacy completions endpoint with `suffix`, or Mistral's
  `codestral`/`devstral`) is a different wire format with different stop sequences
  (`FIM_STOP`, a single blank line — a fence would never fire there) from the two-turn chat
  prompt every other backend gets (`COMPLETION_STOP`, a fence or a triple newline), because
  none of the free-tier chat backends this extension targets are completion models: asked to
  continue code, they narrate, fence, and frequently echo back the prefix and suffix they
  were just given. **The sanitizer in `sanitize.ts` is load-bearing, not cosmetic** — every
  rule in it (strip an inline reasoning block, unwrap or reject a fence, drop a restated
  prefix/suffix by longest-overlap, cap lines, cut at the first line that both dedents and
  closes a bracket) corresponds to a failure mode actually observed from those backends, runs
  in a fixed order because later rules assume earlier ones already fired, and is what stands
  between a raw completion and a user seeing "sure, here's the completion:" as ghost text or
  a doubled closing brace. Stating the constraints in the prompt (`prompt.ts`'s `SYSTEM`)
  measurably reduces how often the sanitizer has to act, but does not make it optional.
  **Routing for `complete` inverts several rules the Auto roles rely on.** It is a fourth
  member of `RoutedRole` (`AutoRole | 'complete'`) resolved on its own — deliberately never
  added to `AUTO_ROLES`, which drives `resolveAll()` and the Auto settings rows, so a
  completion entry can't leak into the Auto pipeline's phases. `scoreForRole` rewards a
  small/fast checkpoint for `complete` (`LIGHTWEIGHT_WEIGHT` is *added*) where every Auto
  role penalizes one (*subtracted*), because latency is the dominant quality term when a
  suggestion that arrives after the cursor has moved scores zero however good it is; its own
  `ROLE_AFFINITY` pattern looks for coder/FIM-specific names instead of the Auto roles'
  large-model signals; and `NOT_COMPLETION_MODELS` hard-excludes anything that reasons before
  answering (`-r1`, `think`, `qwq`, bare `o[1-9]`, `reason`), on top of the premium-billed
  `NOT_AUTO_SELECTED_MODELS` set every role already avoids auto-selecting. The `custom`
  provider is the other inversion: every Auto role keeps it out of inference because a local
  endpoint may not be running, but `complete` admits it once a cheap reachability probe
  succeeds, because a local FIM model (Ollama's `qwen2.5-coder` is the suggested default) is
  the fastest, cheapest backend available and — unlike the Auto case — that premise is
  actually testable in under a couple seconds.
  **Non-interference constraints future work must preserve**, enforced statically by
  `test-completion-isolation.mjs` rather than left to review: never call the module-global
  `setStreamIdleTimeout` (it would change chat's stall detection too) or `ProviderRegistry`'s
  `.setModel(` (that writes the *chat* model setting, `openvsChat.<provider>.model` — the
  picker in `inlineProvider.ts` writes `openvsChat.completions.model` instead, so the two
  settings can't collapse into each other); never call `agentRunner`'s `adoptRequestCeiling` (a
  96-token completion must not tighten a budget an Agent run is relying on); and use
  `rateLimits.noteOnlyOpts()`, never the streaming path's `fetchOpts()`, when recording a
  completion response's rate-limit headers — `fetchOpts` bundles a `pace` hook that sleeps
  out a refill window, which is correct for a step that can afford to wait and wrong for a
  request whose cursor position may no longer exist by the time it would resolve.
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
