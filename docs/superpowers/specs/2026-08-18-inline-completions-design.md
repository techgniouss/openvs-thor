# Inline Completions (Ghost Text) — Design

Date: 2026-08-18
Status: Approved design, pending implementation plan
Scope: `extensions/openvs-chat` only. No changes to `src/vs/**`.

## 1. Goal

Copilot-style inline code completion: as the user types, propose the continuation at the
cursor as ghost text, accepted with `Tab`. Multi-provider, driven by whatever credentials
the user already holds. The completion model is chosen independently of the chat model,
auto-routed by default and pinnable by the user.

Out of scope for v1: Next Edit Suggestions (`isInlineEdit` / `showRange`). The API
proposal is wired in v1, so v2 is additive.

## 2. Why the chat path cannot be reused as-is

Every backend in `providers/` is a *chat* provider. Copilot does not use chat: it uses a
fill-in-the-middle model at a `/completions` endpoint with a `suffix` parameter,
~150–400 ms, `max_tokens` ≈ 64, with stop sequences. Three consequences drive this design:

1. **Chat models do not emit ghost text.** They emit fenced markdown, a re-stated prefix,
   and prose preambles. Sanitization is load-bearing, not cosmetic.
2. **Reasoning models are disqualified.** A model that emits `reasoning_content` for
   seconds before any code is a broken completion source, not a slow one. This must be a
   hard exclusion, and — like `toolModelPatterns` — it fails silently if the table drifts,
   so it needs a test that checks the table against the model lists it describes.
3. **Quota is shared with Agent mode.** Completions fire per typing pause. Ungoverned,
   they will drain the same free-tier budget agent runs depend on, and
   `providers/rateLimits.ts` already documents that Groq counts *failed* requests against
   the daily budget.

## 3. Non-interference contract

Existing chat, Agent, Auto, and Edit functionality must be observably unchanged. The
following are the actual coupling points, each with its rule.

| Shared state | Rule |
|---|---|
| `providers/types.ts` `ChatProvider` | Additive only: optional `completeFim?()`. `streamChat` / `runAgentStep` untouched. |
| `ProviderInfo` | Additive only: optional `fimModelPatterns`. Absent means "no FIM", which is the existing behaviour of every provider. |
| **`streamIdleMs` (`types.ts:475`)** | **Module-global**, set once from `extension.ts:28`. Completions MUST NOT call `setStreamIdleTimeout` — doing so would change chat's stall detection globally. Use the per-request `ReadSSEOptions.idleMs` override (`types.ts:542`). |
| **`ProviderRegistry.setModel(id, model)`** | Writes `openvsChat.<id>.model` — the **chat** model. The native completion model dropdown MUST NOT route here. `setCurrentModelId` writes `openvsChat.completions.model` only. |
| `RateLimitTracker` (provider singleton) | Completions **read** snapshots and **do** contribute header readings (real data beats stale). Completions MUST NOT call `adoptRequestCeiling` — a 96-token reservation must never tighten an agent run's budget. One-way boundary. |
| **`rateLimits.fetchOpts(model)`** | Bundles `onResponse` **and** `pace`, and its own doc-comment requires the two halves agree. Completions need the first without the second — a completion that waits out a refill window is stale on arrival, so it skips instead of sleeping. Add `RateLimitTracker.noteOnlyOpts(model)` returning `{ onResponse }` alone, rather than copying the line, per that file's stated rationale. Chat and Agent keep using `fetchOpts` unchanged. |
| `auto/router.ts` `AUTO_ROLES` | Unchanged (`['plan','code','review']`). The Auto pipeline, `resolveAll()`, and the Auto settings rows must not gain a completion entry. Only the `RoutedRole` union widens. |
| `chatViewProvider.ts` | **Additive only.** Registration lives in `extension.ts`. The settings panel toggle (§11a) adds new `case` arms to the existing message switch, in the exact shape of the existing boolean rows `setReviewEnabled` (`:1325`) and `setDecompose` (`:1384`). No existing arm is modified; no change to chat, Agent, Auto, or Edit dispatch. |
| `media/main.js` + `test-webview.mjs` | The settings panel is a webview. A new row means new element ids and new message types in both directions, which `test-webview.mjs` exists to pin. Both are updated together or the guard fails — which is the point of that test. |
| Settings namespace | Everything under `openvsChat.completions.*`. No reuse of `openvsChat.maxTokens` or `openvsChat.<id>.model`. |
| SecretStorage | Read-only, existing keys, via `registry.getApiKey`. |
| Output channel | Its own channel. Does not write to the chat channel. |
| Activation | `onStartupFinished` already; unchanged. |

A regression guard (`test-completion-isolation.mjs`) asserts the two dangerous ones
directly: that the completion path never calls `setStreamIdleTimeout` or
`registry.setModel`.

## 4. API surface

Uses the **proposed** `inlineCompletionsAdditions` API, not stable-only. The extension is
built-in, so declared proposals are granted — `extensionsProposedApi.ts:110` only nulls
proposals for `!extension.isBuiltin`; the `product.json` allowlist governs marketplace
extensions. Two lines of wiring:

- `package.json` → `enabledApiProposals: ["findTextInFiles", "contribSourceControlInputBoxMenu", "inlineCompletionsAdditions"]`
- `tsconfig.json` → add `"../../src/vscode-dts/vscode.proposed.inlineCompletionsAdditions.d.ts"` to `include`

Stable-only was rejected: it provides no accept signal, no partial-accept, no debounce
control, no model picker, and no NES path.

What the proposal supplies, and what each replaces:

| Proposal member | Use |
|---|---|
| `InlineCompletionList.enableForwardStability` | Editor stops re-requesting while the user types the suggestion verbatim. Replaces the hand-written typing-through path. |
| `InlineCompletionItemProviderMetadata.debounceDelayMs` | Editor debounces before invoking the provider. Internal debounce is a backstop only. |
| `handleEndOfLifetime(item, reason)` | `Accepted` / `Rejected` / `Ignored{userTypingDisagreed}` → per-model acceptance rate. |
| `handleDidPartiallyAcceptCompletionItem(item, {kind, acceptedLength})` | Word / line / suggest partial accepts. |
| `handleDidShowCompletionItem(item, updatedInsertText)` | Reports the text after the editor's own bracket repair — used instead of fighting auto-close. |
| `modelInfo` / `setCurrentModelId` / `onDidChangeModelInfo` | Native model dropdown in the inline-suggest UI. This is the user-facing model picker. |
| `providerOptions` / `setProviderOptionValue` | Reserved; unused in v1. |
| `yieldTo` / `excludes` | Coexistence with any other inline provider. |
| `requestUuid` / `requestIssuedDateTime` / `earliestShownDateTime` | Latency instrumentation. |
| `isInlineEdit` / `showRange` / `displayLocation` | v2 (NES). Wired, unused. |

## 5. Architecture

New directory `extensions/openvs-chat/src/completions/`. No completion *logic* lands in
`chatViewProvider.ts` (3230 lines already) — its only change is the settings-toggle case
arm in §11a, which forwards to a configuration write and nothing else.

| File | Purpose | Depends on |
|---|---|---|
| `types.ts` | `CompletionContext`, `CompletionResult`, `FimRequest` | — |
| `context.ts` | Document + position → prefix/suffix window, import header, EOL normalization | vscode types |
| `exclusions.ts` | Secret and glob denial, scheme filter, trust check | vscode types |
| `prompt.ts` | Chat-fallback instruct prompt (FIM needs none) | `types` |
| `sanitize.ts` | **Pure.** Raw model text → ghost text or nothing | — |
| `cache.ts` | Prefix/suffix-keyed reuse for backspace and re-entry | — |
| `health.ts` | Rolling p95 latency, slow-provider breaker | — |
| `scheduler.ts` | Single-flight, quota floor, backstop debounce | injected snapshot + clock |
| `stats.ts` | Acceptance rates from lifecycle callbacks; feeds router ranking | — |
| `completionModel.ts` | Resolve provider + model for completions | `RoleRouter`, `ProviderRegistry` |
| `inlineProvider.ts` | The `InlineCompletionItemProvider`. Glue only. | all of the above |
| `statusBar.ts` | idle / working / paused-quota / paused-slow / error | — |

Provider-layer changes, all additive:

- `providers/types.ts` — `ChatProvider.completeFim?(req: FimRequest): Promise<string>`;
  `ProviderInfo.fimModelPatterns: string[]`; `COMPLETION_FETCH_OPTS`.
- `providers/openaiCompatible.ts` — `/completions` with `suffix`. This single change gives
  FIM to `custom.ts`, i.e. Ollama / LM Studio / vLLM.
- `providers/mistral.ts` — `/v1/fim/completions` (Codestral).
- All other providers declare nothing and take the chat fallback.

## 6. Model routing

`auto/router.ts` gains `export type RoutedRole = AutoRole | 'complete'`. `AUTO_ROLES` is
deliberately **not** extended — that would leak a completion row into the Auto settings
panel and into `resolveAll()`. `ROLE_AFFINITY`, `ROLE_SETTING`, and `ROLE_LABELS` widen to
`RoutedRole`.

**Pin storage.** `ROLE_SETTING` stores one `provider:model` string per role
(`auto.planModel`, …), read and written by the already-tested `getConfigured` /
`setConfigured`. The `complete` role therefore uses a single key,
`ROLE_SETTING.complete = 'completions.model'`, holding `provider:model` in the same shape.
An earlier draft of this spec specified two separate keys (`completions.provider` plus
`completions.model`); that contradicted the mechanism it claimed to reuse, and
`completions.provider` is dropped.

Four adjustments apply only to `complete`. The first three exist because this role wants
the **opposite** of what the Auto roles want:

- **Its own affinity row**, not a reuse of `code`. `ROLE_AFFINITY.code` deliberately
  matches `deepseek`, `-r1`, `think` and `70b`/`120b` — every one of which is wrong here.
  `complete` matches
  `/codestral|devstral|coder|-code|starcoder|codegemma|ministral|instant|mini|flash|\b[1-9]b\b/i`.
- **`LIGHTWEIGHT` inverts to a bonus.** For Auto roles a small checkpoint ranks *below* its
  larger sibling; for completion a 3B model at 200 ms beats a 70B model at 4 s, because a
  completion that arrives after the cursor moved is worth nothing regardless of quality.
- **`NOT_COMPLETION_MODELS`** — reasoning and thinking models (`/r1/`, `/thinking/`,
  `/qwq/`, `/\bo[13]\b/`) plus the existing `NOT_AUTO_SELECTED_MODELS` set. **Hard
  exclusion**, not a rank penalty. Note `custom.ts` suggests `deepseek-r1` by default, so
  this filter is load-bearing from day one.
- **`fimModelPatterns` match ranks to the top.**

**`custom` must be inferrable for this role.** `NOT_AUTO_INFERRED` excludes `custom` and
`antigravity`, on the stated grounds that a local endpoint "may well not be running". For
Auto that is right. For completion it is backwards: a local FIM model at ~100 ms with zero
quota cost is the single best backend available, and unlike the Auto case the premise is
cheaply testable. So for `complete` only, `custom` enters the pool **if** a reachability
probe succeeds — a `GET /models` against its base URL, cached with a short TTL and never
run on the provider's typing path. `antigravity` stays excluded. Without this, the best
completion backend in the system could never be auto-selected, only manually pinned.

Everything else is reused unchanged: credential-derived `inferredPool`, exact honouring of
pins, per-provider chain cap, `CredentialMemo`.

Once `stats.ts` has enough samples, measured acceptance rate becomes an additional ranking
input, ahead of affinity but behind an explicit user pin.

## 7. Request shape

Context per request (~1k tokens): prefix ≈ 2000 chars before the cursor, suffix ≈ 1000
chars after, plus language id, workspace-relative path, and the file's own import block —
the import block is what keeps the model using the project's real library names.

- Timeouts: `COMPLETION_FETCH_OPTS = { timeoutMs: 2500 (automatic) | 10000 (invoke), retries: 0 }`.
  Retries are zero: a retried completion is stale by arrival, and failed requests count
  against free-tier daily budgets.
- `maxTokens` 96. Temperature low. Stop sequences: chat `["\n\n\n", "```"]`, FIM
  single-line `["\n\n"]`.
- Per-request `ReadSSEOptions.idleMs`, never the global setter.

## 8. Sanitizer

Seven failure classes, all pure functions:

1. **Fence wrapper** — strip fences, keep inner content.
2. **Preamble prose** — if a fence exists keep only fenced content; otherwise drop leading
   lines that do not syntactically continue the prefix.
3. **Re-emitted prefix** — longest overlap between prefix tail and output head, dropped.
4. **Re-emitted suffix** — longest overlap between output tail and suffix head, dropped.
   Prevents doubled closing brackets.
5. **Runaway multi-line** — cap at `maxLines`; cut at the first line whose indent falls
   below the cursor line's (block exit).
6. **No-op** — output equal to text already present returns nothing.
7. **Inline thinking** — strip `<think>…</think>` at text level; `reasoning_content` is
   already dropped at the provider layer.

## 9. Governance

- Editor-side debounce via `debounceDelayMs` (250 ms default); `Invoke` bypasses it.
- Single-flight: a new keystroke aborts the in-flight request; VS Code's
  `CancellationToken` is wired to the `AbortController`.
- `enableForwardStability: true` on every returned list.
- Cache keyed on `hash(model, prefixTail(1024), suffixHead(512))`, serving backspace and
  re-entry.
- **Quota floor**: read `provider.rateLimit(model)`. Below `quotaReserve` (15 %) of the
  window, automatic completions pause and the status bar says why; Agent mode keeps the
  remainder. Manual trigger overrides. A snapshot older than `SNAPSHOT_TTL_MS` counts as
  no opinion and permits the request.

  **Scope limit, stated plainly:** `RateLimitSnapshot` carries `limitTokens`,
  `remainingTokens`, `resetMs`, `at` — and **no request-count fields**. So this floor
  governs the *token* window only. It cannot see a daily *request* budget, which is exactly
  what Groq's free tier meters and what a per-keystroke feature threatens most. Protection
  against request-count exhaustion comes from the editor debounce, single-flight,
  `enableForwardStability`, the cache, and the slow-provider breaker — not from headers.
  An earlier draft of this spec implied the floor covered both; it does not.
- **Slow-provider breaker**: rolling p95 per model. Above `slowMs` (3000) over the last 5 samples,
  automatic mode suspends and the status bar names a faster pinnable model. Without this,
  a queued free tier reads to the user as "the feature is broken".
- 429 → abortable exponential backoff, automatic paused until reset.

## 10. Safety and correctness rules

- **Secret exclusion.** Hard-deny `.env*`, `*.pem`, `*.key`, `*.p12`, `*.jks`, `id_rsa*`,
  `.npmrc`, `.pypirc`, plus the user glob `completions.excludeFiles`. Additionally, never
  send a window whose cursor line matches a known credential prefix (`sk-`, `ghp_`,
  `AKIA`, `xoxb-`, `-----BEGIN`). Completions transmit file content on every typing pause;
  without this the feature is a continuous exfiltration channel.
- **Untrusted workspaces**: completions off by default, `completions.untrusted` to enable.
- **Scheme filter**: `file`, `untitled`, `vscode-notebook-cell` only. Never the SCM commit
  box, output panel, debug REPL, or diff/merge editors.
- **`selectedCompletionInfo`**: when the suggest widget is open, the item must extend the
  selected item's text and reuse its range, or it silently will not render.
- **CRLF**: normalize on the way in, re-apply `document.eol` on the way out. Windows is the
  primary platform here.
- **Near-empty prefix at file start**: invoke-only, no automatic request.
- **Comments**: completion inside comments stays enabled (`completions.inComments`,
  default true). Precise comment/string detection is not attempted — the extension host
  has no tokenizer access, and a wrong heuristic is worse than none.

## 11. Settings

```
openvsChat.completions.enabled            bool      true
openvsChat.completions.model              string    ''     ('' = auto-route; else 'provider:model')
openvsChat.completions.debounceMs         number    250
openvsChat.completions.maxLines           number    6      (invoke uses 20)
openvsChat.completions.prefixChars        number    2000
openvsChat.completions.suffixChars        number    1000
openvsChat.completions.maxTokens          number    96
openvsChat.completions.quotaReserve       number    0.15
openvsChat.completions.slowMs             number    3000
openvsChat.completions.disabledLanguages  string[]  []
openvsChat.completions.excludeFiles       string[]  []
openvsChat.completions.inComments         bool      true
openvsChat.completions.untrusted          bool      false
```

Commands: `openvsChat.completions.toggle`, `.trigger` (`alt+\`), `.pickModel`,
`.showStats`.

## 11a. Enable / disable surfaces

The user must be able to turn inline suggestions on and off without editing JSON. Four
surfaces, all writing the same `openvsChat.completions.enabled` setting so none of them can
disagree:

1. **Extension settings panel** — an "Inline Completions" section with an Enabled toggle
   and the model row beside it. This is the primary surface, since it is where providers and
   keys are already configured. Implemented as a new boolean row following the existing
   `setReviewEnabled` / `setDecompose` pattern: element ids and a message type in
   `media/main.js`, an additive `case` arm in `chatViewProvider.ts`, and the matching entry
   in `test-webview.mjs`, which pins that contract in both directions.
2. **VS Code Settings UI / `settings.json`** — `openvsChat.completions.enabled`, plus the
   per-language `completions.disabledLanguages` list for finer control.
3. **Status bar item** — click to toggle. Also the surface that reports *why* completions
   are currently silent (paused on quota, paused as slow, no model, excluded file), which a
   plain checkbox cannot express.
4. **Command** — `openvsChat.completions.toggle`, palette-accessible and bindable.

Disabling must be immediate and total: the provider is disposed rather than left registered
and returning empty, so no request is built, no document is read, and the editor stops
calling us at all. Re-enabling re-registers. `onDidChangeConfiguration` drives both.

The editor's own `editor.inlineSuggest.enabled` remains an independent global kill switch
owned by VS Code; when it is off nothing is requested regardless of our setting, and the
status bar says so rather than appearing broken.

## 12. Degradation

| Condition | Behaviour |
|---|---|
| No credential / no eligible model | Silent no-op; status bar "no model"; never throws |
| Quota below reserve | Automatic paused, manual allowed, Agent budget preserved |
| p95 above `slowMs` | Automatic suspended; status bar names a faster model |
| HTTP 429 | Abortable backoff; automatic paused until reset |
| Timeout | Discard, no retry, counted toward p95 |
| Provider error | Output channel + status bar only. No modal, no notification |
| Cancellation | Silent |
| Excluded file / untrusted workspace | No request built at all |

## 13. Testing

New scripts under `extensions/openvs-chat/scripts/` — the runner auto-discovers `test-*.mjs`, so no registration is needed —
following the repo rule that dependencies are injected rather than globals stubbed:

- `test-completion-sanitize.mjs` — the seven failure classes, table-driven, one
  `deepStrictEqual` snapshot.
- `test-completion-context.mjs` — windowing at file start and end, very large file, CRLF,
  notebook cell.
- `test-completion-exclusions.mjs` — secret files, user globs, scheme filter, trust gate.
- `test-completion-cache.mjs` — backspace reuse, model-change invalidation.
- `test-completion-scheduler.mjs` — single-flight, quota floor, breaker; injected fake
  clock and fake rate-limit snapshot.
- `test-completion-wire.mjs` — FIM vs chat request bodies, following the
  `test-provider-messages.mjs` precedent for pinning wire formats.
- `test-completion-router.mjs` — `complete` role inference, reasoning exclusion (including
  `custom`'s default `deepseek-r1` suggestion), inverted `LIGHTWEIGHT` ranking, `custom`
  admitted only when the probe succeeds, pin round-tripped through the single
  `completions.model` key, per-provider cap, and that `AUTO_ROLES` is unchanged.
- `test-webview.mjs` (extended) — the settings-panel toggle's element ids and message types
  in both directions, per §11a.
- `test-completion-isolation.mjs` — the non-interference contract: no
  `setStreamIdleTimeout` call, no `registry.setModel` call from the completion path.
- Extend `test-model-axes.mjs` with the `fim` and `completion-safe` axes, so a newly added
  provider cannot ship a suggested model that silently has no working completion path.

Ghost-text rendering and the model dropdown are verified by hand in the Extension
Development Host, consistent with the rest of the repository.

## 14. Build order

1. Proposal wiring; `completeFim?`, `fimModelPatterns`, `COMPLETION_FETCH_OPTS` — compiles, inert.
2. `context.ts`, `exclusions.ts`, `sanitize.ts`, `prompt.ts` — pure, fully tested before any network call.
3. `openaiCompatible` `/completions`+`suffix`; `mistral` `/v1/fim/completions`.
4. `completionModel.ts` and the `RoutedRole` widening.
5. `scheduler.ts`, `cache.ts`, `health.ts`.
6. `inlineProvider.ts`, provider metadata, lifecycle handlers, `statusBar.ts`.
7. `stats.ts`; acceptance rate feeds router ranking.
8. Settings keys, commands, keybinding.
9. Settings-panel toggle (§11a): `media/main.js` row, additive `chatViewProvider.ts` case
   arm, `test-webview.mjs` contract entry. Last, because it is the only step that touches
   the chat webview and it must land on a feature that already works headlessly.
10. README.

`npm run typecheck --prefix extensions/openvs-chat` throughout (it covers `media/main.js`
too, via `// @ts-check` and `media/webview.d.ts`);
`npm run gulp compile-extensions` before the work is called done. Chat, Agent, Auto, and
Edit regression checks run at steps 1, 4, 6, and 9 — the four steps that touch shared
files.
