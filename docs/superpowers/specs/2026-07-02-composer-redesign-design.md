# Composer Redesign (Cursor-style) — Design

## Context

Sub-project 3 of the Cursor/Antigravity-parity effort for `extensions/openvs-chat`.
Sub-project 1 shipped image attachments; sub-project 2 shipped the Custom
(local/self-hosted) provider. This one redesigns the part of the UI users touch
most: the composer. Direction was chosen interactively via mockups (see
`.superpowers/brainstorm/1590-1782982358/content/composer-final-v2.html`): Option A
("everything in the box") with A1's side-by-side provider + model dropdowns.

## Goals

The chat panel's top toolbar disappears. All controls move into a single
bordered composer container at the bottom of the panel:

- **Row 1 (chips, only when present):** the existing skill / attached-context /
  image chips render inside the box, above the text area.
- **Row 2:** the text area (auto-sizing, borderless inside the container; the
  container carries the border and the focus highlight), with the **round
  icon-only send button** anchored at its right edge (bottom-aligned as the
  textarea grows; becomes the stop button while streaming, as today).
- **Row 3 (control bar):**
  - Left: **mode dropdown pill** (Ask / Edit / Agent — one compact control, not
    three buttons), then **provider dropdown** and **model dropdown** side by
    side, then a small **↻ refresh-models** icon button.
  - Right: **📎 attach**, **✨ enhance**, **⚙ settings** icon buttons. The send
    button is NOT in this bar — it lives in row 2 beside the text.
- Emoji glyphs are replaced with monochrome inline SVG icons (codicon-style),
  themed via `currentColor` so they follow VS Code's theme.
- The container border uses the input border color, switching to the focus
  border color when the text area has focus (`:focus-within`).

## Non-goals

- No changes to message rendering (bubbles, code blocks, tool cards).
- No redesign of the settings/providers panel — the ⚙ button opens the
  existing panel unchanged.
- No behavior changes: every existing webview↔host message
  (`send`, `stop`, `setProvider`, `setModel`, `listModels`, `attachContext`,
  `enhancePrompt`, `setRole`, slash commands, …) keeps its exact shape and
  semantics. This is a presentation-layer change only.

## Functional invariants (must survive the restyle)

- **Mode availability gating:** Agent mode is disabled (with the explanatory
  tooltip) when the selected model isn't tool-capable; if the current mode
  becomes unavailable it falls back to Ask. Today this disables one of three
  buttons; with a dropdown pill it disables the Agent option inside the
  dropdown instead.
- **Auto provider:** selecting 🤖 Auto in the provider dropdown hides the model
  dropdown + ↻ and shows the routing summary text in their place (existing
  behavior, restyled to fit the bar).
- **Streaming state:** send button swaps to a stop button; text area and
  enhance button disable while streaming.
- **Key-missing badge:** the provider dropdown keeps the ⚠ suffix on providers
  that require a key and have none.
- **Chips:** remove-⁠✕ behavior unchanged; chips relocate visually into the box
  but keep their existing DOM ids (`skillChip`, `contextChip`, `imageChips`)
  and rendering functions.
- **Enter to send / Shift+Enter newline / slash commands:** unchanged.

## Architecture

Three files, presentation-layer only:

- `src/chatViewProvider.ts` — `getHtml()` template restructured: the
  `<header id="toolbar">` block is removed; a new
  `<footer id="composer">` structure nests chips, textarea, and the control
  bar inside one `.composer-box` container. Mode switch becomes a
  `<select id="modeSelect">` styled as a pill (native select keeps keyboard
  and screen-reader behavior for free; per-option `disabled` handles the
  Agent gating). Inline SVGs are embedded directly in the template for the
  icon buttons.
- `media/main.css` — new `.composer-box`, `.composer-bar`, pill/select/icon
  styles; removal of now-dead `#toolbar` styles; all colors from
  `--vscode-*` variables.
- `media/main.js` — element refs updated (`modeSwitch` buttons →
  `modeSelect`); `setMode`/`updateModeAvailability` adapt to a select
  (setting `.value` and per-option `disabled` instead of toggling button
  classes); everything else (send/stream/chips/settings logic) untouched.

## Error handling

No new failure modes — no new host messages, no new async work. The only risk
class is regression of existing UI behavior, covered by the invariants list
above and manual verification.

## Testing

No automated test suite in this extension (repo convention). Typecheck gate
per task (`npm run gulp compile-extensions`, which also validates `main.js`
via `@ts-check`), then manual verification in the Extension Development Host:

- Composer renders as the approved mockup: chips (when present) → textarea
  with send button at its right → bar with mode pill, provider, model, ↻ left;
  📎 ✨ ⚙ right.
- Mode dropdown switches Ask/Edit/Agent; Agent option disabled for a
  non-tool-capable model and mode falls back to Ask.
- Auto provider hides model+↻ and shows the routing summary in the bar.
- Send↔stop swap during streaming; textarea/enhance disabled while streaming.
- Chips appear inside the box and their ✕ buttons work (skill, context, image).
- Paste-image, enhance, attach, settings, refresh-models all work as before.
- Panel remains usable at narrow sidebar widths (bar wraps gracefully).
- Light theme + dark theme both look correct (colors all from theme vars).
