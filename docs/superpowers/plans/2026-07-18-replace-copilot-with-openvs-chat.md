# Replace built-in Copilot chat with openvs-chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove GitHub Copilot as the built-in/default chat and make the top-window Chat entry point open the openvs-chat webview in the secondary sidebar, while keeping Copilot installable from the Marketplace.

**Architecture:** A thin core workbench contribution (`openvsChatRedirect`) that (a) forces the `chatSetupHidden` context key true to suppress all Copilot setup chrome, (b) re-points the title-bar Chat menu + open/toggle commands at the `openvsChat.view` webview, and (c) relocates the `openvsChat` view container into the AuxiliaryBar. Plus `product.json` cleanup to drop the `defaultChatAgent` and Copilot auto-enable entries. Native chat stays compiled in but hidden.

**Tech Stack:** TypeScript, VS Code workbench DI (`IViewsService`, `IViewDescriptorService`, `IContextKeyService`, `MenuRegistry`, `registerWorkbenchContribution2`), `product.json`.

**Verification note:** Core workbench UI wiring has no practical unit-test harness in this repo (per CLAUDE.md, openvs-chat is verified in the Extension Development Host). Each task therefore uses `npm run typecheck-client` + `npm run valid-layers-check` as automated checks and an explicit manual Extension-Development-Host (EDH) check at the end.

---

## File structure

- `product.json` — remove Copilot default-agent + auto-enable + trusted-auth entries. (Task 1)
- Create `src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts` — the entire redirect/suppress/relocate contribution. One file, one responsibility. (Tasks 2–5)
- Modify `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` — register the new contribution near the existing `ChatSetupContribution` registration (line ~2456). (Task 2)

Constants used across tasks (define once, reuse):
- `OPENVS_CHAT_VIEW_ID = 'openvsChat.view'`
- `OPENVS_CHAT_CONTAINER_ID = 'openvsChat'`
- Native ids reused from imports: `CHAT_OPEN_ACTION_ID` (`workbench.action.chat.open`), `TOGGLE_CHAT_ACTION_ID`, `MenuId.ChatTitleBarMenu`.

---

## Task 1: product.json — drop Copilot as built-in default

**Files:**
- Modify: `product.json` (lines ~89–151 `defaultChatAgent`; ~152–159 `trustedExtensionAuthAccess`; ~235–237 `builtInExtensionsEnabledWithAutoUpdates`)

- [ ] **Step 1: Remove the `defaultChatAgent` object**

Delete the entire `"defaultChatAgent": { ... }` block (from the `"defaultChatAgent": {` line through its closing `},`). Consumers read it as `product.defaultChatAgent?.X ?? ''`, so absence is safe.

- [ ] **Step 2: Remove Copilot from auto-enable list**

Change:
```json
"builtInExtensionsEnabledWithAutoUpdates": [
	"GitHub.copilot-chat"
],
```
to:
```json
"builtInExtensionsEnabledWithAutoUpdates": [],
```

- [ ] **Step 3: Remove Copilot trusted-auth entries**

Delete the `"trustedExtensionAuthAccess": { "github": [...], "github-enterprise": [...] }` block entirely (both keys only list `GitHub.copilot-chat`).

- [ ] **Step 4: Validate JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('product.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Typecheck (defaultChatAgent removal must not break consumers)**

Run: `npm run typecheck-client`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add product.json
git commit -m "feat: drop GitHub Copilot as built-in default chat agent"
```

---

## Task 2: Scaffold the redirect contribution + suppress Copilot setup chrome

**Files:**
- Create: `src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts`
- Modify: `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` (register near line ~2456)

The `chatSetupHidden` context key (`src/vs/workbench/services/chat/common/chatEntitlementService.ts:39`, RawContextKey default `false`) gates most Copilot setup UI via `when: ChatContextKeys.Setup.hidden.negate()`. Forcing it `true` suppresses that chrome.

- [ ] **Step 1: Create the contribution file with the OpenVS copyright header and setup suppression**

Create `src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts`:
```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

/**
 * Redirects the native chat entry points to the openvs-chat webview and
 * suppresses the built-in GitHub Copilot setup chrome. OpenVS ships its own
 * chat; Copilot remains an optional Marketplace install.
 */
export class OpenVSChatRedirectContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openvsChatRedirect';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Suppress all Copilot setup chrome (welcome, status entry, quota prompts)
		// which gate on `chatSetupHidden` being false.
		ChatContextKeys.Setup.hidden.bindTo(contextKeyService).set(true);
	}
}
```

- [ ] **Step 2: Register the contribution**

In `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts`, add an import near the other contribution imports:
```ts
import { OpenVSChatRedirectContribution } from './openvsChatRedirect.contribution.js';
```
and register it just after the `ChatSetupContribution` registration (~line 2456):
```ts
registerWorkbenchContribution2(OpenVSChatRedirectContribution.ID, OpenVSChatRedirectContribution, WorkbenchPhase.BlockRestore);
```
(`registerWorkbenchContribution2` and `WorkbenchPhase` are already imported in that file — reuse them.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck-client`
Expected: no new errors.

- [ ] **Step 4: Layer check**

Run: `npm run valid-layers-check`
Expected: passes (imports stay within `workbench`).

- [ ] **Step 5: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts
git commit -m "feat: suppress Copilot setup chrome via openvs-chat redirect contribution"
```

---

## Task 3: Redirect the Chat open/toggle commands to the openvs-chat view

**Files:**
- Modify: `src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts`

`CHAT_OPEN_ACTION_ID` (`workbench.action.chat.open`, keybinding `Ctrl/Cmd+Alt+I`) and `TOGGLE_CHAT_ACTION_ID` are registered as `Action2`s in `chatActions.ts`. Rather than fight action re-registration, override the *command* behavior through `ICommandService`/`CommandsRegistry` so the same id (used by the keybinding and the `MenuId.ChatTitleBarMenu` button) reveals the openvs-chat view.

- [ ] **Step 1: Add command overrides that reveal the openvs-chat view**

Edit `openvsChatRedirect.contribution.ts` — add imports:
```ts
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CHAT_OPEN_ACTION_ID } from './actions/chatActions.js';
```
Add a module-scope constant:
```ts
const OPENVS_CHAT_VIEW_ID = 'openvsChat.view';
```
In the constructor, after the suppression line, register the overrides:
```ts
const openOpenVSChat = async (accessor: ServicesAccessor) => {
	const viewsService = accessor.get(IViewsService);
	await viewsService.openView(OPENVS_CHAT_VIEW_ID, true);
};

// The keybinding (Ctrl+Alt+I) and the title-bar Chat button both invoke
// `workbench.action.chat.open`; overriding the command reroutes all of them.
this._register(CommandsRegistry.registerCommand(CHAT_OPEN_ACTION_ID, openOpenVSChat));
```
> Note: `CommandsRegistry.registerCommand` with an existing id adds a handler; the last-registered handler wins for `executeCommand`, and this contribution runs `BlockRestore` (after `chatActions` registration). If execution order proves unreliable during the manual check (Task 6), fall back to Task 5's menu-reroute approach for the title-bar button and keep this override for the command-palette/keybinding path.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck-client`
Expected: no new errors (confirms `CHAT_OPEN_ACTION_ID` is exported from `chatActions.ts` — it is, at line 81).

- [ ] **Step 3: Layer check**

Run: `npm run valid-layers-check`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts
git commit -m "feat: reroute chat open command to openvs-chat webview"
```

---

## Task 4: Relocate the openvs-chat container to the secondary sidebar

**Files:**
- Modify: `src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts`

The extension registers `openvsChat` in the activity bar (package.json). Move it to the AuxiliaryBar (where Copilot chat sat) so the redirected button opens it in the expected spot. Use `IViewDescriptorService.moveViewContainerToLocation` (`viewDescriptorService.ts:354`). The container may not exist until the extension registers it, so move once view containers are available and guard for absence.

- [ ] **Step 1: Move the container after extensions register their view containers**

Edit `openvsChatRedirect.contribution.ts` — add imports:
```ts
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
```
Add a module-scope constant:
```ts
const OPENVS_CHAT_CONTAINER_ID = 'openvsChat';
```
Inject `@IViewDescriptorService viewDescriptorService: IViewDescriptorService` into the constructor, and after the command override add:
```ts
const relocate = () => {
	const container = viewDescriptorService.getViewContainerById(OPENVS_CHAT_CONTAINER_ID);
	if (container && viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
		viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'openvs-chat default placement');
	}
};
relocate();
this._register(viewDescriptorService.onDidChangeViewContainers(relocate));
```
> Verify the exact event/method names against `src/vs/workbench/common/views.ts` (`getViewContainerById`, `getViewContainerLocation`, `onDidChangeViewContainers`) during implementation; adjust to the real interface if they differ. Do not respect a *user's* later manual move — if that is undesirable, gate `relocate()` to run only once via a stored flag (leave as always-move for now; revisit after manual check).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck-client`
Expected: no new errors.

- [ ] **Step 3: Layer check**

Run: `npm run valid-layers-check`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts
git commit -m "feat: place openvs-chat view in the secondary sidebar by default"
```

---

## Task 5: Reroute the title-bar Chat menu item (fallback / hardening)

**Files:**
- Modify: `src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts`

Only needed if the Task 3 command override does not fully capture the title-bar button in the manual check. This explicitly appends an OpenVS entry to `MenuId.ChatTitleBarMenu` and hides the native one. Skip if Task 6 shows the button already opens openvs-chat.

- [ ] **Step 1: Append an OpenVS menu command to the title-bar chat menu**

Edit `openvsChatRedirect.contribution.ts` — add imports:
```ts
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { localize2 } from '../../../../nls.js';
```
Register a dedicated command + menu item in the constructor:
```ts
const OPENVS_OPEN_CHAT_ID = 'openvsChat.openFromTitleBar';
this._register(CommandsRegistry.registerCommand(OPENVS_OPEN_CHAT_ID, openOpenVSChat));
this._register(MenuRegistry.appendMenuItem(MenuId.ChatTitleBarMenu, {
	command: { id: OPENVS_OPEN_CHAT_ID, title: localize2('openvsOpenChat', "Open Chat") },
	group: 'a_open',
	order: 0
}));
```
(`openOpenVSChat` is the handler defined in Task 3 — hoist it to a private method so both tasks share it, rather than duplicating the body.)

- [ ] **Step 2: Typecheck + layer check**

Run: `npm run typecheck-client && npm run valid-layers-check`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts
git commit -m "feat: add openvs-chat entry to the title-bar chat menu"
```

---

## Task 6: Full verification in the Extension Development Host

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + layer check clean**

Run: `npm run typecheck-client && npm run valid-layers-check`
Expected: both pass with no errors.

- [ ] **Step 2: Build the openvs-chat extension**

Run: `npm run gulp compile-extensions`
Expected: `compile-extension:openvs-chat` completes without errors.

- [ ] **Step 3: Launch a clean profile and verify no Copilot chrome**

Launch OpenVS (`F5`, or the built app) with a fresh user profile. Confirm:
- No "Set up Copilot" welcome, no Copilot status-bar entry, no Copilot quota prompts.

- [ ] **Step 4: Verify the top Chat entry opens openvs-chat**

- Click the title-bar **Chat** button → openvs-chat webview opens in the secondary sidebar.
- Press `Ctrl+Alt+I` (mac `Cmd+Ctrl+I`) → same.
- Command palette → "Open Chat" → same.

- [ ] **Step 5: Verify Copilot is still installable**

Install `GitHub.copilot` / `GitHub.copilot-chat` from the Marketplace. Confirm it installs and the top Chat button still opens openvs-chat (does not revert to Copilot).

- [ ] **Step 6: Final commit (if any verification-driven tweaks were made)**

```bash
git add -A
git commit -m "chore: verification tweaks for openvs-chat chat redirect"
```

---

## Self-review notes

- **Spec coverage:** Goal 1 → Task 1. Goals 2 (entry points) → Tasks 3 & 5. Goal 3 (AuxiliaryBar placement) → Task 4. Goal 4 (suppress chrome) → Task 2. Goal 5 (Copilot stays installable) → verified in Task 6 Step 5 (no blocklist added, matching non-goals).
- **Uncertain API surfaces** flagged inline (command-override ordering in Task 3; exact `IViewDescriptorService` member names in Task 4) with concrete fallbacks, because they cannot be fully proven without running the workbench.
- **No secrets** touched. `product.json` edits only remove references, add nothing sensitive.
