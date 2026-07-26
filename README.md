# Open VS

**Open VS** is a lean, AI-native fork of [Code - OSS](https://github.com/microsoft/vscode), the
open-source core of Visual Studio Code. It keeps everything you actually use to write software —
the editor, git/SCM, debugging, the integrated terminal, search, tasks, and the extension
marketplace — and replaces the vendor-locked AI chrome with **OpenVS Chat**, a built-in,
bring-your-own-key chat panel that talks to any model provider you point it at.

Everything else that upstream turns on by default is switched off.

## What's different from Code - OSS

### 1. OpenVS Chat instead of Copilot

The built-in chat surface is [`extensions/openvs-chat`](extensions/openvs-chat), a first-party
extension that ships in the secondary sidebar. It is not a Copilot skin — it is a separate
implementation with its own agent loop, guardrails, and provider layer.

| | |
|---|---|
| **Modes** | Ask, Plan, Agent, and Auto (role-routes planning / implementation / review to different models) |
| **Providers** | OpenAI, Anthropic, NVIDIA, OpenRouter, Kimi (Moonshot), Qwen (DashScope), and any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, and friends, no key required |
| **Sign-in** | API keys in VS Code `SecretStorage` (never plaintext settings), plus one-click OAuth for Claude, ChatGPT, and OpenRouter |
| **Agent tools** | Read/list/write files, run commands, ripgrep-backed search, `ask_user` questions, and `spawn_subagent` delegation — an identical read repeated before anything changed is answered from the transcript, so a run can't stall re-reading the same file |
| **Sessions** | Multiple chat tabs streaming in parallel; typing while a run streams either queues (Ask/Plan) or steers the live agent |
| **Approvals** | Three levels — **Always Ask**, **Default** (edits go through, commands ask), **Full Auto** — shown as inline cards in the tab that raised them, with a diff, an "allow for this run" option, and a written reason on denial that is fed back to the model |
| **Reasoning** | Collapsed to one line (`✻ Thought for 12s`) and expandable, for native reasoning models and `<thinking>`-tag models alike |
| **Guardrails** | Protected paths, denied-command regexes, workspace-root confinement, and untrusted-workspace write blocking — enforced in code, not promptable away |
| **MCP** | Full Model Context Protocol client; global (`openvsChat.mcp.servers`) and per-project (`.openvs/mcp.json`) servers, project overriding global |
| **Rules & skills** | Always-on steering from `.openvs/rules.md` / `AGENTS.md` / `.github/copilot-instructions.md` / `.cursorrules`, plus activatable instruction packs in `.openvs/skills/*.md` |

The native chat entry points (title-bar button, `workbench.action.chat.*`, quick chat, inline
chat) are all rerouted to the OpenVS Chat view by
[`openvsChatRedirect.contribution.ts`](src/vs/workbench/contrib/chat/browser/openvsChatRedirect.contribution.ts),
and the native chat view container is deregistered.

### 2. A lean default workbench

Upstream's agent chrome, sign-in affordances, telemetry, and first-run promotion are all off by
default. The entire opt-out is one file —
[`openvsDefaults.contribution.ts`](src/vs/workbench/browser/openvsDefaults.contribution.ts) —
which registers *default* overrides, the lowest-precedence configuration layer. Nothing is
deleted from the product, so every one of these is a single setting away from coming back, and
rebasing on `microsoft/vscode` stays mechanical.

Turned off:

- **Agents** — the title-bar "Open in Agents Window" button, the agent status indicator and
  unified agents bar in the command center, and the agent-sessions list inside the chat view
  (`chat.titleBar.openInAgentsWindow.enabled`, `chat.agentsControl.enabled`,
  `chat.unifiedAgentsBar.enabled`, `chat.viewSessions.enabled`).
- **Sign in** — the title-bar Copilot sign-in button and the rest of the built-in AI features
  (`chat.titleBar.signIn.enabled`, `chat.disableAIFeatures`).
- **Telemetry and experiments** — `telemetry.telemetryLevel`, `workbench.enableExperiments`, and
  the remote round trip behind `workbench.settings.enableNaturalLanguageSearch`.
- **First-run and promotional surfaces** — the welcome page on startup, walkthroughs on install,
  extension recommendation notifications (including the remote indicator's), and release notes.

Deliberately kept, because they are load-bearing for normal work:

- **Accounts** in the activity/title bar — it is how GitHub and other authentication is managed,
  which git workflows depend on.
- **The issue reporter** (`telemetry.feedback.enabled`) — `product.json` points `reportIssueUrl`
  at this repository.
- **The empty-editor watermark** (`workbench.tips.enabled`) — a keyboard-shortcut affordance,
  not promotion.

Everything else — git, SCM, debug, terminal, search, tasks, notebooks, remote, extensions — is
untouched upstream VS Code.

## Building and running

Requires the same toolchain as Code - OSS (Node.js, Python, and a C++ toolchain for native
modules). See the upstream [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
guide for platform-specific prerequisites.

```sh
npm install
npm run watch      # incremental build of client + extensions (what you want during development)
./scripts/code.sh  # or scripts\code.bat on Windows
```

On Windows without the native build tools installed, [`run-openvs.bat`](run-openvs.bat) transpiles
`src/`, compiles the chat extension, and launches with `VSCODE_SKIP_PRELAUNCH=1`:

```bat
run-openvs.bat
```

Other useful targets:

| Command | Does |
|---|---|
| `npm run compile` | Full one-shot compile |
| `npm run typecheck-client` | Type-check `src/` only, no emit — the fast check after editing core sources |
| `npm run gulp compile-extensions` | Type-check / build the bundled extensions, including `openvs-chat` |
| `npm run valid-layers-check` | Enforce the `base` → `platform` → `editor` → `workbench` layering rules |
| `npm run eslint` / `npm run stylelint` / `npm run hygiene` | Lint TS/CSS and repo hygiene |

## Tests

```sh
npm run test-node                            # unit tests (test/unit/node), mocha tdd
npm run test-browser                         # browser-context unit tests
npm run test-extension                       # extension-host tests
npm test --prefix extensions/openvs-chat     # the chat extension's own suite
```

The chat extension's suite runs against the real tool layer over an in-memory workspace (the
`vscode` module is stubbed through `Module._load`, not mocked), plus static guards on the
host↔webview contract and the approval/question cards. Rendering *appearance* still has to be
checked by hand in the Extension Development Host (`F5`, or launch with
`--extensionDevelopmentPath=extensions/openvs-chat`).

While iterating on the extension, the fast loop is:

```sh
npm run typecheck --prefix extensions/openvs-chat   # also type-checks media/main.js
npm test --prefix extensions/openvs-chat
```

### Continuous integration

There is none, deliberately. The workflows inherited from `microsoft/vscode` all targeted
Microsoft's own infrastructure — self-hosted `1ES.Pool` runners, `vscode-large-runners`,
internal secrets, telemetry extraction, Monaco publishing — so none of them could ever run
in this fork, and they have been removed rather than left to fail. Verification is the local
commands above.

## Repository layout

```
src/vs/base/          foundation utilities, cross-platform abstractions
src/vs/platform/      platform services and the DI infrastructure
src/vs/editor/        the text editor (Monaco)
src/vs/workbench/     the application shell — parts, services, contrib features
src/vs/code/          Electron main-process specifics
src/vs/server/        remote/server specifics
extensions/           bundled extensions, including openvs-chat
build/  scripts/  test/
```

[CLAUDE.md](CLAUDE.md) has the detailed architecture notes, including the `openvs-chat` module
layout and the repo-wide coding guidelines.

## Contributing

Issues and pull requests are welcome at
[github.com/techgniouss/openvs](https://github.com/techgniouss/openvs). Changes under `src/`
should follow the upstream
[coding guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines); changes under
`extensions/openvs-chat` follow the conventions in [CLAUDE.md](CLAUDE.md).

If a change touches upstream VS Code files, keep the diff minimal — this fork is rebased on
`microsoft/vscode`, and every line of divergence is a future merge conflict.

## License

Open VS is a derivative of Code - OSS.

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license.
