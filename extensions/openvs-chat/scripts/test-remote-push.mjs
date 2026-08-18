/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the push-trigger rule in src/remote/push.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-remote-push.mjs
//
// src/remote/push.ts is vscode-free and pure, so — like test-remote-coalescer.mjs — this imports
// the compiled module directly, no Module._load stub needed. `nowMs`/`lastPushAtMs` are plain
// numbers the caller controls, so there is no fake clock to build here (unlike the coalescer,
// which owns its own timers).
import assert from 'node:assert/strict';
import { shouldPush } from '../out/remote/push.js';

// 1. Always-push event types: approvalRequest/askRequest/error push on a session's first event
// (no prior push recorded, i.e. lastPushAtMs is undefined).
{
	assert.equal(shouldPush('approvalRequest', undefined, 1_000), true, 'approvalRequest always pushes');
	assert.equal(shouldPush('askRequest', undefined, 1_000), true, 'askRequest always pushes');
	assert.equal(shouldPush('error', undefined, 1_000), true, 'error always pushes');
}

// 2. Never-push event types: token/toolStart/info never push, regardless of timing or an
// unrecognized type either — deny-by-default, same shape as the relay's own switch.
{
	assert.equal(shouldPush('token', undefined, 1_000), false, 'token never pushes');
	assert.equal(shouldPush('toolStart', undefined, 1_000), false, 'toolStart never pushes');
	assert.equal(shouldPush('info', undefined, 1_000), false, 'info never pushes');
	assert.equal(shouldPush('somethingElse', undefined, 1_000), false, 'an unrecognized event type never pushes');
}

// 3. done's 60s run-duration threshold: pushes only when the run that just closed ran longer
// than 60s, not at exactly 60s, and not for a run with no known duration at all.
{
	assert.equal(shouldPush('done', undefined, 1_000, 60_000), false, 'a 60s-exactly run does not push (threshold is exclusive)');
	assert.equal(shouldPush('done', undefined, 1_000, 60_001), true, 'a run just over 60s pushes');
	assert.equal(shouldPush('done', undefined, 1_000, 5_000), false, 'a short run does not push');
	assert.equal(shouldPush('done', undefined, 1_000), false, 'a done with no known run duration does not push');
}

// 4. Rate limiting: 1 push per 10s per session, keyed off the caller-supplied lastPushAtMs — not
// eligible at all before 10s have elapsed, eligible again once they have.
{
	assert.equal(shouldPush('error', 0, 9_999), false, 'just under the 10s window since the last push does not push again');
	assert.equal(shouldPush('error', 0, 10_000), true, 'exactly 10s since the last push pushes again (inclusive)');
	assert.equal(shouldPush('error', 0, 15_000), true, 'well past the 10s window pushes again');
	// The rate limit only gates event types that were otherwise eligible — a never-push type
	// stays denied even once the window has elapsed, it never had a reason to push in the first
	// place.
	assert.equal(shouldPush('token', 0, 20_000), false, 'the rate limit does not make an ineligible event type eligible');
}

console.log('test-remote-push: all assertions passed');
