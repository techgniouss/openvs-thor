# Antigravity (Google) provider for openvs-chat

**Date:** 2026-07-18
**Status:** Approved design — pending implementation plan
**Area:** `extensions/openvs-chat`

## Summary

Add an optional, experimental chat provider that authenticates with Google via the
**Antigravity IDE** OAuth client and serves the premium models Google fronts through its
internal **CloudCode** gateway (Claude, Gemini, GPT-OSS). Reverse-engineered from the
now-archived [`NoeFabris/opencode-antigravity-auth`](https://github.com/NoeFabris/opencode-antigravity-auth).

The provider is **off by default**, gated behind an experimental setting, and the sign-in
flow requires an explicit, modal opt-in acknowledging the risks below.

## Risks (must stay visible to users)

1. **Violates Google's Terms of Service.** Using an unofficial client against Antigravity's
   backend can get the user's Google account **suspended**. The upstream project documents
   this explicitly.
2. **Upstream was archived 2026-07-17 (read-only).** Strong signal Google clamped the client
   or endpoint. The endpoints may already be dead — the first live call may return 404/410.
3. **The `client_secret` is Google's app identity, extracted from their shipping IDE.** Google
   can revoke it at any time, which breaks the provider for everyone.

These risks are surfaced (a) in the experimental setting description, (b) as a modal
warning gating the first sign-in, and (c) as an in-panel caution banner.

## What was reverse-engineered

- **OAuth 2.0 authorization-code + PKCE (S256).**
  - Auth URL: `https://accounts.google.com/o/oauth2/v2/auth`
  - Token URL: `https://oauth2.googleapis.com/token`
  - Redirect (loopback): `http://localhost:51121/oauth-callback`
  - `client_id` (public, not secret): `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
  - `client_secret`: **required** at code exchange and refresh (app identity). Not committed — see Credential Handling.
  - Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`.
- **Project resolution:** `POST {base}/v1internal:loadCodeAssist` with
  `{ metadata: { ideType: "ANTIGRAVITY", platform: "WINDOWS"|"MACOS", pluginType: "GEMINI" } }`;
  read `cloudaicompanionProject` (string) or `cloudaicompanionProject.id` (object).
- **Chat gateway:** `POST {base}/v1internal:streamGenerateContent?alt=sse`, base
  `https://cloudcode-pa.googleapis.com`. Gemini request/response wire shape (see Transform).
  Spoofed headers identify the request as the Antigravity IDE:
  `User-Agent: antigravity/<ver> windows/amd64`, `X-Goog-Api-Client`, `Client-Metadata`,
  `Authorization: Bearer <access>`, `Accept: text/event-stream`.
- **Models:** `gemini-3-pro-high`, `gemini-3-pro-low`, `claude-sonnet-4-6`,
  `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`.

## Credential handling (decision A, refined)

- `client_id` ships as a code default (public value; not a secret).
- `client_secret` is read from `ANTIGRAVITY_CLIENT_SECRET` env, else from VS Code
  **SecretStorage** (prompted once, on first sign-in). It is **never** a plaintext
  `settings.json` value — this honors the repo rule "keys live in SecretStorage, never
  plaintext settings" while keeping the ToS-violating credential choice explicitly in the
  user's hands.

## Scope (approved)

- **Multi-account rotation:** yes (lean — see Account Store).
- **Agent mode (tool calling):** yes (full Gemini `functionDeclarations` transform).
- **Out of scope (follow-ups):** Gemini-CLI quota fallback, fingerprinting, cached-quota
  soft thresholds, verification/challenge handling, per-model-family active pointers.

## Architecture

Fits the existing `providers/` + `oauth.ts` pattern. The closest analog is
`providers/chatgptBackend.ts`: an OAuth-token-based transport that transforms a non-OpenAI
wire format to/from the internal `ChatMessage` model.

### New files (`extensions/openvs-chat/src/`)

#### 1. `antigravity/accounts.ts` — `AntigravityAccountStore`

Lean multi-account pool. Persists to SecretStorage key `openvsChat.antigravity.accounts`
as JSON.

Account record:

```
{
  id: string;              // stable local id
  email: string;
  refresh: string;         // Google refresh token
  projectId: string;
  access?: string;         // cached access token
  expires?: number;        // absolute ms expiry of `access`
  enabled: boolean;
  cooldownUntil?: number;  // absolute ms; account is skipped until then
  cooldownReason?: string;
}
```

Methods:

- `add(record)`, `list()`, `remove(id)`, `setEnabled(id, bool)`
- `current()` — the sticky active account, skipping disabled / cooling-down accounts.
- `next()` — advance the sticky pointer to the next healthy account.
- `markLimited(id, resetMs, reason)` — set `cooldownUntil` via exponential backoff.
- `getFreshToken(account)` — return a valid access token, refreshing via Google
  (`refreshAntigravityToken`) and re-persisting when expired.

Selection strategy: **sticky** — stay on the active account until it hits a 429/quota
error, then advance to the next healthy account. Cooldown is per-account exponential
backoff. If every account is cooling down, `current()` reports the soonest-available time
so callers can surface "next available in Xs".

Injectable dependency for tests: takes `vscode.SecretStorage` (a fake implementing the
real interface is used in unit tests — no global stubbing).

#### 2. `antigravity/auth.ts` — OAuth sign-in

- `signInAntigravity(store, clientSecret): Promise<string | undefined>` — PKCE S256; starts a
  one-shot loopback HTTP server on `127.0.0.1:51121` serving `/oauth-callback` (mirrors the
  existing `waitForOpenAICallback` in `oauth.ts`); opens the Google authorize URL; exchanges
  the code (form POST to the token URL, including `client_secret` + `code_verifier`); fetches
  the account email (`https://www.googleapis.com/oauth2/v1/userinfo`); resolves `projectId`
  via `loadCodeAssist`; adds the account to the pool. Returns the email, or `undefined` on
  cancel.
- `refreshAntigravityToken(refresh, clientSecret): Promise<Refreshed | 'invalid'>` — form POST
  `grant_type=refresh_token` with `client_id` + `client_secret`.
- `ANTIGRAVITY_CLIENT_ID` constant (public default).

#### 3. `providers/geminiTransform.ts` — pure, unit-testable functions

- `toGeminiRequest(messages, tools, maxTokens)` → request body:
  `{ contents[], systemInstruction, generationConfig, tools?: [{ functionDeclarations }] }`.
  - Role map: `user`→`user`, `assistant`→`model`, `tool` result→a `user`-role part with
    `functionResponse`, `system`→`systemInstruction`.
  - Images → `inlineData` parts (`{ mimeType, data }`).
  - Assistant `toolCalls` → `functionCall` parts (`{ name, args }`).
  - `tools` wrapped as `[{ functionDeclarations: [{ name, description, parameters }] }]`.
- `parseGeminiCandidate(json)` → `{ text?: string, toolCall?: ToolCall }` from
  `candidates[0].content.parts[]` (a part is either `{ text }` or `{ functionCall: { name, args } }`).

Kept pure and separate so the wire format is testable without network or auth.

#### 4. `providers/antigravity.ts` — `AntigravityProvider implements ChatProvider`

- Constructed with the `AntigravityAccountStore` and a `clientSecret` getter, making it the
  one rotation-aware provider (analogous to `chatgptBackend` reaching into `oauth.ts`). It
  ignores `request.apiKey` and instead pulls `{ token, projectId }` from the store.
- `streamChat` / `runAgentStep`: build the Gemini body via `geminiTransform`, `POST`
  `{baseUrl}/v1internal:streamGenerateContent?alt=sse` with the spoofed IDE headers and
  `Authorization: Bearer <token>`, parse the SSE `candidates` stream via `parseGeminiCandidate`.
  On HTTP 429 **before the first token is emitted**, call `markLimited` + `next` and retry,
  bounded by the pool size. (A mid-stream failure is surfaced, not retried, to avoid
  duplicated output.)
- `listModels`: returns the static model list.
- `info`: `id: 'antigravity'`, `label: 'Antigravity (Google)'`, `requiresApiKey: false`,
  `supportsTools: true`, `toolModelPatterns: []` (all models), `visionModelPatterns: []`
  (gemini/claude assumed vision-capable).

### Wiring (existing files)

- **`providers/registry.ts`**
  - Construct one `AntigravityAccountStore(secrets)`.
  - Register `AntigravityProvider` **only when `openvsChat.antigravity.enabled` is true**
    (gating by registration = the provider is invisible unless enabled; toggling the flag
    requires a window reload, noted in the setting description).
  - Add an `antigravity` branch to `getApiKey` (return the current account's fresh access
    token so credential gates pass), `hasCredentials` (true when the pool is non-empty), and
    `getAuthKind` (`'oauth'`). No env-var key mapping.
- **`extension.ts`**
  - `openvsChat.antigravity.addAccount`: show a **modal** ToS/ban warning
    (`showWarningMessage(..., { modal: true }, 'I understand, continue')`); on consent, ensure a
    `client_secret` is available (prompt + store in SecretStorage if unset, with an explanation);
    run `signInAntigravity`.
  - `openvsChat.antigravity.manageAccounts`: list accounts, toggle enabled, remove.
- **`chatViewProvider.ts` + `media/main.js`**
  - In the settings panel, when the provider is present: show "＋ Add Google account", the
    account list (email + enable toggle + remove), and an in-panel caution banner. Reuses the
    existing provider-row message protocol.
- **`package.json`**
  - Settings: `openvsChat.antigravity.enabled` (boolean, default `false`, description carries
    the ToS warning and "requires reload"); `openvsChat.antigravity.baseUrl` (default
    `https://cloudcode-pa.googleapis.com`); `openvsChat.antigravity.model`;
    `openvsChat.antigravity.rotationStrategy` (enum `sticky`, default `sticky` — round-robin is
    a follow-up). **No** plaintext `clientSecret` setting.
  - Commands: `antigravity.addAccount`, `antigravity.manageAccounts`.

## Data flow

Enable flag → reload → provider appears → "Add Google account" → modal ToS consent →
(prompt + store `client_secret` if unset) → browser OAuth → loopback callback → code exchange
→ `projectId` resolve → account added to pool → pick model → chat/agent: provider selects the
current account, builds the Gemini request, sends spoofed headers, streams; on 429 it rotates
to the next healthy account.

## Error handling

- Missing `client_secret` → message explaining how to set it (env or the prompt).
- `invalid_client` at token endpoint → secret is wrong or revoked.
- All accounts cooling down → "all N accounts rate-limited, next available in Xs".
- Refresh returns 401/403 → mark the account as needing re-auth and rotate.
- Chat call returns 404/410 → "the Antigravity backend may have been shut down" (the upstream
  repo was archived).

## Plan step 0: connectivity probe (build-gate)

Because the upstream repo was archived 2026-07-17, the endpoints may already be dead. The
first implementation step is a **throwaway standalone probe** (a small script run outside the
extension) that: runs the OAuth flow once for one account, resolves `projectId` via
`loadCodeAssist`, and makes one `streamGenerateContent` call. If it 404/410s or the client is
rejected (`invalid_client`), **stop** — the backend is gone and the rest of the build is moot.
Only proceed to the provider once the probe returns a real completion. The probe is not
shipped.

## Testing

- **`geminiTransform.ts`** — mocha unit tests (`test/unit` style, `tdd`), preferring
  `assert.deepStrictEqual` snapshots: message→`contents` mapping (roles, images, tool
  results), tool→`functionDeclarations` wrapping, and `candidates` parsing (text + functionCall).
- **`AntigravityAccountStore`** — unit tests with an injected fake `SecretStorage`
  (implements the real interface): add/list/remove, sticky `current`/`next`, `markLimited`
  cooldown + backoff, all-cooling-down reporting.
- **Manual** — Extension Development Host: enable the flag, add an account, exercise
  chat and Agent mode. (There is no extension test suite in `openvs-chat`.)

## Coding-standard notes

- Tabs; OpenVS copyright header (match the variant already in `openvs-chat`).
- Constructor-injected dependencies (SecretStorage, clientSecret getter); no globals stubbed.
- Register the loopback server / listeners as disposables; return `IDisposable` from
  helpers rather than attaching to long-lived objects.
- Externalize user-facing strings appropriately for an extension (this extension uses plain
  strings in commands; match the surrounding files).
