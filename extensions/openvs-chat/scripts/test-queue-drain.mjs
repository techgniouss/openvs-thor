/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/session/queueDrain.ts, plus the two client halves. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-queue-drain.mjs
//
// The desktop panel and every paired phone drain one shared queue on the same `done`. With a
// phone paired, a queued follow-up was sent twice: the second send aborted the run the first
// had just started and appended the turn again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { QueueDrainGate } from '../out/session/queueDrain.js';

// One drain per finished run; ordinary sends always go through and close the window.
{
	const gate = new QueueDrainGate();
	const trace = [];
	trace.push(gate.admit('s', true));   // no run has finished yet: nothing to drain
	gate.runFinished('s');
	trace.push(gate.admit('s', true));   // the panel drains
	trace.push(gate.admit('s', true));   // the phone drains the same item: refused
	gate.runFinished('s');
	trace.push(gate.admit('s', false));  // the user types instead of the queue draining
	trace.push(gate.admit('s', true));   // a drain racing that send is refused too
	gate.runFinished('other');
	trace.push(gate.admit('s', true));   // another tab's run says nothing about this one
	assert.deepStrictEqual(trace, [false, true, false, true, false, false]);
}

// Both clients mark their drain, and the host consults the gate before touching the session.
{
	const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
	const panel = read('../media/main.js');
	const phone = read('../../../openvs-relay/pwa/app.js');
	const host = read('../src/chatViewProvider.ts');
	assert.deepStrictEqual([
		/sendText\(next, [^\n]*fromQueue: true/.test(panel),
		/fromQueue: !!\(opts && opts\.fromQueue\)/.test(panel),
		/dispatchSend\(s, next, s\.runMode, true\)/.test(phone),
		/fromQueue \? \{ fromQueue: true \}/.test(phone),
		/if \(!this\.queueDrains\.admit\(sessionId, message\.fromQueue === true\)\)/.test(host),
		host.indexOf('this.queueDrains.admit(') < host.indexOf("post({ type: 'runStart'"),
	], [true, true, true, true, true, true]);
}

// The panel's queue is host-owned: every edit must reach the host, or the next `sessions` push
// (opening or switching a tab mid-run) replaces it with the host's copy and the follow-up the
// user typed is silently lost. That is what happened once `saveState` stopped carrying it.
{
	const lines = fs.readFileSync(new URL('../media/main.js', import.meta.url), 'utf8').split(/\r?\n/);
	const edits = lines.flatMap((line, i) => /\bs\.queue\.(push|splice|shift|unshift|pop)\(/.test(line) ? [i] : []);
	const unsynced = edits.filter(i => !lines.slice(i, i + 4).some(l => /persistQueue\(s\)/.test(l)));
	assert.deepStrictEqual([edits.length > 0, unsynced.map(i => `main.js:${i + 1}`)], [true, []]);
}

console.log('test-queue-drain: all assertions passed');
