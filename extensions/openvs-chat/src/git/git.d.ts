/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Vendored subset of extensions/git/src/api/git.d.ts (the built-in Git extension's public
// API). Not imported cross-extension: this extension's tsconfig has `rootDir: ./src`, so a
// relative import reaching into `extensions/git/src` would fail the compile-extensions build.
// Keep in sync by hand if the upstream Git extension's API surface used here changes.

import { Uri } from 'vscode';

export interface InputBox {
	value: string;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly inputBox: InputBox;
	/** `git diff` (working tree) when `cached` is falsy, `git diff --cached` (staged) when true. */
	diff(cached?: boolean): Promise<string>;
}

export interface API {
	readonly repositories: Repository[];
	getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
	readonly enabled: boolean;
	getAPI(version: 1): API;
}
