// Standalone unit test for src/persona/todos.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-persona-todos.mjs
import assert from 'node:assert/strict';

const { UPDATE_TODOS_TOOL, parseTodoUpdate } = await import(new URL('../out/persona/todos.js', import.meta.url));

assert.equal(UPDATE_TODOS_TOOL.name, 'update_todos');
assert.ok(UPDATE_TODOS_TOOL.description.length > 40, 'tool needs a real description');
assert.deepEqual(UPDATE_TODOS_TOOL.parameters.required, ['items']);

// Valid update.
const ok = parseTodoUpdate({ items: [
	{ content: 'Read the config', status: 'completed' },
	{ content: 'Patch the loader', status: 'in_progress' },
	{ content: 'Run typecheck', status: 'pending' },
] });
assert.ok('items' in ok);
assert.equal(ok.items.length, 3);
assert.equal(ok.items[1].status, 'in_progress');

// Empty list is valid (clears the panel).
assert.deepEqual(parseTodoUpdate({ items: [] }), { items: [] });

// Invalid shapes produce tool-level errors, never throw.
assert.ok('error' in parseTodoUpdate({}));
assert.ok('error' in parseTodoUpdate({ items: 'nope' }));
assert.ok('error' in parseTodoUpdate({ items: [{ content: '', status: 'pending' }] }));
assert.ok('error' in parseTodoUpdate({ items: [{ content: 'x', status: 'doing' }] }));
assert.ok('error' in parseTodoUpdate({ items: [{ status: 'pending' }] }));

// Content is trimmed and capped so the panel cannot be flooded.
const long = parseTodoUpdate({ items: [{ content: '  ' + 'x'.repeat(500) + '  ', status: 'pending' }] });
assert.ok('items' in long);
assert.ok(long.items[0].content.length <= 200);
assert.ok(!long.items[0].content.startsWith(' '));

console.log('test-persona-todos: all assertions passed');
