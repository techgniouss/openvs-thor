/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

// Only the product build runs this (build/lib/extensions.ts picks it up and rewrites `main`
// to dist/). Without it the build copied the extension as-is, and a clean checkout has no
// `out/` — installers shipped TypeScript sources with nothing to activate. Development
// (`npm run watch`, F5, the test suite) still compiles to `out/` via gulpfile.extensions.ts.

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	platform: 'node',
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		// sql.js locates its .wasm with `require.resolve` next to its own files, which only
		// works from the real package; build/lib/extensions.ts ships it in node_modules.
		external: ['vscode', 'sql.js'],
	},
}, process.argv);
