/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Unit test for src/persona/smallTalk.ts and the two places that act on it. Run:
//   node extensions/openvs-chat/scripts/test-small-talk.mjs
//
// The predicate decides whether a turn gets the read-only tool loop and whether Auto runs
// its three-model pipeline, so a false positive silently does none of the work asked for.
// The table below is mostly that side of the line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { smallTalkKind } = await import(new URL('../out/persona/smallTalk.js', import.meta.url));

const kinds = inputs => inputs.map(t => smallTalkKind(t));

// 1. Greetings, sign-offs and questions about the assistant. No task can hide in one, so
// these may also skip work — including Auto's pipeline.
assert.deepStrictEqual(
	kinds([
		'hi', 'Hi!', 'hii', 'heyyy', 'Hello there', 'yo', 'good morning', 'Good Morning!',
		'hey there 👋', 'who are you?', 'what can you do?', 'how are you doing?',
		'bye', 'thanks, bye!', 'hi again',
	]),
	Array(15).fill('greeting'));

// 2. Thanks and approvals read the same on the surface, but "ok" often means *go ahead
// with what you just proposed* — so they are classified apart, and never used to skip work.
assert.deepStrictEqual(
	kinds(['thanks', 'Thank you!', 'thanks a lot', 'ty', 'ok', 'okay', 'sounds good', 'perfect', 'got it', 'nvm']),
	Array(10).fill('acknowledgement'));

// 3. Anything with real content in it. Every word has to be accounted for, so a request
// fails on its first unknown word however short or polite it is.
assert.deepStrictEqual(
	kinds([
		'fix the login bug', 'hi, can you fix the login bug?', 'thanks — now add a test',
		'ok run the build', 'continue', 'go', 'why is this failing?', 'read main.ts',
		'good catch, fix it', 'hey', // control: this one IS small talk
	]).slice(0, 9),
	Array(9).fill(undefined));

// 4. Fragments and empties are not turns of their own: "please" alone is half a request.
assert.deepStrictEqual(kinds(['', '   ', '!!!', 'please', 'there', 'again']), Array(6).fill(undefined));

// 5. Both callers are wired to it. Neither can be tested through the extension host here
// (chatViewProvider needs a live webview), and both regressions are invisible at runtime:
// tools quietly come back for greetings, or Auto quietly plans them again.
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'src', 'chatViewProvider.ts'), 'utf8');
assert.match(source, /readTools\s*=[^;]*!smallTalk/s,
	'Ask/Plan withhold the read-only tool loop from small talk');
assert.match(source, /smallTalkKind\([^;]*===\s*'greeting'/,
	'Auto skips its pipeline for greetings only — never for an acknowledgement');
// The tab stamped the run as steerable when it sent it. A downgraded run has no agent
// loop to drain the steering queue, so anything typed into it would be dropped in silence.
// Steerability is declared, never inferred: both send paths say so at their head, and the
// map is keyed off that declaration alone. A run that declares nothing is not steerable,
// which is what stops the next kind of run someone adds from silently eating corrections.
assert.strictEqual((source.match(/this\.declareSteerable\(sessionId, runId, mode === 'agent', post\)/g) ?? []).length, 2,
	'both the direct and the Auto send declare whether their run can be steered');
const steerCase = /case 'steer':[\s\S]*?\n\t\t\tcase /.exec(source)?.[0] ?? '';
assert.match(steerCase, /steerableRuns\.get\(message\.sessionId\) !== \(message\.runId \?\? ''\)/,
	'a steer is checked against the run actually in flight, not against what the tab assumed');
assert.match(steerCase, /type: 'steerRejected'/,
	'…and one aimed at a run with no loop is handed back rather than queued for nobody');
assert.doesNotMatch(source, /steerQueues\.delete\(sessionId\);\s*\n\s*const runner = new AgentRunner/,
	'a starting loop keeps the steering typed into its own run');
// A run's queue dies with the run, so whatever it accepted and never read has to go back
// the same way a rejected steer does — otherwise the loss just moves to the end of the run.
assert.strictEqual((source.match(/if \(!controller\.signal\.aborted\) \{\s*\n\s*this\.bounceUndelivered\(sessionId, runId, post\);/g) ?? []).length, 2,
	'both send paths hand back steering their run never delivered — except after a Stop, '
	+ 'where returning it would start a fresh run out of the press that ended this one');
assert.match(source, /bounceUndelivered[\s\S]{0,700}?post\(\{ type: 'steerRejected', text: entry\.text \}\)/,
	'…through the same message the webview already knows how to undo');
// Vacuous-pass guard: test-webview derives host-sent types from `post({ type: … })` calls,
// so a message sent through any other shape is one nothing checks the webview handles.
assert.match(source, /\bpost\(\{ type: 'steerRejected'/,
	'steerRejected is sent in the shape the host↔webview contract test can see');
const webview = fs.readFileSync(path.join(here, '..', 'media', 'main.js'), 'utf8');
assert.match(webview, /case 'steerable':[\s\S]{0,600}?s\.steerable = !!msg\.steerable/,
	'and the webview records it');
assert.match(webview, /case 'steerRejected':[\s\S]{0,300}?undoSteer\(s, msg\.text\)/,
	'a bounced steer is taken back by the webview');
assert.match(webview, /function undoSteer[\s\S]{0,800}?s\.queue\.push\(text\)/,
	'…and lands in the queue, which the done handler already sends');
// Both readers have to honour it — the one that routes typed input, and the composer hint
// that tells the user which of the two will happen. Counted rather than matched against
// their surrounding syntax, so reformatting either site does not fail this.
assert.strictEqual(
	(webview.match(/s\.runMode === 'agent' && s\.steerable !== false/g) ?? []).length, 2,
	'input routing and the composer hint both gate on steerability');
assert.match(webview, /s\.steerable = true;/,
	'steerability is reset per run, so one downgraded turn does not disable steering for good');
// `runMode` must stay untouched by all this: the queue drain re-sends in that mode, so
// overwriting it would quietly run the user's next real task in the wrong mode.
assert.doesNotMatch(webview, /case 'steerable':[\s\S]{0,600}?s\.runMode\s*=/,
	'the steerable message must not rewrite the run mode');

console.log('test-small-talk: all assertions passed');
