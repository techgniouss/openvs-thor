/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMode } from './types';

/**
 * The slash-command catalog the composer's autocomplete menu filters and shows, ported
 * verbatim from `SLASH_COMMANDS` at `media/main.js`.
 */
export const SLASH_COMMANDS: readonly { cmd: string; desc: string }[] = [
	{ cmd: 'ask', desc: 'Switch to Ask mode (optionally with a message)' },
	{ cmd: 'plan', desc: 'Switch to Plan mode' },
	{ cmd: 'agent', desc: 'Switch to Agent mode' },
	{ cmd: 'auto', desc: 'Use Auto — role-routed plan → implement → review' },
	{ cmd: 'explain', desc: 'Explain the current editor selection' },
	{ cmd: 'fix', desc: 'Fix the current editor selection' },
	{ cmd: 'doc', desc: 'Document the current editor selection' },
	{ cmd: 'optimize', desc: 'Optimize the current editor selection' },
	{ cmd: 'tests', desc: 'Write tests for the current editor selection' },
	{ cmd: 'enhance', desc: 'Rewrite your draft into a sharper prompt' },
	{ cmd: 'skills', desc: 'List available skills' },
	{ cmd: 'skill', desc: 'Activate a skill — "off" clears all, "new" creates one' },
	{ cmd: 'mcp', desc: 'MCP server status — "add" registers, "reconnect" retries' },
	{ cmd: 'history', desc: 'Reopen a previous conversation' },
	{ cmd: 'clear', desc: 'Clear this chat tab (saved to History)' },
	{ cmd: 'help', desc: 'Show all slash commands' },
];

/** The five inline-editor-action commands, ported verbatim from `SLASH_INLINE` in `media/main.js`. */
export const SLASH_INLINE: readonly string[] = ['explain', 'fix', 'doc', 'optimize', 'tests'];

/**
 * Splits a composer line into its leading slash command and the rest, ported verbatim from
 * the regex `handleSlash` used at `media/main.js`. Exported on its own — useful independently
 * of {@link runSlash} and exercised directly by `scripts/test-slash.mjs`.
 */
export function parseSlash(text: string): { cmd: string; rest: string } | undefined {
	const m = /^\/(\w+)\s*([\s\S]*)$/.exec(text);
	if (!m) {
		return undefined;
	}
	return { cmd: m[1].toLowerCase(), rest: m[2].trim() };
}

/** The result of {@link runSlash} — what the caller (`chatViewProvider.ts`) should do next. */
export interface SlashResult {
	/** True if `text` was a recognized slash command (host already acted on it or replied). */
	readonly handled: boolean;
	/**
	 * Present only for `/ask`, `/plan`, `/agent`, `/auto`, `/edit` when `rest` was non-empty
	 * — the caller sends this as a normal message after acting on the mode/provider change.
	 */
	readonly sendRest?: string;
	/**
	 * True if `text` was recognized but refused because {@link runSlash}'s `remote` argument was
	 * set — the command's *effect* is not in this instance itself (no `slashInline`,
	 * `createSkill`, `mcpAdd`, `mcpReconnect` or `openMcpSettings` call happened). The caller
	 * should tell the requesting sink so, not fall through to `sendRest`/the "unrecognized —
	 * forward as a normal message" path — see {@link runSlash}'s own doc on why this exists.
	 */
	readonly denied?: boolean;
}

/**
 * The skill catalog + active-id shape `postSkills()` sends over the wire (`{type: 'skills',
 * skills, active}`) — {@link SlashEffects.listSkills} hands back exactly this data so `/skills`'
 * host-generated listing can never drift from what the `skills` message itself reports.
 */
export interface SlashSkillsSnapshot {
	readonly skills: readonly { id: string; name: string; description: string }[];
	readonly active: readonly string[];
}

/**
 * The host operations {@link runSlash} needs to actually act on a recognized command. Declared
 * here rather than importing `chatViewProvider.ts` directly so `src/session/` stays free of
 * `vscode` — the caller (`chatViewProvider.ts`) implements this by closing over one session id
 * and one origin sink, then wiring each method to the *same* private handler its own dispatcher
 * case already uses (`setMode` → `SessionStore.setSessionConfig`, `clearSession` →
 * `SessionStore.clearSession`, `slashInline` → `runInline`, …) — one source of truth, not a
 * second copy of logic the dispatcher already has.
 */
export interface SlashEffects {
	/** Sets the session's mode — the same effect `case 'setMode':` has. */
	setMode(mode: ChatMode): void;
	/**
	 * Selects the Auto (role-routed) provider for the session — the same effect `/auto`'s
	 * webview-side handling had (`selectedProvider = AUTO_PROVIDER`), just recorded on the
	 * session the host owns instead of a webview global.
	 */
	setAutoProvider(): void;
	/** Clears the session (archiving it to History) — the same effect `case 'clearSession':` has. */
	clearSession(): void;
	/** Runs one of the five inline editor actions — the same effect `case 'slashInline':` has. */
	slashInline(command: string, text: string): void;
	/** Activates a skill by id (empty id deactivates all) — the same effect `case 'setSkill':` has. */
	setSkill(id: string): void;
	/** Scaffolds a new workspace skill — the same effect `case 'createSkill':` has. */
	createSkill(): void;
	/** Registers a new MCP server — the same effect `case 'mcpAdd':` has. */
	mcpAdd(): void;
	/** Retries every configured MCP server — the same effect `case 'mcpReconnect':` has. */
	mcpReconnect(): void;
	/** Opens the detached Settings window, scrolled to the MCP section — bare `/mcp`'s effect. */
	openMcpSettings(): void;
	/** Renders help/skills-list text back to whichever sink asked, via `bus.postTo`. */
	reply(text: string): void;
	/** The current skill catalog + active ids, for `/skills`' listing. */
	listSkills(): SlashSkillsSnapshot;
}

/**
 * The static help text `/help` replies with, ported verbatim from `showHelp()` at
 * `media/main.js` — now host-generated so every client sees the identical text instead of
 * each one rendering its own copy.
 */
export const SLASH_HELP_TEXT = [
	'**Slash commands**',
	'`/ask` `/plan` `/agent` — switch mode (optionally with a message)',
	'`/auto` — use Auto (role-routed plan → implement → review)',
	'`/explain` `/fix` `/doc` `/optimize` `/tests` — act on the current editor selection',
	'`/enhance` — rewrite your draft into a sharper prompt',
	'`/skills` — list skills   ·   `/skill <id>` — activate (stackable; `/skill off` clears all, `/skill new` creates)',
	'`/mcp` — MCP server status   ·   `/mcp add` — register a server   ·   `/mcp reconnect`',
	'`/history` — reopen a previous conversation (also the 🕘 button; closed tabs are saved there)',
	'`/clear` — clear this chat tab (saved to History)   ·   `/help` — show this help',
	'',
	'**While a run is streaming**: keep typing! In Agent mode, Enter **steers** the live run; otherwise your message is **queued** and sent when the run finishes. The **+** tab button opens parallel chats.',
].join('\n');

/** Renders `/skills`' listing, ported verbatim from `showSkills()` at `media/main.js`. */
export function buildSkillsText(snapshot: SlashSkillsSnapshot): string {
	const lines = ['**Skills** — activate with `/skill <id>`; several can be active at once (`/skill off` clears all)'];
	for (const s of snapshot.skills) {
		const mark = snapshot.active.includes(s.id) ? ' ✓ active' : '';
		lines.push(`\`${s.id}\` — ${s.name}${s.description ? ': ' + s.description : ''}${mark}`);
	}
	return lines.join('\n');
}

/**
 * Host-side port of `handleSlash` at `media/main.js`. Dispatches a recognized command through
 * `effects` and reports what the caller should do next.
 *
 * `/history` and `/enhance` are deliberately **not** recognized here — both stay client-side
 * per the "remote control" plan's "Slash commands" section: `/history` opens a UI panel that
 * has no host-side meaning (each client — the webview's panel, or whatever a future PWA has —
 * renders its own from the `history` push it already receives), and `/enhance` already routes
 * its *result* through the host (`enhancePrompt` → `handleEnhancePrompt`, origin-routed back to
 * the sender) without needing its *dispatch* to move — the composer text it fills is a
 * client-owned UI concern, not session state. A client-side `handleSlash` is expected to
 * intercept both before ever posting a `slash` message, exactly as it does today; if one
 * reaches here anyway (a client that does not special-case them), `runSlash` reports
 * `handled: false` and the caller's own "unknown — treat as a normal message" fallback applies,
 * same as it would for a typo like `/foo`.
 *
 * `remote` (default `false`, i.e. the trusted desktop webview) is the same local/remote
 * distinction `chatViewProvider.ts`'s `guardrailsForRun` applies to a run's approval floor,
 * threaded down here for the same reason: `slash`, unlike every other webview→host message
 * type, is *one* `REMOTE_ALLOWED` type whose dispatch fans out into several different effects —
 * `isRemoteAllowed` only ever sees `'slash'` itself, never which command it carries, so nothing
 * upstream of this function re-checks a specific command against `src/remote/policy.ts`'s
 * `REMOTE_DENIED`. Three of those effects are exactly the things that list exists to keep a
 * remote client away from, reachable anyway before this parameter existed:
 *  - `slashInline` (the five `SLASH_INLINE` commands) reads whatever is in the *desktop's own*
 *    active editor selection right now — code the remote user cannot see and did not choose —
 *    and for `fix`/`doc`/`optimize`/`edit` arms `inlineEditActive` to apply the model's reply
 *    directly to that file. This is precisely what `applyEdit`/`insertAtCursor` being
 *    `REMOTE_DENIED` was for; `slash` routing around it made that denial a no-op.
 *  - `createSkill` (`/skill new`/`/skill create`) scaffolds a new workspace file.
 *  - `mcpAdd`/`mcpReconnect`/`openMcpSettings` (any `/mcp` form) reach local MCP server
 *    configuration — `mcpAdd` in particular can register a server whose command the extension
 *    will later spawn as a local process.
 * When `remote` is true, each of those three branches below reports `{ handled: true, denied:
 * true }` and calls no effect at all, instead of its ordinary behavior — deny-by-default for the
 * *reachable-through-`slash`* surface, matching how `REMOTE_DENIED` already treats each of these
 * as a standalone message type.
 */
export function runSlash(text: string, effects: SlashEffects, remote = false): SlashResult {
	const parsed = parseSlash(text);
	if (!parsed) {
		return { handled: false };
	}
	const { cmd, rest } = parsed;

	if (cmd === 'help') {
		effects.reply(SLASH_HELP_TEXT);
		return { handled: true };
	}
	if (cmd === 'clear') {
		effects.clearSession();
		return { handled: true };
	}
	if (cmd === 'ask' || cmd === 'plan' || cmd === 'agent' || cmd === 'edit') {
		// '/edit' is a legacy alias for the mode that Plan replaced.
		effects.setMode(cmd === 'edit' ? 'plan' : cmd);
		return rest ? { handled: true, sendRest: rest } : { handled: true };
	}
	if (cmd === 'auto') {
		effects.setAutoProvider();
		effects.setMode('agent');
		return rest ? { handled: true, sendRest: rest } : { handled: true };
	}
	if (SLASH_INLINE.includes(cmd)) {
		if (remote) {
			return { handled: true, denied: true };
		}
		effects.slashInline(cmd, rest);
		return { handled: true };
	}
	if (cmd === 'skills') {
		effects.reply(buildSkillsText(effects.listSkills()));
		return { handled: true };
	}
	if (cmd === 'skill') {
		const id = rest.toLowerCase();
		if (id === 'new' || id === 'create') {
			if (remote) {
				return { handled: true, denied: true };
			}
			effects.createSkill();
			return { handled: true };
		}
		effects.setSkill(id === 'off' || id === 'none' ? '' : id);
		return { handled: true };
	}
	if (cmd === 'mcp') {
		if (remote) {
			return { handled: true, denied: true };
		}
		if (rest === 'add') {
			effects.mcpAdd();
			return { handled: true };
		}
		if (rest === 'reconnect') {
			effects.mcpReconnect();
			return { handled: true };
		}
		effects.openMcpSettings();
		return { handled: true };
	}
	return { handled: false }; // unknown (or /history, /enhance) — caller treats as a normal message
}
