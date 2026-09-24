/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/agent/checkpoint.ts, what `/undo` restores a run's files with.
// Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-checkpoint.mjs
import assert from 'node:assert/strict';
import Module from 'node:module';

// The module only needs `vscode` for its default filesystem; every test passes its own.
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? { workspace: {} } : load.call(this, request, ...rest);
};
const { RunCheckpoint, describeRestore } = await import(new URL('../out/agent/checkpoint.js', import.meta.url));

/** An in-memory filesystem with the three calls a restore makes; `trashed` records deletes. */
function memoryFs(initial) {
	const files = new Map(Object.entries(initial));
	const trashed = [];
	return {
		files, trashed,
		async readFile(uri) {
			if (!files.has(uri.path)) { throw new Error('ENOENT'); }
			return new TextEncoder().encode(files.get(uri.path));
		},
		async writeFile(uri, bytes) { files.set(uri.path, new TextDecoder().decode(bytes)); },
		async delete(uri, options) { trashed.push({ path: uri.path, useTrash: options?.useTrash }); files.delete(uri.path); },
	};
}
const uri = path => ({ path, toString: () => `file://${path}` });

{
	const cp = new RunCheckpoint();
	assert.strictEqual(cp.isEmpty, true);
	// a.ts edited twice (the first "before" must win), b.ts created, c.ts edited then changed
	// again by the user after the run, d.ts edited.
	cp.record({ uri: uri('a.ts'), path: 'a.ts', before: 'A0', after: 'A1' });
	cp.record({ uri: uri('a.ts'), path: 'a.ts', before: 'A1', after: 'A2' });
	cp.record({ uri: uri('b.ts'), path: 'b.ts', before: undefined, after: 'B1' });
	cp.record({ uri: uri('c.ts'), path: 'c.ts', before: 'C0', after: 'C1' });
	cp.record({ uri: uri('d.ts'), path: 'd.ts', before: 'D0', after: 'D1' });
	assert.deepStrictEqual(cp.describe(), ['a.ts', 'b.ts (new)', 'c.ts', 'd.ts']);

	const fs = memoryFs({ 'a.ts': 'A2', 'b.ts': 'B1', 'c.ts': 'C1 plus the user\'s own edit', 'd.ts': 'D1' });
	fs.writeFile = (orig => async (u, b) => { if (u.path === 'd.ts') { throw new Error('read-only'); } return orig(u, b); })(fs.writeFile);
	const report = await cp.restore(fs);
	assert.deepStrictEqual(report, {
		restored: ['a.ts'],
		removed: ['b.ts'],
		skipped: ['c.ts'],
		failed: ['d.ts (read-only)'],
	});
	assert.deepStrictEqual([...fs.files.entries()], [['a.ts', 'A0'], ['c.ts', 'C1 plus the user\'s own edit'], ['d.ts', 'D1']],
		'restored to the pre-run text; the user\'s later edit is kept');
	assert.deepStrictEqual(fs.trashed, [{ path: 'b.ts', useTrash: true }], 'created files go to the trash, not oblivion');
	assert.strictEqual(describeRestore(report),
		'Undo: restored a.ts; moved the new file(s) b.ts to the trash; left c.ts alone because they changed after the run; could not restore d.ts (read-only).');
}

// A file deleted since the run is "changed since" too — recreating it would undo the user.
{
	const cp = new RunCheckpoint();
	cp.record({ uri: uri('gone.ts'), path: 'gone.ts', before: 'G0', after: 'G1' });
	const report = await cp.restore(memoryFs({}));
	assert.deepStrictEqual(report.skipped, ['gone.ts']);
	assert.strictEqual(describeRestore({ restored: [], removed: [], skipped: [], failed: [] }), 'Undo: nothing to restore.');
}

console.log('test-checkpoint: all assertions passed');
