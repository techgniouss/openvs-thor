/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** One successful `write_file`/`edit_file`: the file, and its text either side of the write. */
export interface FileWrite {
	readonly uri: vscode.Uri;
	/** Workspace-relative path, as the tool reported it to the model. */
	readonly path: string;
	/** Text before the write; undefined when the write created the file. */
	readonly before: string | undefined;
	/** Text the write left behind. */
	readonly after: string;
}

/** What {@link RunCheckpoint.restore} did, per file. */
export interface RestoreReport {
	/** Put back to their text from before the run. */
	readonly restored: string[];
	/** Created by the run, now moved to the trash. */
	readonly removed: string[];
	/** Changed again after the run's last write to them, so left alone. */
	readonly skipped: string[];
	/** Could not be restored; each entry names the reason. */
	readonly failed: string[];
}

/** The slice of `vscode.workspace.fs` a restore uses. Injectable so it is testable without a host. */
export interface CheckpointFs {
	readFile(uri: vscode.Uri): Thenable<Uint8Array>;
	writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
	delete(uri: vscode.Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void>;
}

/**
 * The files one run changed with its file tools, and what each held before the run touched it —
 * the "undo this run" that Copilot's Keep/Undo and Claude Code's rewind give their users.
 *
 * Writes go straight to disk (`workspace.fs.writeFile`), so they never enter the editor's undo
 * stack, and under the default `yolo` approval policy nothing asks first. Without this, git was
 * the only way back from a run that went wrong.
 *
 * Only the file tools are tracked. What a `run_command` changed (a formatter, a code generator,
 * `git checkout`) is outside what can be captured honestly, and the notice says so.
 */
export class RunCheckpoint {
	private readonly files = new Map<string, { uri: vscode.Uri; path: string; before: string | undefined; after: string }>();

	/** Records a write. The first write to a file fixes its "before"; every later one moves its "after". */
	record(write: FileWrite): void {
		const key = write.uri.toString();
		const earlier = this.files.get(key);
		this.files.set(key, {
			uri: write.uri,
			path: write.path,
			before: earlier ? earlier.before : write.before,
			after: write.after,
		});
	}

	/** Whether the run changed any file through its file tools. */
	get isEmpty(): boolean {
		return this.files.size === 0;
	}

	/** Every changed file's path, with "(new)" on the ones the run created. */
	describe(): string[] {
		return [...this.files.values()].map(f => f.before === undefined ? `${f.path} (new)` : f.path);
	}

	/**
	 * Puts every file back as it was before the run.
	 *
	 * A file whose current text is no longer what the run last wrote was changed again since —
	 * by the user, or by a later run — and is left alone: restoring it would silently throw that
	 * work away, which is the one thing an undo must never do. Files the run created go to the
	 * trash rather than being deleted, so even this step is recoverable.
	 */
	async restore(fs: CheckpointFs = vscode.workspace.fs): Promise<RestoreReport> {
		const report = { restored: [] as string[], removed: [] as string[], skipped: [] as string[], failed: [] as string[] };
		for (const file of this.files.values()) {
			let current: string | undefined;
			try {
				current = new TextDecoder().decode(await fs.readFile(file.uri));
			} catch {
				current = undefined;
			}
			if (current !== file.after) {
				report.skipped.push(file.path);
				continue;
			}
			try {
				if (file.before === undefined) {
					await fs.delete(file.uri, { useTrash: true });
					report.removed.push(file.path);
				} else {
					await fs.writeFile(file.uri, new TextEncoder().encode(file.before));
					report.restored.push(file.path);
				}
			} catch (err) {
				report.failed.push(`${file.path} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return report;
	}
}

/** The one-line summary of a {@link RestoreReport} shown to the user. */
export function describeRestore(report: RestoreReport): string {
	const parts: string[] = [];
	if (report.restored.length) {
		parts.push(`restored ${report.restored.join(', ')}`);
	}
	if (report.removed.length) {
		parts.push(`moved the new file(s) ${report.removed.join(', ')} to the trash`);
	}
	if (report.skipped.length) {
		parts.push(`left ${report.skipped.join(', ')} alone because they changed after the run`);
	}
	if (report.failed.length) {
		parts.push(`could not restore ${report.failed.join(', ')}`);
	}
	return parts.length ? `Undo: ${parts.join('; ')}.` : 'Undo: nothing to restore.';
}
