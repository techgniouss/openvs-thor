/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Why a document or position is not eligible for a completion request. */
export type ExclusionReason =
	| 'secret-file'
	| 'secret-line'
	| 'scheme'
	| 'user-glob'
	| 'language'
	| 'untrusted';

/** Status-bar tooltip wording for each {@link ExclusionReason}. */
const EXCLUSION_DETAIL: Record<ExclusionReason, string> = {
	'secret-file': 'this file looks like a credential store',
	'secret-line': 'the current line looks like it contains a credential',
	'scheme': 'this editor is not a saved file',
	'user-glob': 'excluded by openvsChat.completions.excludeFiles',
	'language': 'disabled for this language in Settings',
	'untrusted': 'this workspace is not trusted',
};

/**
 * Human-readable detail for {@link ExclusionReason}, for the status bar tooltip.
 *
 * `isExcluded`'s reason used to be computed and then discarded by its only production
 * caller, which checked it as a plain boolean — the status bar's own doc comment names an
 * example tooltip ("this file is excluded because it looks like a credential store") that no
 * caller could actually produce. This is what lets that example be true.
 */
export function describeExclusion(reason: ExclusionReason): string {
	return EXCLUSION_DETAIL[reason];
}

/** The document and position facts the guard needs. */
export interface ExclusionTarget {
	/** Workspace-relative path, forward slashes. */
	readonly relativePath: string;
	readonly scheme: string;
	readonly languageId: string;
	/** The full text of the line the cursor is on. */
	readonly cursorLine: string;
}

/** User configuration the guard consults. */
export interface ExclusionSettings {
	readonly excludeFiles: string[];
	readonly trusted: boolean;
	readonly allowUntrusted: boolean;
	readonly disabledLanguages: string[];
}

/**
 * Document schemes a completion may be offered in. An allowlist rather than a denylist:
 * VS Code delivers the SCM commit box, the output panel, the debug REPL, diff sides and
 * search editors through the same provider API, and a new one can appear in any release.
 */
const ALLOWED_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell']);

/**
 * Paths that may hold credentials. Denied before any content is read, and not overridable
 * from settings — a user who wants completions inside their private key has made a mistake,
 * not a configuration choice.
 */
const SECRET_PATHS: RegExp[] = [
	/(^|\/)\.env($|\.)/i,
	/\.(pem|key|jks|p12|pfx|keystore)$/i,
	/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/(^|\/)\.(npmrc|pypirc|netrc|pgpass)$/i,
	/(^|\/)credentials(\.json)?$/i,
	/(^|\/)service-account.*\.json$/i,
];

/**
 * Credential shapes that must never leave the machine inside a completion window.
 *
 * Checked against the cursor line rather than the whole window on purpose: this is a
 * last-resort guard for a secret pasted into otherwise ordinary source, and scanning a 3 kB
 * window on every keystroke would cost more than it saves. The file-level rules above are
 * what catch a file that is *made* of secrets.
 */
const SECRET_LINE: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{10,}/,
	/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/**
 * Whether a completion may be requested here, and if not, why.
 *
 * Order matters. The secret rules run first and are not overridable, because every other
 * rule is a preference and this one is a leak. Trust is checked after them so that enabling
 * `completions.untrusted` never re-admits a credential file.
 */
export function isExcluded(target: ExclusionTarget, settings: ExclusionSettings): ExclusionReason | undefined {
	if (SECRET_PATHS.some(pattern => pattern.test(target.relativePath))) {
		return 'secret-file';
	}
	if (SECRET_LINE.some(pattern => pattern.test(target.cursorLine))) {
		return 'secret-line';
	}
	if (!ALLOWED_SCHEMES.has(target.scheme)) {
		return 'scheme';
	}
	if (!settings.trusted && !settings.allowUntrusted) {
		return 'untrusted';
	}
	if (settings.disabledLanguages.includes(target.languageId)) {
		return 'language';
	}
	if (settings.excludeFiles.some(glob => globToRegExp(glob).test(target.relativePath))) {
		return 'user-glob';
	}
	return undefined;
}

/**
 * Compiles a simple glob to a regex, one character at a time.
 *
 * A double star spans path separators, a single star does not, and `?` is one
 * non-separator character. A double star followed by a separator also matches zero
 * segments, so a pattern anchored two directories deep still matches a file one deep.
 * Written as a single pass rather than a chain of `.replace()` calls with placeholder sentinels: the
 * sentinel version is only correct while no pattern can contain a sentinel, which is the
 * kind of assumption that holds until it does not.
 *
 * Deliberately small — the editor's own matcher is not reachable from a pure module, and
 * these patterns are evaluated on the typing path.
 */
function globToRegExp(glob: string): RegExp {
	let body = '';
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === '*' && glob[i + 1] === '*') {
			if (glob[i + 2] === '/') {
				body += '(?:.*/)?';
				i += 2;
			} else {
				body += '.*';
				i += 1;
			}
			continue;
		}
		if (ch === '*') {
			body += '[^/]*';
			continue;
		}
		if (ch === '?') {
			body += '[^/]';
			continue;
		}
		body += ESCAPE_IN_GLOB.test(ch) ? `\\${ch}` : ch;
	}
	return new RegExp(`^${body}$`);
}

/** Regex metacharacters that must be escaped when they appear literally in a glob. */
const ESCAPE_IN_GLOB = /[.+^${}()|[\]\\]/;
