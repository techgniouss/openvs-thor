/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The text around the cursor that a completion request is built from. */
export interface CompletionWindow {
	/** Text before the cursor, already truncated to the configured budget and LF-normalized. */
	readonly prefix: string;
	/** Text after the cursor, same treatment. */
	readonly suffix: string;
	/** The document's language id, e.g. `typescript`. */
	readonly languageId: string;
	/** Workspace-relative path, or the basename when the file is outside every folder. */
	readonly relativePath: string;
	/** The file's leading import/using/include block, when it was cut out of `prefix`. */
	readonly imports: string;
	/** The document's end-of-line sequence, re-applied to the completion before insertion. */
	readonly eol: '\n' | '\r\n';
}

/** Why a completion attempt produced nothing, for the status bar and the log. */
export type CompletionOutcome =
	| 'shown'
	| 'empty'
	| 'cancelled'
	| 'excluded'
	| 'disabled'
	| 'no-model'
	| 'paused-quota'
	| 'paused-slow'
	| 'timeout'
	| 'error';
