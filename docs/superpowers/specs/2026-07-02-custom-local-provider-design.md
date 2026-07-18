# Custom (Local / Self-hosted) Provider — Design

## Context

This is sub-project 2 of the effort to bring `extensions/openvs-chat` to
Cursor/Antigravity-level capability. Sub-project 1 (image attachments, shipped
2026-07-01) added vision support across all providers. This sub-project makes
open-source and local models a first-class option: a user should be able to run
Ollama (or LM Studio, vLLM, OpenRouter, Together, Kimi, or any other
OpenAI-compatible endpoint) and pick it directly from the provider dropdown —
no API key required for local runners, an optional key for hosted gateways.

Today this is only half-possible via a hidden trick: overriding
`openvsChat.openai.baseUrl` to point at a local endpoint. That hijacks the
OpenAI provider's identity (wrong label, wrong suggested models, key still
demanded) and isn't discoverable. This design replaces the trick with a real
provider.

Remaining sub-project (separate spec later): overall chat-panel UI/UX parity
pass.

## Goals

- A fourth provider, **Custom (Local / Self-hosted)**, appears in the provider
  picker alongside NVIDIA / OpenAI / Anthropic.
- Works with zero configuration against a default local Ollama install
  (`http://localhost:11434/v1`): model list populates from `/models`, chat
  streams, Agent mode and image attachments work on capable models.
- API key is **optional**: no key needed for local runners; if the user saves
  one (OpenRouter, Together, secured vLLM), it is stored in `SecretStorage` and
  sent as a standard `Authorization: Bearer` header.
- All existing capabilities ride along for free: streaming, Agent-mode tool
  calling, image attachments (sub-project 1), Auto-mode routing eligibility.

## Non-goals

- Multiple named custom endpoints (one slot only; revisit if demanded).
- Backend-specific integrations (no Ollama-native API, no model pulling/
  management — the OpenAI-compatible surface only).
- Any visual redesign of the provider picker or settings panel (sub-project 3).

## Architecture

### New provider

`extensions/openvs-chat/src/providers/custom.ts`:

```ts
export class CustomProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'custom',
		label: 'Custom (Local / Self-hosted)',
		suggestedModels: ['llama3.1', 'qwen2.5-coder', 'deepseek-r1', 'mistral'],
		apiKeyUrl: '',            // no single place to get a key; panel copy explains it's optional
		requiresApiKey: false,
		supportsTools: true,
		toolModelPatterns: [],    // permissive — arbitrary OSS models, can't enumerate
		visionModelPatterns: [],  // permissive — same reasoning as NVIDIA
	};
}
```

Registered in the `ProviderRegistry` constructor alongside the existing three.
Everything else (streaming, agent steps, image `content`-parts serialization)
is inherited from `OpenAICompatibleProvider` unchanged.

### Settings

`extensions/openvs-chat/package.json` gains two configuration entries,
mirroring the per-provider settings that already exist for the other three:

- `openvsChat.custom.baseUrl` — default `http://localhost:11434/v1` (Ollama's
  OpenAI-compatible endpoint), description naming Ollama / LM Studio / vLLM /
  OpenRouter as examples.
- `openvsChat.custom.model` — default empty (falls back to the first suggested
  model, per existing `registry.getModel` behavior).

### Keyless auth — two touchpoints

1. `OpenAICompatibleProvider.authHeaders` currently always emits
   `Authorization: Bearer ${apiKey}`. Change: omit the `Authorization` header
   entirely when `apiKey` is empty. Safe for OpenAI/NVIDIA — their
   `requiresApiKey: true` plus the existing `handleSend` gate guarantees a
   non-empty key before any request is made.
2. `ProviderRegistry.listModels` currently throws `Set an API key for … first.`
   whenever no key is stored. Change: only throw when
   `provider.info.requiresApiKey` is true, so the Custom provider's model
   dropdown can populate keylessly.

No change to `handleSend`'s key gate — it already checks
`provider.info.requiresApiKey && !apiKey`, which correctly passes for the
Custom provider with no key.

## Data flow

Identical to the existing OpenAI-compatible path. Picker → `setProvider` →
model list via `GET {baseUrl}/models` (keyless-capable after touchpoint 2) →
send → `streamChat`/`runAgentStep` with the `Authorization` header omitted when
no key is stored.

## Error handling

- Endpoint unreachable (Ollama not running): existing `apiFetch`
  timeout/retry, then a network-error bubble. No new machinery.
- HTTP-level rejection (e.g. hosted gateway demanding a key the user didn't
  set): existing `describeHttpError` path — its 401/403 branch already says
  "authentication failed … check that your API key is valid", which is the
  right message for that case.
- Non-tool/non-vision model asked to do tools/images: permissive patterns mean
  the request is attempted and the backend's real error surfaces, matching the
  NVIDIA precedent and the sub-project-1 design.

## Testing

No automated test suite in this extension (repo convention). Typecheck gate
(`npm run gulp compile-extensions`) per task, then manual verification in the
Extension Development Host against a live local Ollama:

- Custom provider appears in picker with no ⚠ key warning.
- Model dropdown populates from Ollama with no key stored.
- Ask mode streams a completion from a local model.
- Agent mode executes a tool call on a tool-capable model (e.g. `llama3.1`).
- Image attachment reaches a vision model (e.g. `llama3.2-vision`) and the
  reply references image content.
- Saving a key in the panel sends it as a Bearer header (verify against a
  hosted OpenAI-compatible gateway, e.g. OpenRouter, if available).
- Stopping Ollama and sending produces a readable network-error bubble, not a
  hang or crash.
