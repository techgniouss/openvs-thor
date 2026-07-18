# Chat Image Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users paste an image into the `openvs-chat` chat input (Ask/Edit/Agent) and have it sent to whichever model can accept it, with client-side downscaling and a hard gate against sending images to a model that can't handle them.

**Architecture:** `ChatMessage` gains an optional `images?: ChatImage[]` field (base64 + mime type); `content` stays a plain string. `ProviderInfo` gains `visionModelPatterns: string[]`, following the exact empty-list-is-permissive convention already used for `toolModelPatterns`. Anthropic and OpenAI get explicit vision-model regexes; NVIDIA and the generic OpenAI-compatible provider (which is how arbitrary OSS/local backends like Ollama, LM Studio, OpenRouter, Kimi get reached) stay permissive. Two provider serializers (`toAnthropicMessages`, `serializeMessage`) grow an image-block branch; everything else (agent tool loop, mode routing, streaming) needs no change because it already forwards `ChatMessage[]` by reference.

**Tech Stack:** TypeScript (extension host, `src/providers/*`, `src/chatViewProvider.ts`), vanilla JS webview with `@ts-check` JSDoc typing (`media/main.js`), plain CSS (`media/main.css`). No test framework in this extension — verification is manual via the Extension Development Host, plus the mandatory typecheck gate.

**Reference spec:** `docs/superpowers/specs/2026-07-01-chat-image-attachment-design.md`

---

## Verification convention used throughout this plan

This extension has no automated test suite (confirmed in `CLAUDE.md`). Every task below ends with a **typecheck step** instead of a test-run step:

```bash
npm run gulp compile-extensions
```

Expected: exits 0, no TypeScript errors printed for any file under `extensions/openvs-chat`. Per `CLAUDE.md`, this MUST pass before moving to the next task — do not stack changes on top of a broken compile.

The final task (Task 10) covers manual, end-to-end verification in the Extension Development Host per the spec's Testing section.

---

### Task 1: Core types — `ChatImage`, `images` field, `visionModelPatterns`, `modelSupportsVision`

**Files:**
- Modify: `extensions/openvs-chat/src/providers/types.ts`

- [ ] **Step 1: Add `ChatImage` and the `images` field to `ChatMessage`**

In `extensions/openvs-chat/src/providers/types.ts`, replace:

```ts
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single tool/function call requested by the model. */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/**
 * A message in a conversation. `toolCalls` is only present on assistant turns that
 * invoke tools; `toolCallId` is only present on `tool` result turns.
 */
export interface ChatMessage {
	readonly role: ChatRole;
	readonly content: string;
	readonly toolCalls?: ToolCall[];
	readonly toolCallId?: string;
}
```

with:

```ts
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single tool/function call requested by the model. */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/** A single image attached to a user message, already downscaled/re-encoded client-side. */
export interface ChatImage {
	readonly mimeType: string;
	/** Base64-encoded image data, without the `data:...;base64,` prefix. */
	readonly data: string;
}

/**
 * A message in a conversation. `images` is only present on user turns with an
 * attachment; `toolCalls` is only present on assistant turns that invoke tools;
 * `toolCallId` is only present on `tool` result turns.
 */
export interface ChatMessage {
	readonly role: ChatRole;
	readonly content: string;
	readonly images?: ChatImage[];
	readonly toolCalls?: ToolCall[];
	readonly toolCallId?: string;
}
```

- [ ] **Step 2: Add `visionModelPatterns` to `ProviderInfo` and a `modelSupportsVision` helper**

In the same file, replace:

```ts
export interface ProviderInfo {
	readonly id: string;
	readonly label: string;
	/** Suggested model identifiers shown in the picker. The user can type any model. */
	readonly suggestedModels: string[];
	/** Where the user can obtain an API key. */
	readonly apiKeyUrl: string;
	/** Whether an API key is strictly required to call the provider. */
	readonly requiresApiKey: boolean;
	/** Whether the provider can do tool calling at all (Agent mode). */
	readonly supportsTools: boolean;
	/**
	 * Case-insensitive regex sources; a model is considered tool-capable (and thus
	 * usable in Agent mode) if its id matches any pattern. An empty list means every
	 * model from this provider supports tools.
	 */
	readonly toolModelPatterns: string[];
}

/**
 * Whether a specific model can be used in Agent mode. Kept as a small pure helper
 * so the same rule can be mirrored in the webview (see `modelSupportsTools` in main.js).
 */
export function modelSupportsTools(info: ProviderInfo, model: string): boolean {
	if (!info.supportsTools) {
		return false;
	}
	if (!info.toolModelPatterns.length) {
		return true;
	}
	return info.toolModelPatterns.some(pattern => {
		try {
			return new RegExp(pattern, 'i').test(model);
		} catch {
			return false;
		}
	});
}
```

with:

```ts
export interface ProviderInfo {
	readonly id: string;
	readonly label: string;
	/** Suggested model identifiers shown in the picker. The user can type any model. */
	readonly suggestedModels: string[];
	/** Where the user can obtain an API key. */
	readonly apiKeyUrl: string;
	/** Whether an API key is strictly required to call the provider. */
	readonly requiresApiKey: boolean;
	/** Whether the provider can do tool calling at all (Agent mode). */
	readonly supportsTools: boolean;
	/**
	 * Case-insensitive regex sources; a model is considered tool-capable (and thus
	 * usable in Agent mode) if its id matches any pattern. An empty list means every
	 * model from this provider supports tools.
	 */
	readonly toolModelPatterns: string[];
	/**
	 * Case-insensitive regex sources; a model is considered vision-capable (and thus
	 * able to receive image attachments) if its id matches any pattern. An empty list
	 * means every model from this provider is assumed to support image input — used for
	 * providers that proxy arbitrary/OSS backends (NVIDIA, generic OpenAI-compatible)
	 * where we can't enumerate vision-capable models in advance.
	 */
	readonly visionModelPatterns: string[];
}

/**
 * Whether a specific model can be used in Agent mode. Kept as a small pure helper
 * so the same rule can be mirrored in the webview (see `modelSupportsTools` in main.js).
 */
export function modelSupportsTools(info: ProviderInfo, model: string): boolean {
	if (!info.supportsTools) {
		return false;
	}
	if (!info.toolModelPatterns.length) {
		return true;
	}
	return info.toolModelPatterns.some(pattern => {
		try {
			return new RegExp(pattern, 'i').test(model);
		} catch {
			return false;
		}
	});
}

/**
 * Whether a specific model can accept image attachments. Kept as a small pure helper
 * so the same rule can be mirrored in the webview (see `modelSupportsVision` in main.js).
 */
export function modelSupportsVision(info: ProviderInfo, model: string): boolean {
	if (!info.visionModelPatterns.length) {
		return true;
	}
	return info.visionModelPatterns.some(pattern => {
		try {
			return new RegExp(pattern, 'i').test(model);
		} catch {
			return false;
		}
	});
}
```

- [ ] **Step 3: Typecheck (expect new errors — providers haven't been updated yet)**

Run: `npm run gulp compile-extensions`
Expected: FAIL with errors like `Property 'visionModelPatterns' is missing in type... AnthropicProvider/OpenAIProvider/NvidiaProvider`. This is expected — Task 2 fixes it.

- [ ] **Step 4: Commit**

```bash
git add extensions/openvs-chat/src/providers/types.ts
git commit -m "openvs-chat: add ChatImage type and vision-capability helper"
```

---

### Task 2: Vision-capability patterns per provider

**Files:**
- Modify: `extensions/openvs-chat/src/providers/anthropic.ts:19-34`
- Modify: `extensions/openvs-chat/src/providers/openai.ts:14-23`
- Modify: `extensions/openvs-chat/src/providers/nvidia.ts:16-36`

- [ ] **Step 1: Anthropic — reuse the same families as tool-calling (all current Claude models are multimodal)**

In `extensions/openvs-chat/src/providers/anthropic.ts`, replace:

```ts
		apiKeyUrl: 'https://console.anthropic.com/settings/keys',
		requiresApiKey: true,
		supportsTools: true,
		// Claude 3 and 4 families support tool use.
		toolModelPatterns: ['claude-3', 'claude-[a-z]+-4', 'claude-4'],
	};
```

with:

```ts
		apiKeyUrl: 'https://console.anthropic.com/settings/keys',
		requiresApiKey: true,
		supportsTools: true,
		// Claude 3 and 4 families support tool use.
		toolModelPatterns: ['claude-3', 'claude-[a-z]+-4', 'claude-4'],
		// Every Claude 3/3.5/3.7/4 model is multimodal.
		visionModelPatterns: ['claude-3', 'claude-[a-z]+-4', 'claude-4'],
	};
```

- [ ] **Step 2: OpenAI — exclude non-vision text-only families**

In `extensions/openvs-chat/src/providers/openai.ts`, replace:

```ts
		apiKeyUrl: 'https://platform.openai.com/api-keys',
		requiresApiKey: true,
		supportsTools: true,
		// All current chat models (gpt-3.5/4/4o/4.1 and the o-series) support tools.
		toolModelPatterns: ['gpt-3\\.5', 'gpt-4', '^o[0-9]', 'chatgpt'],
	};
```

with:

```ts
		apiKeyUrl: 'https://platform.openai.com/api-keys',
		requiresApiKey: true,
		supportsTools: true,
		// All current chat models (gpt-3.5/4/4o/4.1 and the o-series) support tools.
		toolModelPatterns: ['gpt-3\\.5', 'gpt-4', '^o[0-9]', 'chatgpt'],
		// gpt-4o/4.1 and the o-series are multimodal; bare gpt-4/gpt-3.5 are not.
		visionModelPatterns: ['gpt-4o', 'gpt-4\\.1', 'gpt-4-turbo', '^o[0-9]'],
	};
```

- [ ] **Step 3: NVIDIA — stay permissive (arbitrary/OSS backends, can't enumerate in advance)**

In `extensions/openvs-chat/src/providers/nvidia.ts`, replace:

```ts
		apiKeyUrl: 'https://build.nvidia.com/',
		requiresApiKey: true,
		supportsTools: true,
		// NVIDIA tool calling is model-specific; allowlist the known function-calling families.
		toolModelPatterns: [
			'llama-3\\.1', 'llama-3\\.3', 'nemotron',
			'mixtral-8x22b', 'mistral-large', 'mistral-small',
			'qwen2\\.5', 'deepseek',
		],
	};
```

with:

```ts
		apiKeyUrl: 'https://build.nvidia.com/',
		requiresApiKey: true,
		supportsTools: true,
		// NVIDIA tool calling is model-specific; allowlist the known function-calling families.
		toolModelPatterns: [
			'llama-3\\.1', 'llama-3\\.3', 'nemotron',
			'mixtral-8x22b', 'mistral-large', 'mistral-small',
			'qwen2\\.5', 'deepseek',
		],
		// NVIDIA hosts an open-ended catalog of vision and text-only models; we can't
		// enumerate vision-capable ones in advance, so stay permissive and let the API
		// surface a real error if a specific model can't accept images.
		visionModelPatterns: [],
	};
```

- [ ] **Step 4: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/providers/anthropic.ts extensions/openvs-chat/src/providers/openai.ts extensions/openvs-chat/src/providers/nvidia.ts
git commit -m "openvs-chat: set per-provider vision-model patterns"
```

---

### Task 3: Anthropic — serialize image blocks

**Files:**
- Modify: `extensions/openvs-chat/src/providers/anthropic.ts:170-219`

- [ ] **Step 1: Add an `image` variant to `AnthropicBlock` and emit it in `toAnthropicMessages`**

Replace:

```ts
type AnthropicBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string };
type AnthropicMsg = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

/**
 * Maps internal messages (plain chat *and* tool calls/results) to Anthropic's block
 * format. Anthropic requires strictly alternating user/assistant turns starting with a
 * user turn, so this merges consecutive same-role messages into a single turn — without
 * this, an attached-context user message followed by a history user message would be two
 * consecutive `user` turns and the API would reject the request (HTTP 400).
 */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMsg[] {
	const out: AnthropicMsg[] = [];
	const append = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
		if (!blocks.length) {
			return;
		}
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.content.push(...blocks);
		} else {
			out.push({ role, content: blocks });
		}
	};

	for (const m of messages) {
		if (m.role === 'tool') {
			append('user', [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }]);
		} else if (m.role === 'assistant' && m.toolCalls?.length) {
			const blocks: AnthropicBlock[] = [];
			if (m.content) {
				blocks.push({ type: 'text', text: m.content });
			}
			for (const tc of m.toolCalls) {
				blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
			}
			append('assistant', blocks);
		} else if (m.content) {
			append(m.role === 'assistant' ? 'assistant' : 'user', [{ type: 'text', text: m.content }]);
		}
	}

	// Anthropic requires the first turn to be from the user.
	if (out.length && out[0].role === 'assistant') {
		out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
	}
	return out;
}
```

with:

```ts
type AnthropicBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string };
type AnthropicMsg = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

/**
 * Maps internal messages (plain chat *and* tool calls/results) to Anthropic's block
 * format. Anthropic requires strictly alternating user/assistant turns starting with a
 * user turn, so this merges consecutive same-role messages into a single turn — without
 * this, an attached-context user message followed by a history user message would be two
 * consecutive `user` turns and the API would reject the request (HTTP 400).
 */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMsg[] {
	const out: AnthropicMsg[] = [];
	const append = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
		if (!blocks.length) {
			return;
		}
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.content.push(...blocks);
		} else {
			out.push({ role, content: blocks });
		}
	};

	for (const m of messages) {
		if (m.role === 'tool') {
			append('user', [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }]);
		} else if (m.role === 'assistant' && m.toolCalls?.length) {
			const blocks: AnthropicBlock[] = [];
			if (m.content) {
				blocks.push({ type: 'text', text: m.content });
			}
			for (const tc of m.toolCalls) {
				blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
			}
			append('assistant', blocks);
		} else if (m.content || m.images?.length) {
			const blocks: AnthropicBlock[] = (m.images ?? []).map(img => ({
				type: 'image',
				source: { type: 'base64', media_type: img.mimeType, data: img.data },
			}));
			if (m.content) {
				blocks.push({ type: 'text', text: m.content });
			}
			append(m.role === 'assistant' ? 'assistant' : 'user', blocks);
		}
	}

	// Anthropic requires the first turn to be from the user.
	if (out.length && out[0].role === 'assistant') {
		out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
	}
	return out;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/providers/anthropic.ts
git commit -m "openvs-chat: send image attachments to Anthropic as image blocks"
```

---

### Task 4: OpenAI-compatible provider — serialize image parts

**Files:**
- Modify: `extensions/openvs-chat/src/providers/openaiCompatible.ts:143-160`

This is the shared base class for OpenAI, NVIDIA, and any custom `baseUrl` pointed at an
OpenAI-compatible OSS/local gateway (Ollama, LM Studio, OpenRouter, Kimi, etc.) — one
change here covers all of them.

- [ ] **Step 1: Emit a content-part array only when a message has images**

Replace:

```ts
/** Serializes an internal message into the OpenAI Chat Completions wire format. */
function serializeMessage(m: ChatMessage): Record<string, unknown> {
	if (m.role === 'assistant' && m.toolCalls?.length) {
		return {
			role: 'assistant',
			content: m.content || null,
			tool_calls: m.toolCalls.map(tc => ({
				id: tc.id,
				type: 'function',
				function: { name: tc.name, arguments: JSON.stringify(tc.args) },
			})),
		};
	}
	if (m.role === 'tool') {
		return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
	}
	return { role: m.role, content: m.content };
}
```

with:

```ts
/** Serializes an internal message into the OpenAI Chat Completions wire format. */
function serializeMessage(m: ChatMessage): Record<string, unknown> {
	if (m.role === 'assistant' && m.toolCalls?.length) {
		return {
			role: 'assistant',
			content: m.content || null,
			tool_calls: m.toolCalls.map(tc => ({
				id: tc.id,
				type: 'function',
				function: { name: tc.name, arguments: JSON.stringify(tc.args) },
			})),
		};
	}
	if (m.role === 'tool') {
		return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
	}
	if (m.images?.length) {
		const parts: Record<string, unknown>[] = [];
		if (m.content) {
			parts.push({ type: 'text', text: m.content });
		}
		for (const img of m.images) {
			parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
		}
		return { role: m.role, content: parts };
	}
	return { role: m.role, content: m.content };
}
```

Also update `streamChat`, which builds its own inline message mapping instead of calling
`serializeMessage` — replace:

```ts
			body: JSON.stringify({
				model: request.model,
				messages: request.messages.map(m => ({ role: m.role, content: m.content })),
				max_tokens: request.maxTokens,
				stream: true,
				...this.extraBody(),
			}),
```

with:

```ts
			body: JSON.stringify({
				model: request.model,
				messages: request.messages.map(serializeMessage),
				max_tokens: request.maxTokens,
				stream: true,
				...this.extraBody(),
			}),
```

(This makes `streamChat`, used by Ask/Edit mode, share the exact same serialization as
`runAgentStep`, used by Agent mode — both now go through `serializeMessage`.)

- [ ] **Step 2: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/src/providers/openaiCompatible.ts
git commit -m "openvs-chat: send image attachments to OpenAI-compatible backends"
```

---

### Task 5: Registry — plumb `visionModelPatterns` to the webview

**Files:**
- Modify: `extensions/openvs-chat/src/providers/registry.ts:14-31,137-156`

- [ ] **Step 1: Add the field to `ResolvedProviderConfig`**

Replace:

```ts
/** Per-provider runtime configuration resolved from settings + secret storage. */
export interface ResolvedProviderConfig {
	readonly id: string;
	readonly label: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly suggestedModels: string[];
	readonly apiKeyUrl: string;
	readonly requiresApiKey: boolean;
	readonly hasApiKey: boolean;
	/** True when the key comes from an environment variable, which can't be cleared from the panel. */
	readonly hasEnvKey: boolean;
	readonly supportsTools: boolean;
	/** Regex sources (case-insensitive) marking which models support Agent mode. */
	readonly toolModelPatterns: string[];
	/** A configured web sign-in endpoint, if any (enables the "Sign in" button). */
	readonly authUrl: string;
}
```

with:

```ts
/** Per-provider runtime configuration resolved from settings + secret storage. */
export interface ResolvedProviderConfig {
	readonly id: string;
	readonly label: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly suggestedModels: string[];
	readonly apiKeyUrl: string;
	readonly requiresApiKey: boolean;
	readonly hasApiKey: boolean;
	/** True when the key comes from an environment variable, which can't be cleared from the panel. */
	readonly hasEnvKey: boolean;
	readonly supportsTools: boolean;
	/** Regex sources (case-insensitive) marking which models support Agent mode. */
	readonly toolModelPatterns: string[];
	/** Regex sources (case-insensitive) marking which models accept image attachments. */
	readonly visionModelPatterns: string[];
	/** A configured web sign-in endpoint, if any (enables the "Sign in" button). */
	readonly authUrl: string;
}
```

- [ ] **Step 2: Include it in `resolve()`**

Replace:

```ts
		return {
			id,
			label: provider.info.label,
			model: this.getModel(id),
			baseUrl: this.getBaseUrl(id) || '',
			suggestedModels: provider.info.suggestedModels,
			apiKeyUrl: provider.info.apiKeyUrl,
			requiresApiKey: provider.info.requiresApiKey,
			hasApiKey: !!(await this.getApiKey(id)),
			hasEnvKey: this.hasEnvKey(id),
			supportsTools: provider.info.supportsTools,
			toolModelPatterns: provider.info.toolModelPatterns,
			authUrl: this.getAuthUrl(id),
		};
```

with:

```ts
		return {
			id,
			label: provider.info.label,
			model: this.getModel(id),
			baseUrl: this.getBaseUrl(id) || '',
			suggestedModels: provider.info.suggestedModels,
			apiKeyUrl: provider.info.apiKeyUrl,
			requiresApiKey: provider.info.requiresApiKey,
			hasApiKey: !!(await this.getApiKey(id)),
			hasEnvKey: this.hasEnvKey(id),
			supportsTools: provider.info.supportsTools,
			toolModelPatterns: provider.info.toolModelPatterns,
			visionModelPatterns: provider.info.visionModelPatterns,
			authUrl: this.getAuthUrl(id),
		};
```

- [ ] **Step 3: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add extensions/openvs-chat/src/providers/registry.ts
git commit -m "openvs-chat: expose visionModelPatterns to the webview"
```

---

### Task 6: `chatViewProvider.ts` — gate sends against non-vision models

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:14,494-499,583-604`

- [ ] **Step 1: Import `modelSupportsVision`**

Replace:

```ts
import { ChatMessage, ChatProvider, modelSupportsTools } from './providers/types';
```

with:

```ts
import { ChatMessage, ChatProvider, modelSupportsTools, modelSupportsVision } from './providers/types';
```

- [ ] **Step 2: Gate `handleSend` (Ask/Edit/Agent, single provider)**

Replace:

```ts
		const model = (message.model && message.model.trim()) || this.registry.getModel(providerId);

		if (mode === 'agent' && !modelSupportsTools(provider.info, model)) {
			this.fail(`The model "${model}" doesn't support Agent mode (tool calling). Pick a tool-capable model, or use Ask/Edit.`);
			return;
		}
```

with:

```ts
		const model = (message.model && message.model.trim()) || this.registry.getModel(providerId);

		if (mode === 'agent' && !modelSupportsTools(provider.info, model)) {
			this.fail(`The model "${model}" doesn't support Agent mode (tool calling). Pick a tool-capable model, or use Ask/Edit.`);
			return;
		}

		if ((message.messages ?? []).some(m => m.images?.length) && !modelSupportsVision(provider.info, model)) {
			this.fail(`The model "${model}" doesn't support image input. Remove the attached image(s) or pick a vision-capable model.`);
			return;
		}
```

- [ ] **Step 3: Gate the Auto pipeline's non-agent path (Ask/Edit routed to a single role model)**

Replace:

```ts
				const provider = this.registry.getProvider(a.providerId);
				if (!provider) {
					this.fail(`Provider "${a.providerId}" is unavailable.`);
					return;
				}
				this.post({
					type: 'autoPhase', role, label: a.roleLabel,
					provider: a.providerLabel, model: a.model, source: a.source, streaming: true,
				});
```

with:

```ts
				const provider = this.registry.getProvider(a.providerId);
				if (!provider) {
					this.fail(`Provider "${a.providerId}" is unavailable.`);
					return;
				}
				if (history.some(m => m.images?.length) && !modelSupportsVision(provider.info, a.model)) {
					this.fail(`The Auto-routed "${a.roleLabel}" model "${a.model}" doesn't support image input. Remove the attached image(s), pin a vision-capable model for this role, or switch off Auto.`);
					return;
				}
				this.post({
					type: 'autoPhase', role, label: a.roleLabel,
					provider: a.providerLabel, model: a.model, source: a.source, streaming: true,
				});
```

Note: Auto's Agent-mode path (the multi-phase `AutoOrchestrator` plan→implement→review
pipeline) is intentionally **not** gated here — each phase can pick a different model and
pre-checking all of them is a separate, larger change. If an image reaches a non-vision
model there, the provider's own HTTP error surfaces through the existing `describeHttpError`
path (not a silent failure, just without the friendlier pre-check message). Follow-up if
this turns out to matter in practice.

- [ ] **Step 4: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts
git commit -m "openvs-chat: block sends with images to non-vision models"
```

---

### Task 7: Webview HTML/CSS scaffolding for image chips

**Files:**
- Modify: `extensions/openvs-chat/src/chatViewProvider.ts:797-798`
- Modify: `extensions/openvs-chat/media/main.css`

- [ ] **Step 1: Add the chip container to the webview HTML**

In `getHtml()`, replace:

```ts
		<div id="skillChip" class="context-chip hidden"></div>
		<div id="contextChip" class="context-chip hidden"></div>
```

with:

```ts
		<div id="skillChip" class="context-chip hidden"></div>
		<div id="contextChip" class="context-chip hidden"></div>
		<div id="imageChips" class="image-chips hidden"></div>
```

- [ ] **Step 2: Add CSS for the pending-attachment chips and in-message thumbnails**

Append to the end of `extensions/openvs-chat/media/main.css`:

```css
/* ---- Image attachments ---- */
.image-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 0 10px 6px;
	align-self: flex-start;
}
.image-chip {
	position: relative;
	display: inline-flex;
	border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
	border-radius: 6px;
	overflow: hidden;
}
.image-chip img {
	width: 48px;
	height: 48px;
	object-fit: cover;
	display: block;
}
.image-chip a {
	position: absolute;
	top: 0;
	right: 0;
	padding: 0 3px;
	background: rgba(0, 0, 0, 0.6);
	color: #fff;
	text-decoration: none;
	font-size: 0.75em;
}
.message-images {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-bottom: 6px;
}
.message-images img {
	max-width: 200px;
	max-height: 200px;
	border-radius: 6px;
	object-fit: contain;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors (CSS isn't typechecked, but this confirms the `.ts` edit compiles).

- [ ] **Step 4: Commit**

```bash
git add extensions/openvs-chat/src/chatViewProvider.ts extensions/openvs-chat/media/main.css
git commit -m "openvs-chat: add image-chip markup and styling"
```

---

### Task 8: Webview logic — paste, downscale, chip state

**Files:**
- Modify: `extensions/openvs-chat/media/main.js:14-53,59-65`

- [ ] **Step 1: Add state, element ref, and constants**

Replace:

```js
	/** @type {{ role: 'user'|'assistant', content: string }[]} */
	let messages = [];
```

with:

```js
	/** @type {{ role: 'user'|'assistant', content: string, images?: {mimeType:string,data:string}[] }[]} */
	let messages = [];
	/** @type {{mimeType:string,data:string}[]} pending image attachments for the next send */
	let pendingImages = [];
	const MAX_IMAGE_DIM = 1568; // Claude's own internal long-edge cap; a sane default everywhere.
	const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
	const MAX_IMAGES_PER_MESSAGE = 5;
```

Replace:

```js
		contextChip: $('contextChip'),
		attachButton: $('attachButton'),
```

with:

```js
		contextChip: $('contextChip'),
		imageChips: $('imageChips'),
		attachButton: $('attachButton'),
```

- [ ] **Step 2: Add `showNotice`, `resizeImage`, and `renderImageChips` helpers**

Insert after `function scrollToBottom() { els.messages.scrollTop = els.messages.scrollHeight; }`
(around line 207):

```js

	/** Renders a lightweight client-side notice bubble (no host round-trip). */
	function showNotice(message, isError) {
		const body = appendMessageEl('assistant', (isError ? '⚠️ ' : 'ℹ️ ') + message);
		body.parentElement?.classList.add(isError ? 'error' : 'info');
		scrollToBottom();
	}

	/**
	 * Reads a pasted image File, downscales it to at most MAX_IMAGE_DIM on its long edge,
	 * re-encodes as JPEG, and resolves a base64 payload ready to attach to a message.
	 * Rejects if the result is still over MAX_IMAGE_BYTES.
	 * @param {File} file
	 * @returns {Promise<{mimeType: string, data: string}>}
	 */
	function resizeImage(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(reader.error || new Error('Failed to read image.'));
			reader.onload = () => {
				const img = new Image();
				img.onerror = () => reject(new Error('Failed to decode image.'));
				img.onload = () => {
					let width = img.naturalWidth;
					let height = img.naturalHeight;
					const longEdge = Math.max(width, height);
					if (longEdge > MAX_IMAGE_DIM) {
						const scale = MAX_IMAGE_DIM / longEdge;
						width = Math.round(width * scale);
						height = Math.round(height * scale);
					}
					const canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext('2d');
					if (!ctx) { reject(new Error('Canvas unavailable.')); return; }
					ctx.drawImage(img, 0, 0, width, height);
					const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
					const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
					const approxBytes = base64.length * 0.75;
					if (approxBytes > MAX_IMAGE_BYTES) {
						reject(new Error('Image is too large even after resizing (over 5MB). Try a smaller image.'));
						return;
					}
					resolve({ mimeType: 'image/jpeg', data: base64 });
				};
				img.src = /** @type {string} */ (reader.result);
			};
			reader.readAsDataURL(file);
		});
	}

	/** Renders the pending-attachment chips above the composer. */
	function renderImageChips() {
		els.imageChips.innerHTML = '';
		if (!pendingImages.length) {
			els.imageChips.classList.add('hidden');
			return;
		}
		els.imageChips.classList.remove('hidden');
		pendingImages.forEach((img, index) => {
			const chip = document.createElement('span');
			chip.className = 'image-chip';
			const thumb = document.createElement('img');
			thumb.src = `data:${img.mimeType};base64,${img.data}`;
			const remove = document.createElement('a');
			remove.href = '#';
			remove.textContent = '✕';
			remove.addEventListener('click', (e) => {
				e.preventDefault();
				pendingImages.splice(index, 1);
				renderImageChips();
			});
			chip.appendChild(thumb);
			chip.appendChild(remove);
			els.imageChips.appendChild(chip);
		});
	}
```

- [ ] **Step 3: Bind the paste handler on the composer input**

Find the existing attach-button binding:

```js
	els.attachButton.addEventListener('click', () => vscode.postMessage({ type: 'attachContext' }));
```

Add immediately after it:

```js
	els.input.addEventListener('paste', (e) => {
		const items = e.clipboardData ? [...e.clipboardData.items] : [];
		const imageItems = items.filter(it => it.type.startsWith('image/'));
		if (!imageItems.length) { return; }
		e.preventDefault();
		for (const item of imageItems) {
			if (pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
				showNotice(`You can attach at most ${MAX_IMAGES_PER_MESSAGE} images per message.`, true);
				break;
			}
			const file = item.getAsFile();
			if (!file) { continue; }
			resizeImage(file).then(resized => {
				pendingImages.push(resized);
				renderImageChips();
			}).catch(err => {
				showNotice(err instanceof Error ? err.message : String(err), true);
			});
		}
	});
```

- [ ] **Step 4: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors. (`appendMessageEl` is referenced by `showNotice` before Task 9
extends its signature — that's fine, it still accepts 2 args at this point.)

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/media/main.js
git commit -m "openvs-chat: paste-to-attach images with client-side downscaling"
```

---

### Task 9: Webview logic — wire attachments into send/render, gate at send time

**Files:**
- Modify: `extensions/openvs-chat/media/main.js:159-185,213-221,472-510`

- [ ] **Step 1: Extend `appendMessageEl` to render inline thumbnails**

Replace:

```js
	function appendMessageEl(role, content) {
		const wrap = document.createElement('div');
		wrap.className = `message ${role}`;
		const roleEl = document.createElement('div');
		roleEl.className = 'role';
		roleEl.textContent = role === 'user' ? 'You' : 'Assistant';
		const body = document.createElement('div');
		body.className = 'body';
		body.innerHTML = renderMarkdown(content);
		enhanceCodeBlocks(body);
		wrap.appendChild(roleEl);
		wrap.appendChild(body);
		els.messages.appendChild(wrap);
		return body;
	}
```

with:

```js
	function appendMessageEl(role, content, images) {
		const wrap = document.createElement('div');
		wrap.className = `message ${role}`;
		const roleEl = document.createElement('div');
		roleEl.className = 'role';
		roleEl.textContent = role === 'user' ? 'You' : 'Assistant';
		const body = document.createElement('div');
		body.className = 'body';
		body.innerHTML = renderMarkdown(content);
		if (images && images.length) {
			const gallery = document.createElement('div');
			gallery.className = 'message-images';
			for (const img of images) {
				const el = document.createElement('img');
				el.src = `data:${img.mimeType};base64,${img.data}`;
				gallery.appendChild(el);
			}
			body.insertBefore(gallery, body.firstChild);
		}
		enhanceCodeBlocks(body);
		wrap.appendChild(roleEl);
		wrap.appendChild(body);
		els.messages.appendChild(wrap);
		return body;
	}
```

- [ ] **Step 2: Pass `images` through on redraw**

Replace:

```js
		for (const m of messages) { appendMessageEl(m.role, m.content); }
```

with:

```js
		for (const m of messages) { appendMessageEl(m.role, m.content, m.images); }
```

- [ ] **Step 3: Add the `modelSupportsVision` mirror next to `modelSupportsTools`**

Replace:

```js
	/** Mirrors modelSupportsTools() in src/providers/types.ts — keep them in sync. */
	function modelSupportsTools(provider, model) {
		if (!provider || !provider.supportsTools) { return false; }
		const patterns = provider.toolModelPatterns || [];
		if (!patterns.length) { return true; }
		return patterns.some(p => {
			try { return new RegExp(p, 'i').test(model || ''); } catch { return false; }
		});
	}
```

with:

```js
	/** Mirrors modelSupportsTools() in src/providers/types.ts — keep them in sync. */
	function modelSupportsTools(provider, model) {
		if (!provider || !provider.supportsTools) { return false; }
		const patterns = provider.toolModelPatterns || [];
		if (!patterns.length) { return true; }
		return patterns.some(p => {
			try { return new RegExp(p, 'i').test(model || ''); } catch { return false; }
		});
	}

	/** Mirrors modelSupportsVision() in src/providers/types.ts — keep them in sync. */
	function modelSupportsVision(provider, model) {
		if (!provider) { return false; }
		const patterns = provider.visionModelPatterns || [];
		if (!patterns.length) { return true; }
		return patterns.some(p => {
			try { return new RegExp(p, 'i').test(model || ''); } catch { return false; }
		});
	}
```

- [ ] **Step 4: Attach pending images when sending, clear them after, and gate client-side**

Replace:

```js
	function sendText(text, opts) {
		if (!text || streaming) { return; }
		messages.push({ role: 'user', content: text });
		appendMessageEl('user', text);
		saveState();

		// In Auto mode the per-phase header creates its own bubble; otherwise pre-create one
		// for non-agent streaming.
		if (mode !== 'agent' && !isAuto()) {
			messages.push({ role: 'assistant', content: '' });
			activeAssistantRaw = '';
			activeAssistantBody = appendMessageEl('assistant', '');
			activeAssistantBody.parentElement?.classList.add('streaming');
		}
		scrollToBottom();
		setStreaming(true);
		vscode.postMessage({
			type: 'send',
			mode,
			provider: selectedProvider,
			model: els.modelSelect.value,
			context: currentContext || undefined,
			messages: messages.filter(m => !(m.role === 'assistant' && m.content === '')),
			inline: !!(opts && opts.inline),
		});
	}

	function send() {
		const text = els.input.value.trim();
		if (!text || streaming) { return; }
		if (text.startsWith('/') && handleSlash(text)) { els.input.value = ''; autoSize(); return; }
		els.input.value = ''; autoSize();
		sendText(text);
	}

	function clearChat() {
		messages = []; currentContext = null; saveState();
		renderAll(); renderContext(); els.input.focus();
	}
```

with:

```js
	function sendText(text, opts) {
		if ((!text && !pendingImages.length) || streaming) { return; }
		const images = pendingImages.length ? pendingImages.slice() : undefined;
		messages.push({ role: 'user', content: text, images });
		appendMessageEl('user', text, images);
		pendingImages = [];
		renderImageChips();
		saveState();

		// In Auto mode the per-phase header creates its own bubble; otherwise pre-create one
		// for non-agent streaming.
		if (mode !== 'agent' && !isAuto()) {
			messages.push({ role: 'assistant', content: '' });
			activeAssistantRaw = '';
			activeAssistantBody = appendMessageEl('assistant', '');
			activeAssistantBody.parentElement?.classList.add('streaming');
		}
		scrollToBottom();
		setStreaming(true);
		vscode.postMessage({
			type: 'send',
			mode,
			provider: selectedProvider,
			model: els.modelSelect.value,
			context: currentContext || undefined,
			messages: messages.filter(m => !(m.role === 'assistant' && m.content === '')),
			inline: !!(opts && opts.inline),
		});
	}

	function send() {
		const text = els.input.value.trim();
		if ((!text && !pendingImages.length) || streaming) { return; }
		if (text.startsWith('/') && handleSlash(text)) { els.input.value = ''; autoSize(); return; }
		if (pendingImages.length && !isAuto() && !modelSupportsVision(currentProvider(), els.modelSelect.value)) {
			showNotice(`The model "${els.modelSelect.value}" doesn't support image input. Remove the attachment or pick a vision-capable model.`, true);
			return;
		}
		els.input.value = ''; autoSize();
		sendText(text);
	}

	function clearChat() {
		messages = []; currentContext = null; pendingImages = []; saveState();
		renderAll(); renderContext(); renderImageChips(); els.input.focus();
	}
```

- [ ] **Step 5: Render image chips on init**

Find the init block near the end of the file:

```js
	setMode(mode);
	renderAll();
	renderContext();
	autoSize();
	vscode.postMessage({ type: 'ready' });
```

Replace with:

```js
	setMode(mode);
	renderAll();
	renderContext();
	renderImageChips();
	autoSize();
	vscode.postMessage({ type: 'ready' });
```

- [ ] **Step 6: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add extensions/openvs-chat/media/main.js
git commit -m "openvs-chat: wire pending image attachments into send/render"
```

---

### Task 10: Manual end-to-end verification

**Files:** none (verification only)

No automated test suite exists for this extension. Run each check below in the Extension
Development Host (press `F5` from this repo, or launch with
`--extensionDevelopmentPath=extensions/openvs-chat`), per the spec's Testing section.

- [ ] **Step 1: Full compile check first**

Run: `npm run gulp compile-extensions`
Expected: PASS, no errors. Do not proceed if this fails.

- [ ] **Step 2: Anthropic vision round-trip (Ask mode)**

1. Open the chat panel, select the Anthropic provider with a `claude-3-5-sonnet` (or
   newer) model, Ask mode.
2. Copy any screenshot to the clipboard, click into the chat input, paste (Ctrl+V).
3. Confirm a thumbnail chip appears above the composer.
4. Type "What's in this image?" and send.
5. Expected: the assistant's reply describes the image's actual contents (not a generic
   "I can't see images" refusal), and the sent user bubble shows the thumbnail inline.

- [ ] **Step 3: OpenAI vision round-trip (Ask mode)**

Repeat Step 2 with the OpenAI provider on `gpt-4o`. Expected: same outcome.

- [ ] **Step 4: Agent mode with an image**

1. Switch to Agent mode (same vision-capable model).
2. Paste a screenshot of some code or an error message, ask "what does this say / what's
   wrong here", and also ask it to run a trivial tool (e.g. "list files in this repo").
3. Expected: the image reaches the model (its reply references the actual content) and
   the tool call still executes normally — both in the same turn.

- [ ] **Step 5: Oversized image triggers client-side downscaling**

1. Copy a large image (e.g. a >5MB PNG screenshot or photo) to the clipboard.
2. Paste into the chat input.
3. Expected: no error notice appears (resize succeeds silently), a thumbnail chip
   renders, and the request sends successfully — confirming the canvas downscale path
   ran rather than sending the original multi-MB payload.

- [ ] **Step 6: Permissive gating for NVIDIA / generic OpenAI-compatible**

1. Select the NVIDIA provider (or configure a custom OpenAI-compatible `baseUrl`, e.g.
   pointed at a local Ollama instance) with any model.
2. Paste an image and send.
3. Expected: the extension does **not** block the send (permissive `visionModelPatterns:
   []`); either the model handles it, or a real API-level error surfaces via the normal
   error bubble — never a silent client-side block.

- [ ] **Step 7: Hard gate blocks a known non-vision model**

1. Select OpenAI, set the model field to `gpt-3.5-turbo` (or another model excluded by
   `visionModelPatterns` in Task 2).
2. Paste an image, type some text, and send.
3. Expected: send is blocked immediately with the inline error "The model ... doesn't
   support image input...", no request goes out, and the pending image chip is still
   there (not silently discarded) so the user can switch models and retry.

- [ ] **Step 8: Remove-chip and multi-image affordances**

1. Paste 2-3 images without sending.
2. Click the ✕ on one chip — confirm it disappears and the others remain.
3. Send with the remaining images attached — confirm all remaining images arrive
   (check the assistant's description references all of them).

- [ ] **Step 9: Record results**

If all checks pass, note so in the PR/commit description when this branch is finished.
If any check fails, treat it as a bug against this plan — fix before considering the
feature done, per the repo's verification-before-completion convention.
