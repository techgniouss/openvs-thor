/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the host-side message-sink registry in src/session/bus.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-session-bus.mjs
//
// src/session/ imports nothing from `vscode`, so unlike test-tools.mjs this needs no
// Module._load stub: the compiled module is imported directly.
import assert from 'node:assert/strict';
import { SessionBus } from '../out/session/bus.js';

/** A sink that records every message it receives and every time it is disposed. */
function fakeSink(id, kind, wantsChat) {
	const received = [];
	let disposed = 0;
	return {
		id, kind, wantsChat,
		post: message => received.push(message),
		dispose: () => { disposed++; },
		received,
		disposedCount: () => disposed,
	};
}

// 1. A sink registered then posted-to receives the message.
{
	const bus = new SessionBus();
	const sink = fakeSink('a', 'webview', true);
	bus.addSink(sink);
	bus.post({ type: 'config' });
	assert.deepStrictEqual(sink.received, [{ type: 'config' }]);
}

// 2. `wantsChat: false` sinks don't receive chat-only types, but do receive everything else.
{
	const bus = new SessionBus();
	bus.setChatOnlyTypes(new Set(['token', 'approvalRequest']));
	const chatSink = fakeSink('webview', 'webview', true);
	const settingsSink = fakeSink('settings', 'settings', false);
	bus.addSink(chatSink);
	bus.addSink(settingsSink);

	bus.post({ type: 'token', delta: 'hi' });
	bus.post({ type: 'config' });

	assert.deepStrictEqual(chatSink.received, [{ type: 'token', delta: 'hi' }, { type: 'config' }],
		'the chat-capable sink sees everything');
	assert.deepStrictEqual(settingsSink.received, [{ type: 'config' }],
		'the settings sink is withheld the chat-only type but sees the rest');
}

// 3. `postTo` reaches only the named sink.
{
	const bus = new SessionBus();
	const a = fakeSink('a', 'webview', true);
	const b = fakeSink('b', 'settings', false);
	bus.addSink(a);
	bus.addSink(b);
	bus.postTo('a', { type: 'promptCancel', id: 'p1' });
	assert.deepStrictEqual(a.received, [{ type: 'promptCancel', id: 'p1' }]);
	assert.deepStrictEqual(b.received, []);
	// A departed sink id is not an error case — silently no-ops.
	assert.doesNotThrow(() => bus.postTo('nope', { type: 'config' }));
}

// 4. `removeSink` disposes the sink and stops delivery.
{
	const bus = new SessionBus();
	const sink = fakeSink('a', 'webview', true);
	bus.addSink(sink);
	bus.removeSink('a');
	assert.strictEqual(sink.disposedCount(), 1);
	bus.post({ type: 'config' });
	assert.deepStrictEqual(sink.received, [], 'removed sink receives nothing further');
	// Removing an id that isn't registered is a no-op, not an error.
	assert.doesNotThrow(() => bus.removeSink('nope'));
}

// 5. `hasChatSink` reflects the current registration.
{
	const bus = new SessionBus();
	assert.strictEqual(bus.hasChatSink(), false, 'nothing registered');
	bus.addSink(fakeSink('settings', 'settings', false));
	assert.strictEqual(bus.hasChatSink(), false, 'only a non-chat sink registered');
	bus.addSink(fakeSink('webview', 'webview', true));
	assert.strictEqual(bus.hasChatSink(), true, 'a chat-capable sink is registered');
	bus.removeSink('webview');
	assert.strictEqual(bus.hasChatSink(), false, 'the chat-capable sink left');
}

// 6. `sinksOfKind` filters by kind.
{
	const bus = new SessionBus();
	bus.addSink(fakeSink('webview', 'webview', true));
	bus.addSink(fakeSink('settings', 'settings', false));
	bus.addSink(fakeSink('loopback', 'remote', true));
	assert.deepStrictEqual(bus.sinksOfKind('remote').map(s => s.id), ['loopback']);
	assert.deepStrictEqual(bus.sinksOfKind('webview').map(s => s.id), ['webview']);
}

console.log('test-session-bus: all assertions passed');
