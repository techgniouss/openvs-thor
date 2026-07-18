# Custom (Local / Self-hosted) Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth, keyless-capable "Custom (Local / Self-hosted)" provider so users can chat with Ollama/LM Studio/vLLM/OpenRouter or any OpenAI-compatible endpoint straight from the provider picker.

**Architecture:** A tiny `CustomProvider` subclass of the existing `OpenAICompatibleProvider` (which already handles streaming, agent tool-calling, and image attachments), registered as a fourth provider with `requiresApiKey: false` and permissive tool/vision patterns. Two keyless-auth touchpoints: the shared `authHeaders` omits the `Authorization` header when no key is stored, and `registry.listModels` only demands a key when the provider requires one. Settings default the base URL to Ollama's local endpoint.

**Tech Stack:** TypeScript (extension host), vanilla JS webview with `@ts-check` (`media/main.js`), VS Code configuration contributions (`package.json` + `package.nls.json`).

**Reference spec:** `docs/superpowers/specs/2026-07-02-custom-local-provider-design.md`

---

## Verification convention

This extension has no automated test suite (repo convention). Every task ends with the typecheck gate:

```bash
npm run gulp compile-extensions
```

Run from repo root `C:\Users\dell\Downloads\Srikanth\Github\openvs`. Expected: exits 0, `extensions/openvs-chat` reports 0 errors. Takes ~1-1.5 min. Do not stack changes on a broken compile.

Final task covers manual verification in the Extension Development Host.

**Note on dirty working tree:** some files in this repo may carry pre-existing uncommitted modifications from unrelated work. Only make the edits your task specifies; `git add` of a named file will sweep pre-existing hunks into the commit — that is accepted practice in this repo for now, do not try to separate them. If a target code block doesn't match what the plan shows, STOP and escalate rather than guessing.

---

### Task 1: `CustomProvider` class + registry registration

**Files:**
- Create: `extensions/openvs-chat/src/providers/custom.ts`
- Modify: `extensions/openvs-chat/src/providers/registry.ts:6-10,42-46`

- [ ] **Step 1: Create the provider**

Create `extensions/openvs-chat/src/providers/custom.ts` with exactly:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OpenAICompatibleProvider } from './openaiCompatible';
import { ProviderInfo } from './types';

/**
 * Provider for any OpenAI-compatible endpoint the user points it at: local runners
 * (Ollama, LM Studio, vLLM) or hosted open-model gateways (OpenRouter, Together, …).
 * The base URL defaults to Ollama's local endpoint and no API key is required —
 * if one is saved it is sent as a standard Bearer header for secured endpoints.
 */
export class CustomProvider extends OpenAICompatibleProvider {
	readonly info: ProviderInfo = {
		id: 'custom',
		label: 'Custom (Local / Self-hosted)',
		suggestedModels: [
			'llama3.1',
			'qwen2.5-coder',
			'deepseek-r1',
			'mistral',
		],
		apiKeyUrl: '',
		requiresApiKey: false,
		supportsTools: true,
		// Arbitrary OSS models — we can't enumerate tool-capable ones in advance,
		// so stay permissive and let the backend's real error surface if a model
		// can't do tool calling.
		toolModelPatterns: [],
		// Same reasoning for vision (matches the NVIDIA provider's approach).
		visionModelPatterns: [],
	};
}
```

- [ ] **Step 2: Register it**

In `extensions/openvs-chat/src/providers/registry.ts`, replace:

```ts
import { AnthropicProvider } from './anthropic';
import { NvidiaProvider } from './nvidia';
import { OpenAIProvider } from './openai';
import { ChatProvider } from './types';
```

with:

```ts
import { AnthropicProvider } from './anthropic';
import { CustomProvider } from './custom';
import { NvidiaProvider } from './nvidia';
import { OpenAIProvider } from './openai';
import { ChatProvider } from './types';
```

and replace:

```ts
		for (const provider of [new NvidiaProvider(), new OpenAIProvider(), new AnthropicProvider()]) {
			this.providers.set(provider.info.id, provider);
		}
```

with:

```ts
		for (const provider of [new NvidiaProvider(), new OpenAIProvider(), new AnthropicProvider(), new CustomProvider()]) {
			this.providers.set(provider.info.id, provider);
		}
```

- [ ] **Step 3: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add extensions/openvs-chat/src/providers/custom.ts extensions/openvs-chat/src/providers/registry.ts
git commit -m "openvs-chat: add Custom (local/self-hosted) provider"
```

---

### Task 2: Settings contributions (`package.json` + `package.nls.json`)

**Files:**
- Modify: `extensions/openvs-chat/package.json:204-263`
- Modify: `extensions/openvs-chat/package.nls.json`

- [ ] **Step 1: Add `custom` to the defaultProvider enum**

In `extensions/openvs-chat/package.json`, replace:

```json
        "openvsChat.defaultProvider": {
          "type": "string",
          "enum": [
            "openai",
            "anthropic",
            "nvidia"
          ],
          "enumDescriptions": [
            "%config.provider.openai%",
            "%config.provider.anthropic%",
            "%config.provider.nvidia%"
          ],
          "default": "nvidia",
          "description": "%config.defaultProvider%"
        },
```

with:

```json
        "openvsChat.defaultProvider": {
          "type": "string",
          "enum": [
            "openai",
            "anthropic",
            "nvidia",
            "custom"
          ],
          "enumDescriptions": [
            "%config.provider.openai%",
            "%config.provider.anthropic%",
            "%config.provider.nvidia%",
            "%config.provider.custom%"
          ],
          "default": "nvidia",
          "description": "%config.defaultProvider%"
        },
```

- [ ] **Step 2: Add the custom provider's settings block**

Still in `package.json`, immediately after the `openvsChat.nvidia.authUrl` property block (which ends with `"description": "%config.authUrl%"` followed by `},`), insert:

```json
        "openvsChat.custom.model": {
          "type": "string",
          "default": "llama3.1",
          "description": "%config.custom.model%"
        },
        "openvsChat.custom.baseUrl": {
          "type": "string",
          "default": "http://localhost:11434/v1",
          "description": "%config.custom.baseUrl%"
        },
        "openvsChat.custom.authUrl": {
          "type": "string",
          "default": "",
          "description": "%config.authUrl%"
        },
```

(so it sits between the nvidia block and `openvsChat.agent.maxSteps`).

- [ ] **Step 3: Add the NLS strings**

In `extensions/openvs-chat/package.nls.json`, immediately after the `"config.nvidia.baseUrl"` line, insert:

```json
  "config.provider.custom": "Custom (Local / Self-hosted)",
  "config.custom.model": "Default model for the custom provider (e.g. an Ollama model tag).",
  "config.custom.baseUrl": "Base URL of any OpenAI-compatible endpoint. Defaults to a local Ollama install; point it at LM Studio, vLLM, OpenRouter, or any other compatible server.",
```

(keep valid JSON — mind the trailing commas relative to neighbors).

- [ ] **Step 4: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors (JSON isn't typechecked, but this catches malformed JSON breaking the extension build's copy steps and confirms nothing else regressed).

- [ ] **Step 5: Commit**

```bash
git add extensions/openvs-chat/package.json extensions/openvs-chat/package.nls.json
git commit -m "openvs-chat: settings for the custom provider (Ollama default)"
```

---

### Task 3: Keyless auth — omit Bearer header, relax model listing

**Files:**
- Modify: `extensions/openvs-chat/src/providers/openaiCompatible.ts:28-30`
- Modify: `extensions/openvs-chat/src/providers/registry.ts:122-133`

- [ ] **Step 1: Omit the Authorization header when no key**

In `extensions/openvs-chat/src/providers/openaiCompatible.ts`, replace:

```ts
	private authHeaders(apiKey: string): Record<string, string> {
		return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
	}
```

with:

```ts
	private authHeaders(apiKey: string): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		// Keyless local endpoints (Ollama, LM Studio, …) don't want an Authorization
		// header at all; providers that require a key are gated before reaching here.
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		return headers;
	}
```

- [ ] **Step 2: Only require a key for listing when the provider requires one**

In `extensions/openvs-chat/src/providers/registry.ts`, replace:

```ts
	/** Fetches the live model list for a provider using its stored key. */
	async listModels(id: string, signal: AbortSignal): Promise<string[]> {
		const provider = this.providers.get(id);
		if (!provider) {
			throw new Error(`Unknown provider: ${id}`);
		}
		const apiKey = await this.getApiKey(id);
		if (!apiKey) {
			throw new Error(`Set an API key for ${provider.info.label} first.`);
		}
		return provider.listModels(apiKey, this.getBaseUrl(id), signal);
	}
```

with:

```ts
	/** Fetches the live model list for a provider using its stored key (if it needs one). */
	async listModels(id: string, signal: AbortSignal): Promise<string[]> {
		const provider = this.providers.get(id);
		if (!provider) {
			throw new Error(`Unknown provider: ${id}`);
		}
		const apiKey = await this.getApiKey(id);
		if (!apiKey && provider.info.requiresApiKey) {
			throw new Error(`Set an API key for ${provider.info.label} first.`);
		}
		return provider.listModels(apiKey ?? '', this.getBaseUrl(id), signal);
	}
```

- [ ] **Step 3: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add extensions/openvs-chat/src/providers/openaiCompatible.ts extensions/openvs-chat/src/providers/registry.ts
git commit -m "openvs-chat: keyless auth for providers that don't require a key"
```

---

### Task 4: Webview settings-card polish for keyless providers

**Files:**
- Modify: `extensions/openvs-chat/media/main.js` (inside `renderSettings()`, the `card.innerHTML` template and the `.get-key` handler)

The card already shows "no key needed" for `requiresApiKey: false` providers, but it always renders a "Get API key" link (dead for the custom provider whose `apiKeyUrl` is `''`) and its key-input placeholder doesn't signal the key is optional.

- [ ] **Step 1: Conditional Get-API-key link + optional-key placeholder**

In `renderSettings()` in `extensions/openvs-chat/media/main.js`, replace:

```js
			card.innerHTML = `
				<div class="provider-title"><strong>${escapeHtml(p.label)}</strong> ${status}
					${p.supportsTools ? '<span class="tag">agent</span>' : ''}</div>
				<div class="provider-row">
					<input type="password" class="key-input" placeholder="Paste API key…" />
					<button class="save-key">Save</button>
				</div>
				<div class="provider-actions">
					<a class="get-key" href="#">Get API key</a>
```

with:

```js
			card.innerHTML = `
				<div class="provider-title"><strong>${escapeHtml(p.label)}</strong> ${status}
					${p.supportsTools ? '<span class="tag">agent</span>' : ''}</div>
				<div class="provider-row">
					<input type="password" class="key-input" placeholder="${p.requiresApiKey ? 'Paste API key…' : 'Paste API key… (optional)'}" />
					<button class="save-key">Save</button>
				</div>
				<div class="provider-actions">
					${p.apiKeyUrl ? '<a class="get-key" href="#">Get API key</a>' : ''}
```

(The existing `card.querySelector('.get-key')?.addEventListener(...)` line already uses optional chaining, so it is safe when the link isn't rendered — no change needed there.)

- [ ] **Step 2: Typecheck**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors.

- [ ] **Step 3: Commit**

```bash
git add extensions/openvs-chat/media/main.js
git commit -m "openvs-chat: settings-card polish for keyless providers"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full compile check**

Run: `npm run gulp compile-extensions`
Expected: PASS, 0 errors. Do not proceed if failing.

- [ ] **Step 2: Picker & settings surface**

Launch the Extension Development Host (`F5` from repo root, or `--extensionDevelopmentPath=extensions/openvs-chat`). Open the chat panel:
1. Provider dropdown shows **Custom (Local / Self-hosted)** with no ⚠ badge.
2. ⚙ Providers panel shows its card with status "no key needed", key input placeholder "(optional)", and NO "Get API key" link.

- [ ] **Step 3: Keyless Ollama round-trip** (requires a local Ollama install with at least one model pulled)

1. Select the Custom provider. Click ↻ (refresh models) — dropdown populates from Ollama with no key stored.
2. Ask mode: send a question to a local model; response streams.
3. Agent mode with a tool-capable model (e.g. `llama3.1`): ask it to list files; tool call executes.
4. Image attach (sub-project 1) with a vision model (e.g. `llama3.2-vision`): paste a screenshot, confirm the reply references image content. Permissive gating must NOT block the send on any custom model.

- [ ] **Step 4: Failure modes**

1. Stop Ollama, send a message: readable network-error bubble after retry/timeout — no hang, no crash.
2. (If available) Point `openvsChat.custom.baseUrl` at a keyed gateway (e.g. `https://openrouter.ai/api/v1`) without a key: expect an auth-failed error bubble; save a key in the panel and confirm it then works with the Bearer header.

- [ ] **Step 5: Record results**

Note pass/fail per check. Any failure is a bug against this plan — fix before declaring the feature done.
