# Image Attachment in Chat — Design

## Context

This is sub-project 1 of a larger effort to bring `extensions/openvs-chat` closer to
Cursor/Antigravity/Windsurf-level chat UX: attach images to chat messages, and let users
bring their own API key or point at an open-source/local model. Follow-on sub-projects
(each gets its own spec):

2. Open-source / local model support (Ollama, LM Studio, etc. as first-class providers).
3. Overall UI/UX parity pass on the chat panel.

This spec covers **only** image attachment. Today `ChatMessage.content` is a plain string
and there is no image/vision path anywhere in `src/providers/*` or the webview.

## Goals

- User can paste an image (Ctrl+V) into the chat input in any of the three modes
  (Ask / Edit / Agent) and have it sent to a vision-capable model alongside their text.
- Works across providers generically — not hardcoded to a fixed provider allowlist —
  so it also covers future OSS/local backends (Ollama, LM Studio, OpenRouter, Kimi, etc.)
  reached through the existing OpenAI-compatible provider.
- Oversized images are downscaled client-side rather than rejected outright.
- Sending an image to a model that can't accept one is caught before the request goes out,
  with a clear inline message — not a silent failure or wasted API call.

## Non-goals (this sub-project)

- Drag-and-drop or file-picker attach (paste-only for now).
- A dedicated Gemini/other new provider (covered by sub-project 2 if/when needed).
- Any visual/styling rework of the chat panel (sub-project 3).

## Architecture

`ChatMessage` gains an optional field:

```ts
export interface ChatImage {
	readonly mimeType: string; // e.g. 'image/png', 'image/jpeg'
	readonly data: string;     // base64, no data-URL prefix
}

export interface ChatMessage {
	readonly role: ChatRole;
	readonly content: string;
	readonly images?: ChatImage[];
	readonly toolCalls?: ToolCall[];
	readonly toolCallId?: string;
}
```

`content` stays a plain string. This avoids turning every existing consumer of
`.content` (agent runner, guardrails, prompt building, rules) into a union-type
consumer — the diff stays localized to the two provider serializers and the webview.

`ProviderInfo` gains a `visionModelPatterns: string[]` field, mirroring the existing
`toolModelPatterns` convention exactly: empty list = every model from this provider is
assumed vision-capable (permissive default). A new `modelSupportsVision(info, model)`
helper in `types.ts` mirrors `modelSupportsTools`.

- **Anthropic**: explicit patterns for the Claude 3/3.5/3.7/4 families (all current
  Claude models support vision).
- **OpenAI**: explicit patterns for gpt-4o/4.1/o-series (exclude older text-only models
  if any remain in the suggested list).
- **NVIDIA** and the generic **OpenAI-compatible** provider: left permissive (empty
  pattern list). These are exactly the providers used to reach arbitrary OSS/local
  backends via a custom base URL, and we can't enumerate their vision-capable models
  in advance — so we attempt the send and let a real API error surface if the specific
  model can't handle it.

## Components touched

- `src/providers/types.ts` — `ChatImage` type, `images?` field on `ChatMessage`,
  `visionModelPatterns` on `ProviderInfo`, `modelSupportsVision()` helper.
- `src/providers/anthropic.ts` — `toAnthropicMessages` emits Anthropic `image` content
  blocks (`{ type: 'image', source: { type: 'base64', media_type, data } }`) ahead of
  the text block for any message carrying `images`.
- `src/providers/openaiCompatible.ts` — `serializeMessage` emits a content-part array
  (`image_url` + `text` parts) instead of a plain string only when `m.images?.length`;
  the no-image path is untouched so existing strict/OSS endpoints keep working exactly
  as before.
- `media/main.js` — paste handler on the chat input: reads `clipboardData.items`,
  filters for `image/*`, downscales via an offscreen canvas (max ~1568px long edge —
  Claude's own internal cap, a sane default across providers), re-encodes as JPEG,
  renders a removable thumbnail chip (new UI, sits alongside the existing file-context
  chip; supports multiple images per message, soft cap ~5), includes `images` in the
  `sendMessage` payload posted to the extension host.
- `src/chatViewProvider.ts` — accepts `images` on the inbound send payload, attaches
  them to the constructed `ChatMessage` for whichever mode is active. Before sending,
  checks `modelSupportsVision(providerInfo, selectedModel)`; if false and images are
  attached, blocks the send and posts an inline error instead of stripping images or
  sending silently.
- **Agent mode**: no new plumbing needed. `AgentRequest.messages` already reuses the
  same `ChatMessage[]`, so once the two serializers understand `images`, `runAgentStep`
  gets vision input for free.

## Data flow

1. User pastes an image into the chat input (any mode).
2. Webview resizes/re-encodes client-side, adds a thumbnail chip, holds it as pending
   attachment state (parallel to the existing pending file-context state).
3. On send, webview posts `{ text, images, context }` to the extension host.
4. `chatViewProvider` builds a `ChatMessage` with `images` set, checks vision-capability
   gate, then routes through the existing mode-specific path (Ask / Edit / Agent) — no
   change to that routing logic itself.
5. The active provider's serializer (`toAnthropicMessages` or `serializeMessage`)
   converts the message to the wire format including image blocks/parts.
6. Response streams back exactly as today.

## Error handling

- Pasting non-image clipboard content: untouched, falls through to normal text paste.
- Image still over ~5MB after client-side resize: reject, inline toast, not attached.
- Vision-incapable model selected while an image is attached (e.g. user attaches then
  switches models before sending): send is blocked with a clear inline message
  ("Selected model doesn't support images — remove the attachment or switch models"),
  never a silent drop or a wasted round-trip.
- Real API-side rejection of an image (model claims support but errors): flows through
  the existing `describeHttpError` path unchanged.

## Testing

`extensions/openvs-chat` has no automated test suite (per repo convention — verified
manually via the Extension Development Host). Manual verification plan:

- Paste a screenshot in Ask mode against a Claude model and a GPT-4o model; confirm the
  model's reply references the image content.
- Repeat in Agent mode with a prompt that also triggers a tool call, confirming the
  image reaches the model alongside tool use.
- Paste an intentionally large image (>5MB source) and confirm client-side downscaling
  kicks in and the request still succeeds.
- Select a generic OpenAI-compatible / NVIDIA model and confirm image attach is still
  permitted (permissive gating) and the request is attempted.
- Switch to a model excluded by `visionModelPatterns` with an image already attached and
  confirm send is blocked with the inline error, not sent silently.
