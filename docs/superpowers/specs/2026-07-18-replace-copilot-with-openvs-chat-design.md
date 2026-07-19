# Replace built-in GitHub Copilot chat with openvs-chat

**Date:** 2026-07-18
**Status:** Approved (design)

## Problem

When OpenVS launches, GitHub Copilot is presented as the built-in, default chat
agent. The top-window **Chat** button (and its keybinding) opens the native VS Code
chat panel, which advertises "Set up Copilot" and auto-enables the Copilot chat
extension. We want OpenVS's own `openvs-chat` extension to be the chat that opens
there instead. Copilot should remain an *optional* Marketplace install, not a
built-in default.

## Goals

1. Remove GitHub Copilot as the built-in / default chat agent.
2. Make the top-window **Chat** entry point — the title-bar Chat button, the
   `workbench.action.chat.open` command, the `Ctrl+Alt+I` keybinding, and the
   Toggle Chat action — open the `openvs-chat` webview view.
3. Place the openvs-chat view in the secondary sidebar (AuxiliaryBar), where
   Copilot chat previously lived.
4. Suppress all Copilot-branded chrome (setup welcome, status-bar entry, quota
   notifications) so no Copilot branding appears by default.
5. Keep GitHub Copilot installable from the Marketplace for users who want it.

## Non-goals

- Rebuilding openvs-chat as a native chat participant / language-model provider
  (rejected: would discard the existing custom webview UI).
- Fully deregistering the native chat subsystem (rejected: risks breaking
  dependent features like agent sessions and inline chat). We only hide/redirect.
- Blocklisting Copilot from installation.

## Chosen approach

**Redirect to webview, via a thin core patch (B1).** Keep the `openvs-chat`
extension unchanged as the chat UI. Add a small workbench contribution that
overrides the native chat entry-point commands to reveal the openvs-chat view,
suppresses the Copilot setup chrome, and relocates the openvs-chat container to
the AuxiliaryBar. Native chat stays compiled in but hidden — lowest risk, easiest
to rebase against upstream VS Code.

## Current-state facts (verified)

- `product.json`
  - `defaultChatAgent` (lines 89–151) = `GitHub.copilot` / `GitHub.copilot-chat`,
    plus all its URLs, provider, entitlement, and command wiring.
  - `builtInExtensionsEnabledWithAutoUpdates` (lines 235–237) = `["GitHub.copilot-chat"]`.
  - `trustedExtensionAuthAccess.github` / `.github-enterprise` (lines 152–159) =
    `["GitHub.copilot-chat"]`.
  - Copilot is **not** in the `builtInExtensions` download array (line 39+), so
    there is no bundled VSIX to remove.
- Native chat wiring (`src/vs/workbench/contrib/chat/browser/`)
  - `chatParticipant.contribution.ts:40-48` registers the native chat view
    container in `ViewContainerLocation.AuxiliaryBar` with `{ isDefault: true,
    doNotRegisterOpenCommand: true }`; `:51-70` registers the `ChatViewId` view
    (`ChatViewPane`).
  - `chatActions.ts:541` — `PrimaryOpenChatGlobalAction` registers
    `CHAT_OPEN_ACTION_ID = 'workbench.action.chat.open'` with keybinding
    `Ctrl/Cmd+Alt+I` (mac `Cmd+Ctrl+I`) and menu `MenuId.ChatTitleBarMenu`
    (group `a_open`, order 1).
  - `chatActions.ts:604` — `TOGGLE_CHAT_ACTION_ID` toggles the chat part
    visibility based on `ChatViewId`'s location.
  - `chatSetup/*` contributions render the "Set up Copilot" experience; all read
    `product.defaultChatAgent?.X ?? ''` — i.e. they degrade to empty strings when
    `defaultChatAgent` is absent but do **not** hide themselves. Active
    suppression is required.
- `openvs-chat` extension (`extensions/openvs-chat/package.json`)
  - View container `openvsChat` (currently `activitybar`), webview view
    `openvsChat.view`, focus command `openvsChat.focus`.

## Design

### Part A — product.json

- **Neutralize (do NOT remove) `defaultChatAgent`.** Removal crashes startup:
  `defaultChatAgent` is typed *required* (`base/common/product.ts`) and hard-
  dereferenced without optional chaining at several sites — `assertDefined` in
  `welcomeOnboarding/onboardingVariationA` (module scope), `defaultAccount`,
  `extensionGalleryService`, `chatWidget`, extension management — so `typecheck`
  cannot catch the runtime hole. Instead replace the Copilot values with a
  structurally-complete, neutralized agent: OpenVS naming, empty URLs/commands,
  non-matching extension ids, zero GitHub Copilot references. Copilot chrome stays
  hidden via `IChatEntitlementService.setForceHidden(true)` (Part B), which forces
  `chatSetupHidden` through `withConfiguration()` on every context update.
- Remove `"GitHub.copilot-chat"` from `builtInExtensionsEnabledWithAutoUpdates`
  (leave the array present, empty).
- Remove the Copilot entries from `trustedExtensionAuthAccess` (drop the
  `github` / `github-enterprise` keys, or their `GitHub.copilot-chat` values).

### Part B — core workbench patch

A new workbench contribution (e.g.
`src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts`,
registered `AfterRestored`) that:

1. **Redirects entry points.** Overrides the run behavior of:
   - `workbench.action.chat.open` (and its per-mode variants if they surface in
     the title bar),
   - `TOGGLE_CHAT_ACTION_ID`,
   so they reveal/focus `openvsChat.view` (via `IViewsService.openView` /
   `openViewContainer`) instead of the native `ChatViewId`. The `Ctrl+Alt+I`
   keybinding and `MenuId.ChatTitleBarMenu` button inherit the new behavior
   because they invoke the same command id.
   - Preferred mechanism: register our override so the openvs-chat view is what
     the command resolves to. If command-id override proves brittle, fall back to
     re-registering the title-bar menu item to a new command
     (`openvsChat.focus`) and hiding the native one via `when` context.

2. **Suppresses Copilot chrome.** Prevent the `chatSetup/*` contributions and the
   Copilot chat status-bar entry from rendering — e.g. gate them behind a context
   key that is always false in OpenVS, or skip their registration. No Copilot
   branding should appear on a clean profile.

3. **Relocates openvs-chat to the AuxiliaryBar.** Ensure the `openvsChat` view
   container's default location is the secondary sidebar so the redirected button
   opens it where users expect. The native chat container is left registered but
   its part is kept hidden by default.

### Data / control flow

```
User clicks title-bar Chat button  ┐
User presses Ctrl+Alt+I            ├─▶ workbench.action.chat.open
Command palette "Open Chat"         ┘        │ (overridden)
                                             ▼
                              reveal openvsChat.view in AuxiliaryBar
                                             │
                                             ▼
                              openvs-chat extension webview renders
```

Native chat (`ChatViewId`) is never surfaced by default; Copilot setup chrome is
suppressed. Copilot remains installable from the Marketplace, at which point it
registers as an ordinary (non-default) chat participant.

## Error handling / edge cases

- If `openvsChat.view` is not yet activated when the command fires, revealing the
  view triggers the extension's `onStartupFinished` activation; the reveal must
  await view readiness.
- If a user *does* install Copilot, the redirect still points the top button at
  openvs-chat (intended). Copilot is reachable via its own commands/views.
- `defaultChatAgent` removal must not break agent-sessions / inline-chat compile;
  guard with `typecheck-client` and `valid-layers-check`.

## Testing / verification

- `npm run typecheck-client` clean after core edits.
- `npm run valid-layers-check` clean.
- Manual (Extension Development Host / `F5`): clean profile shows **no** Copilot
  branding; title-bar Chat button + `Ctrl+Alt+I` open the openvs-chat webview in
  the secondary sidebar; command palette "Open Chat" does the same; installing
  GitHub Copilot from the Marketplace still works and does not reclaim the default
  button.

## Files expected to change

- `product.json` (Part A).
- New: `src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts`.
- Registration wiring in the chat contribution entry
  (`chat.contribution.ts` / `chat.view.contribution.ts`).
- Possibly `chatSetup/chatSetupContributions.ts` (gate/suppress).
- `extensions/openvs-chat/package.json` if container placement is adjusted there.
