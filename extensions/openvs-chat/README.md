# OpenVS AI Chat

A built-in, customizable AI chat for OpenVS — a drop-in alternative to the Copilot
chat panel that lets **you** choose the model provider.

## Features

- **Three modes**, switchable from the toolbar:
  - **Ask** — a normal streaming chat.
  - **Edit** — sends the active file, asks the model for the full updated file, and
    offers an **Apply** button that writes the change back into the editor.
  - **Agent** — an autonomous loop with tools to **read / list / write files** and
    **run commands** in your workspace (every write and command asks for approval).
- **🤖 Auto (role routing)** — a special provider choice that runs each phase of a task
  on a different model. In **Agent** mode it runs a full **plan → implement → review**
  pipeline (e.g. plan with Claude Opus, implement with Sonnet, review with GPT-4o); in
  **Ask** it uses your planning model and in **Edit** your implementation model. Configure
  the per-role models in the ⚙ **Auto routing** panel, or leave them on *Auto-select* and
  OpenVS picks the best model from whichever keys you've configured.
- **Multiple providers** out of the box:
  - **OpenAI (ChatGPT)** — `gpt-4o`, `gpt-4o-mini`, `o4-mini`, …
  - **Anthropic (Claude)** — `claude-3-5-sonnet`, `claude-sonnet-4`, …
  - **NVIDIA** — a generous **free tier** via [build.nvidia.com](https://build.nvidia.com/)
    with models like Llama 3.x, Nemotron, Qwen Coder and DeepSeek.
- **Providers panel** (⚙) listing every provider with its key status, an inline key
  field, a **Get API key** link, a **Sign in with web** button, and a **Test connection**
  check that confirms a key works before you rely on it.
- **Streaming everywhere**, including the Agent's tool-planning steps, with **Copy** and
  **Insert at cursor** actions on every code block.
- **Inline editor actions** (right-click a selection: Explain / Fix / Document / Optimize /
  Generate tests / Edit) and **slash commands** (`/fix`, `/explain`, `/auto`, …) in the chat box.
- **Prompt enhancement** (✨ / `/enhance`) rewrites your draft into a sharper prompt.
- **Skills** — activatable instruction packs (built-in + your own via settings or
  `.openvs/skills/*.md`) that steer the assistant for a task.
- **MCP servers** (global + per-project) give the agent extra tools over the Model Context Protocol.
- **Resilient requests** — a connection timeout plus automatic retry/backoff on transient
  failures (network errors, HTTP 429/5xx, honouring `Retry-After`).
- **Workspace-trust aware** — Agent mode won't write files or run commands in an untrusted
  workspace.
- **Three ways to authenticate:**
  - **API key** — stored in the OS secret store (VS Code `SecretStorage`), never in
    plaintext settings. Also readable from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or
    `NVIDIA_API_KEY`.
  - **Subscription sign-in (no API key)** — **Sign in with Claude** logs in with your
    claude.ai account (works with a Claude Pro/Max subscription): approve access in the
    browser and paste the confirmation code back. **Sign in with ChatGPT** logs in with
    your openai.com account via a localhost callback; if the account has API access a
    real API key is minted, otherwise your ChatGPT subscription is used directly
    (Codex models: `gpt-5`, `gpt-5-codex`). Tokens are stored in the OS secret store and
    refreshed automatically.
  - **Custom web sign-in** — configure `openvsChat.<provider>.authUrl` to point at your
    own OAuth/proxy service; the editor opens it, then receives the token back through
    its URI callback and stores it for you.
- **Model dropdown** populated from each provider's suggested models, with a **↻**
  button that live-fetches the full model list from the provider's `/models` endpoint.
- **Context attachment** (📎) — attach the active file or selection to your prompt.
- **Streaming responses** rendered as Markdown with code blocks.
- **Configurable** default provider, per-provider model + base URL, system prompt,
  max tokens, and agent step budget.
- Lives in its own **Activity Bar** view, just like Copilot Chat.

## Getting started

1. Open the **AI Chat** view from the Activity Bar (chat-bubble icon).
2. Click **⚙** to open the **Providers** panel, then either paste an API key or use
   **Sign in with Claude** / **Sign in with ChatGPT** to log in with your subscription
   account (no API key needed). **Get API key** opens the provider's website.
3. Pick a provider and model in the toolbar, choose **Ask / Plan / Agent**, type a
   message, and press **Enter**.

> **Tip:** NVIDIA's free tier is the default provider, so you can try the chat at no
> cost — just create a free `nvapi-...` key at build.nvidia.com.

## Modes in detail

| Mode | What it does | Touches your files? |
| --- | --- | --- |
| **Ask** | Read-only Q&A grounded in the files open in your editor tabs. | No |
| **Plan** | Produces an implementation plan for your requirement — no code, no changes. | No |
| **Agent** | Plans and executes the whole task: reads, creates, edits files and runs commands. | Writes/edits/commands require per-action approval |

Inline **Fix / Doc / Optimize / Edit** code actions on a selection still propose a
rewrite that is applied to the editor.

> Agent mode uses function/tool calling, which works best with tool-capable models
> (e.g. GPT-4o, Claude, Llama-3.3-70B). A model without tool support will report an
> error when asked to run as an agent.

## Auto mode (role routing)

Select **🤖 Auto** in the provider dropdown to route each phase of a task to its own
model. Open ⚙ → **Auto routing** to assign models per role:

| Role | Used for | Needs tools? |
| --- | --- | --- |
| **Planning** | Breaking the request into a plan (and answering in **Ask** mode). | No |
| **Implementation** | Writing code / running the agent tool-loop (and **Edit** mode). | **Yes** |
| **Review** | A critique pass over the agent's changes after **Agent** runs. | No |

How Auto behaves per mode:

- **Agent** → runs the full **plan → implement → review** pipeline. The planning model
  drafts a plan, the implementation model carries it out with tools (each write/command
  still asks for approval), and the review model critiques the result.
- **Ask** → answers with the **planning** model.
- **Edit** → rewrites the file with the **implementation** model.

Two ways to configure it:

1. **Pin models** — set `provider:model` for any role, e.g.
   `"openvsChat.auto.planModel": "anthropic:claude-opus-4-0"`,
   `"openvsChat.auto.codeModel": "anthropic:claude-sonnet-4-0"`,
   `"openvsChat.auto.reviewModel": "openai:gpt-4o"`. A pinned role is used **exactly** as
   set — Auto never silently substitutes it. If its API key is missing (or an
   implementation model isn't tool-capable), the run stops with a clear warning instead of
   falling back.
2. **Auto-select** — leave a role empty and OpenVS picks the best available model for that
   role from whichever providers currently have a key. If an auto-selected model fails with
   a "model not found" error before doing anything, it automatically falls back to the next
   best candidate. (Pinned roles never fall back — they're used exactly as set.)

The review phase is fed the implementer's **actual file writes and command output**, not
just its prose summary, so the critique is grounded in the real changes.

Turn the review pass off with `openvsChat.auto.enableReview: false` (or the checkbox in the
panel). The toolbar shows a compact summary of the current routing, with a ⚠ next to any
role that can't run yet.

## Prompt enhancement

Type a rough idea, click the **✨** button (or `/enhance`), and the model rewrites your draft
into a clearer, more specific prompt — placed back in the input for you to review and send.

## Skills

**Skills** are named instruction packs you can activate to steer the assistant for a task.
Activate one from the **Select Skill** command, the skill chip, or `/skill <id>` (`/skill off`
to clear); `/skills` lists them. The active skill's instructions are prepended to every message.

Four skills ship by default, bundled verbatim from their upstream `SKILL.md` (under
`skills/`):

| Skill | Source |
| --- | --- |
| **Caveman** | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) — compress memory into terse shorthand to save tokens |
| **Impeccable** | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) — a design language for better frontend UI/UX |
| **UI UX PRO MAX** | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) — design intelligence (styles, palettes, type, UX) |
| **Agent Browser** | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) — browser-automation workflow via the `agent-browser` CLI |

> These ship as the skills' canonical instructions. Some reference companion scripts/CLIs
> (e.g. `agent-browser`, the UI/UX search CLI) that you install separately per the upstream
> repo; the skill text still steers the assistant and documents the workflow.

Add or override skills two ways:

```jsonc
// settings.json
"openvsChat.skills": [
  { "id": "caveman", "name": "Caveman", "instructions": "…full skill text…" }
]
```

```
.openvs/skills/caveman.md     # first "# Heading" = name, first "> quote" = description
```

> The bundled skills are the property of their respective authors and remain under their
> original (mostly MIT) licenses; they're included here for convenience with attribution
> above. Update them from upstream with the files under `skills/`.

## MCP servers (Model Context Protocol)

Connect external MCP servers to give the agent extra tools (databases, browsers, search, …).
Configure them **globally** in settings or **per project** in a file:

```jsonc
// Global — settings.json
"openvsChat.mcp.servers": {
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
}
```

```jsonc
// Project — .openvs/mcp.json (or .vscode/mcp.json). { "mcpServers": {...} } is also accepted.
{ "servers": { "github": { "command": "docker", "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"] } } }
```

Their tools appear to the agent as `mcp__<server>__<tool>` and each call asks for approval
(unless the guardrail policy is `yolo`). Project servers merge over global ones, and stdio
servers only start in a **trusted** workspace. Use **MCP: Reconnect Servers** /
**MCP: Show Server Status** from the Command Palette to manage them.

## Inline editor & slash commands

Work without leaving the editor:

- **Right-click a selection → AI Chat** (or use the lightbulb / Command Palette) for
  **Explain**, **Fix**, **Document**, **Optimize**, **Generate tests**, and **Edit
  selection…**. Explain/Tests answer in the chat; Fix/Doc/Optimize/Edit stream a
  replacement with an **Apply** button that writes back to **exactly the selected range**.
- **Slash commands** in the chat box:
  - `/ask` `/edit` `/agent` — switch mode (optionally followed by a message)
  - `/auto` — switch to Auto (role-routed) mode
  - `/explain` `/fix` `/doc` `/optimize` `/tests` — run the inline action on the current selection
  - `/clear` — new chat   ·   `/help` — list commands

## Sub-agents

In Agent mode (and the Auto implementation phase) the model can call a **`spawn_subagent`**
tool to delegate a focused, self-contained subtask to a nested agent with its own tool loop.
This keeps big tasks from stalling in one long context:

- **Parallel research** — sub-agents marked `readOnly` (inspect-only) run **concurrently**,
  so the model can fan out "find every caller of X / read these five files" at once. They get
  only the read/list tools.
- **Sequential work** — write-capable sub-agents run one at a time, so two can't make
  conflicting edits.
- **Bounded** — `openvsChat.agent.maxSubagents` caps how many a run may spawn and
  `openvsChat.agent.maxSubagentDepth` caps nesting, so cost can't run away. Toggle parallel
  research with `openvsChat.agent.parallelResearch`.

**Planner decomposition (Auto):** set `openvsChat.auto.decompose: true` and Auto+Agent will
split the plan into numbered steps and run a sub-agent per step in order, instead of one
long implementer pass.

## Rules & guardrails

Two complementary layers control the assistant's behaviour:

**Rules (soft steering)** are always-on instructions prepended to every conversation. Set
them in `openvsChat.rules`, or keep them in the repo — any of these files is auto-loaded
when present (configurable via `openvsChat.ruleFiles`):

```
.openvs/rules.md   AGENTS.md   .github/copilot-instructions.md   .cursorrules
```

Use them for conventions and constraints ("use tabs", "never edit `generated/`",
"prefer composition over inheritance"). They apply across Ask, Edit, Agent and Auto.

**Guardrails (hard, enforced in code)** can't be talked around by the model:

| Guardrail | Setting | Default |
| --- | --- | --- |
| Blocked commands (regex) | `openvsChat.guardrails.deniedCommands` | `rm -rf`, fork bombs, `sudo`, `git push --force`, `curl … \| sh`, … |
| Command allow-list (regex) | `openvsChat.guardrails.allowedCommands` | empty (off) |
| Protected paths (no writes) | `openvsChat.guardrails.protectedPaths` | `.git`, `.env*`, `*.pem`, `*.key`, … |
| Approval policy | `openvsChat.guardrails.approval` | `always` |
| Command timeout | `openvsChat.agent.commandTimeoutMs` | `60000` |

The agent also can't read or write **outside the workspace root** (path-escape attempts are
blocked), and can't write at all in an **untrusted workspace**. Approval policy `yolo`
auto-approves writes/commands — use it knowingly.

## Web sign-in (login instead of a key)

Set `openvsChat.<provider>.authUrl` to a backend that implements the sign-in handoff,
and the **Sign in with web** button comes alive. The editor opens
`authUrl?redirect_uri=<callback>&state=<nonce>&provider=<id>`, your backend authenticates
the user, and redirects back to the callback with `&token=<api-token>`, which the editor
stores as the provider key.

A complete, runnable reference backend lives in
[`examples/auth-server/`](examples/auth-server/README.md). It demonstrates both an
interactive login and a **shared-key / zero-config** mode (your server hands every user a
token so they never paste one). Run it with `node examples/auth-server/server.mjs` and set
`"openvsChat.nvidia.authUrl": "http://localhost:7345/login"`.

## Adding more providers

Every provider implements the small `ChatProvider` interface in
`src/providers/types.ts` and is registered in `src/providers/registry.ts`. Because
NVIDIA and most gateways are OpenAI-compatible, you can often add a new backend just by
pointing `openvsChat.openai.baseUrl` at it, or by copying `openai.ts` and adjusting the
endpoint/headers.

## Settings

| Setting | Description |
| --- | --- |
| `openvsChat.defaultProvider` | Provider selected by default (`openai`, `anthropic`, `nvidia`). |
| `openvsChat.<provider>.model` | Default model per provider. |
| `openvsChat.<provider>.baseUrl` | API base URL (override for proxies / compatible endpoints). |
| `openvsChat.auto.planModel` | Auto-mode planning model as `provider:model` (empty = auto-select). |
| `openvsChat.auto.codeModel` | Auto-mode implementation model as `provider:model` (must be tool-capable; empty = auto-select). |
| `openvsChat.auto.reviewModel` | Auto-mode review model as `provider:model` (empty = auto-select). |
| `openvsChat.auto.enableReview` | Run a review pass after Agent runs in Auto mode (default `true`). |
| `openvsChat.systemPrompt` | System prompt prepended to every conversation. |
| `openvsChat.maxTokens` | Maximum tokens to generate. |
