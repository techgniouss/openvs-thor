# OpenVS AI Chat

A built-in, customizable AI chat for OpenVS — a drop-in alternative to the Copilot
chat panel that lets **you** choose the model provider.

## Features

- **Three modes**, switchable from the toolbar:
  - **Ask** — a normal streaming chat.
  - **Edit** — sends the active file, asks the model for the full updated file, and
    offers an **Apply** button that writes the change back into the editor.
  - **Agent** — an autonomous loop with tools to **read / list / write files** and
    **run commands** in your workspace. How often it stops to ask is one pill next to the
    mode picker — see [Agent permissions](#agent-permissions).
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
  - **Google Gemini** — via Google's official OpenAI-compatible endpoint and a real
    `AIza...` API key from [aistudio.google.com](https://aistudio.google.com/apikey)
    (free tier available). Not the Gemini CLI / Antigravity OAuth login — Google retired
    that route for third-party tools in mid-2026.
  - **Groq** — a real **free tier** (no credit card, no expiring credits) at
    [console.groq.com](https://console.groq.com/keys), serving Llama 3.x, GPT-OSS and Qwen
    at very high speed. Limited by requests *and tokens* per minute, per organization —
    excellent for Ask/Plan, tight for long Agent runs.
  - **Mistral** — the free *Experiment* tier of
    [La Plateforme](https://console.mistral.ai/api-keys), which reaches every Mistral model
    in exchange for opting in to having your data used for training. The roomiest free
    token allowance here.
  - **Cloudflare Workers AI** — a free allocation of 10,000 Neurons **per day** that
    renews daily. Needs your Cloudflare **account ID** as well as an API token, because
    Workers AI puts the account ID in the request URL
    (`openvsChat.cloudflare.accountId`).
  - **OpenRouter** — one key, hundreds of models including `:free` variants, with
    one-click web sign-in.
  - **Kimi (Moonshot)**, **Qwen (Alibaba Model Studio)**, and **Custom** — any
    OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, …), no key required.
- **Providers panel** (⚙) listing every provider with its key status, an inline key
  field, a **Get API key** link, a **Sign in with web** button, and a **Test connection**
  check that confirms a key works before you rely on it.
- **Streaming everywhere**, including the Agent's tool-planning steps, with **Copy** and
  **Insert at cursor** actions on every code block.
- **Reasoning stays out of the way** — a model's chain of thought collapses to a single
  line (`✻ Thought for 12s`) that expands when you want to see it, so the answer isn't
  buried under the thinking that produced it. Works for both native reasoning models and
  models that think in `<thinking>` tags.
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
    plaintext settings. Also readable from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
    `NVIDIA_API_KEY` or `GEMINI_API_KEY`.
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
| **Agent** | Plans and executes the whole task: reads, creates, edits files and runs commands. | Yes — how often it asks first is set by [Agent permissions](#agent-permissions) |

Inline **Fix / Doc / Optimize / Edit** code actions on a selection still propose a
rewrite that is applied to the editor.

The loop is also protected against the two ways an agent run wastes your tokens going
nowhere: a tool name handed to `run_command` (`list_dir .`) is rejected with a note that it
is a tool, not a shell command, and an identical read repeated before anything changed is
answered from the transcript instead of the disk. A write, a command, a sub-agent or a
context compaction expires that, so a genuine re-read after a change still runs.

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

## Inline completions

As you type, OpenVS suggests the rest of the line (or a few lines) as dimmed **ghost
text** — Copilot-style — from whichever model backend you have credentials for. Accept
with **Tab**, or invoke it explicitly with **Alt+\\**.

**The completion model is chosen separately from your chat model**, on its own role
(`complete`) in the same router that drives 🤖 Auto — but ranked the opposite way: Auto
prefers larger, more capable checkpoints, while completions prefer **small and fast**
ones, because a suggestion that arrives after the cursor has moved on is worthless no
matter how good it is. Reasoning models (anything that thinks before answering) are
excluded outright — the few seconds a reasoning pass takes is fatal for a feature that
fires on every typing pause. Leave it on *Auto-select* and OpenVS picks the fastest
coder-tagged model from whatever you've configured, or pin one yourself — either from
the editor's own inline-suggestion model picker (in the ghost-text UI itself), or by setting
`openvsChat.completions.model` directly (VS Code's own Settings UI or `settings.json`) as
`provider:model`. This is deliberately not a row in ⚙ → **Auto routing**, which only ever
lists the three Auto pipeline roles — either way, pinning a completion model never touches
your chat model's own setting.

Four independent ways to turn it on or off:

- The **`openvsChat.completions.enabled`** setting.
- The **status bar item** (bottom right, sparkle/circle-slash icon) — click it to toggle.
- The **`OpenVS Thor: Toggle Inline Completions`** command from the Command Palette.
- The checkbox in ⚙ → **Settings**: *Inline completions — suggest code as you type*.

Turning it off tears down the provider registration entirely rather than leaving it
subscribed and silent — no completions feature keeps reading your keystrokes once it's
off.

**Safety:**

- Files that can hold credentials — `.env*`, `*.pem`/`*.key`/`*.jks`/`*.p12`, SSH private
  keys, `.npmrc`/`.pypirc`/`.netrc`, `credentials.json`, `service-account*.json` — are
  never sent, and this isn't a setting you can turn off. A line that merely *looks* like a
  secret (an `sk-…` key, a GitHub token, a JWT, a private-key header) blocks the request
  too, wherever it appears.
- Completions are **off by default in untrusted workspaces**, same as Agent-mode writes;
  opt back in per-workspace with `openvsChat.completions.untrusted` if you've reviewed the
  code.
- Nothing about this feature calls out anywhere but the provider you've already
  configured — no separate telemetry, no separate endpoint.

**The fastest and cheapest option is a local fill-in-the-middle model** — point the
**Custom** provider at [Ollama](https://ollama.com) (its default) and pull
`qwen2.5-coder`, which OpenVS suggests out of the box. A local endpoint answers in
roughly 100 ms with no quota to spend, so — unlike every other role — it's automatically
considered for auto-selection once a quick reachability check confirms it's actually
running; other roles leave `custom` out of auto-selection because there's no cheap way
to know in advance whether a local server is even up. On a real FIM-capable backend
(Ollama/LM Studio's legacy completions endpoint, or Mistral's `codestral`/`devstral`) the
request goes out as a genuine prefix/suffix fill-in-the-middle call; on everything else it
falls back to a small, stateless chat prompt with strict stop sequences, and the model's
reply is run through a sanitizer that strips fences, restated prefix/suffix, and
commentary before anything is shown as ghost text.

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
| Approval policy | `openvsChat.guardrails.approval` | `auto-edits` |
| Command timeout | `openvsChat.agent.commandTimeoutMs` | `60000` |

The agent also can't read or write **outside the workspace root** (path-escape attempts are
blocked), and can't write at all in an **untrusted workspace**.

### Agent permissions

The approval policy is the pill next to the mode picker in Agent mode (also
`openvsChat.guardrails.approval`, and the **Agent permissions** section of ⚙):

| Pill | Value | Behaviour |
| --- | --- | --- |
| 🛡 **Always Ask** | `always` | Confirms every file write and every command. |
| 🛡 **Default** | `auto-edits` | File edits inside the workspace go through; commands still ask. |
| ⚡ **Full Auto** | `yolo` | Nothing is confirmed — writes, commands and MCP calls all run. |

Reading, listing and searching never ask, at any level. The hard guardrails above apply at
every level too, **including Full Auto**: a denied command stays denied, a protected path
stays unwritable, and an overwrite that shrinks a file to a fraction of its size is still
confirmed by hand, because that is what a truncated model response looks like.

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
| `openvsChat.defaultProvider` | Provider selected by default (`openai`, `anthropic`, `nvidia`, `gemini`, `openrouter`, `groq`, `mistral`, `cloudflare`, `kimi`, `qwen`, `custom`). |
| `openvsChat.<provider>.model` | Default model per provider. |
| `openvsChat.<provider>.baseUrl` | API base URL (override for proxies / compatible endpoints). |
| `openvsChat.cloudflare.accountId` | Cloudflare account ID — **required** for Workers AI, which puts it in the request URL. |
| `openvsChat.auto.planModel` | Auto-mode planning model as `provider:model` (empty = auto-select). |
| `openvsChat.auto.codeModel` | Auto-mode implementation model as `provider:model` (must be tool-capable; empty = auto-select). |
| `openvsChat.auto.reviewModel` | Auto-mode review model as `provider:model` (empty = auto-select). |
| `openvsChat.auto.enableReview` | Run a review pass after Agent runs in Auto mode (default `true`). |
| `openvsChat.systemPrompt` | System prompt prepended to every conversation. |
| `openvsChat.maxTokens` | Maximum tokens to generate. |
