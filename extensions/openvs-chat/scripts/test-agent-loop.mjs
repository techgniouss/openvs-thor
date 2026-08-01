/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the AgentRunner loop in src/agent/agentRunner.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-agent-loop.mjs
//
// Covers the termination paths that used to end a run silently mid-task.
import assert from 'node:assert/strict';
import Module from 'node:module';

// The runner reaches guardrails, which imports the `vscode` host API. Outside the
// extension host that module doesn't exist, so serve a minimal stand-in: every setting
// is unset, which is exactly the "defaults" path the guardrails already handle.
// `workspaceFiles` backs the verification-command probe: the gate only fires when the
// workspace actually offers something to run, so tests choose whether it can.
// `a.ts` is a real file here on purpose: the repeat-read guard only remembers reads that
// SUCCEEDED, so a fixture whose reads all fail would exercise none of it.
let workspaceFiles = {
	'package.json': JSON.stringify({ scripts: { test: 'node t' } }),
	'a.ts': 'export const a = 1;\n',
};
const vscodeStub = {
	workspace: {
		workspaceFolders: [{ uri: { fsPath: '/repo' } }],
		getConfiguration: () => ({ get: () => undefined }),
		isTrusted: true,
		fs: {
			async readFile(u) {
				const text = workspaceFiles[u.name];
				if (text === undefined) { throw new Error('ENOENT'); }
				return new TextEncoder().encode(text);
			},
			async stat(u) {
				if (workspaceFiles[u.name] === undefined) { throw new Error('ENOENT'); }
				return { type: 1 };
			},
			// Writable on purpose: several tests turn on whether a write actually SUCCEEDED
			// (it clears the read cache and the loop guard), and a stub that always failed
			// would let those assertions pass for the wrong reason.
			async writeFile(u, data) {
				workspaceFiles[u.name] = new TextDecoder().decode(data);
			},
		},
	},
	window: { showInformationMessage: () => { }, showErrorMessage: () => { } },
	// `fsPath` matters as much as `name`: the guardrails confine a resolved path by
	// comparing it against the workspace root, so a joined Uri without one makes every
	// file tool fail before it reaches the stub filesystem at all.
	Uri: {
		file: p => ({ fsPath: p, name: p }),
		joinPath: (base, ...parts) => ({ fsPath: [base?.fsPath ?? '', ...parts].join('/'), name: parts.join('/') }),
	},
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};

const { AgentRunner } = await import(new URL('../out/agent/agentRunner.js', import.meta.url));

/** A provider that replays a scripted list of agent steps and records what it was sent. */
function fakeProvider(steps) {
	const seen = [];
	return {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		seen,
		async listModels() { return []; },
		async runAgentStep(request) {
			seen.push(request.messages.map(m => `${m.role}:${m.content}`));
			return steps.shift() ?? { content: 'fallback', toolCalls: [] };
		},
	};
}

const approver = { confirm: async () => ({ approved: true }), ask: async () => '' };
const params = { model: 'm', apiKey: 'k', baseUrl: 'u', maxTokens: 100, signal: new AbortController().signal };
const noopCallbacks = () => {
	const notes = [];
	return {
		notes,
		onStepStart: () => { },
		onToken: () => { },
		onStepEnd: () => { },
		onToolStart: () => { },
		onToolEnd: () => { },
		onNote: t => notes.push(t),
	};
};

// 1. Prose with no tool call is nudged once, and a second quiet step ends the run as done.
{
	const provider = fakeProvider([
		{ content: 'Now I will update the config.', toolCalls: [] },
		{ content: 'All done.', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.deepStrictEqual(result, { reason: 'done' }, 'quiet step after a nudge is done');
	assert.strictEqual(provider.seen.length, 2, 'the model was asked a second time');
	const nudge = provider.seen[1].at(-1);
	assert.match(nudge, /^user:/, 'the nudge is injected as a user turn');
	assert.match(nudge, /do it now with your tools/i, 'the nudge tells the model to keep going');
}

// 1b. Read-only runs (Ask/Plan, research sub-agents) end on the first quiet step — a
// prose answer IS the completion there, so no wasted confirm round.
{
	const provider = fakeProvider([{ content: 'Here is the answer.', toolCalls: [] }]);
	const runner = new AgentRunner(provider, approver, 10, { readOnly: true });
	const result = await runner.run([{ role: 'user', content: 'q' }], params, noopCallbacks());
	assert.deepStrictEqual(result, { reason: 'done' });
	assert.strictEqual(provider.seen.length, 1, 'read-only is not nudged');
}

// 2. The nudge is not repeated forever: exactly one per quiet stretch.
{
	const provider = fakeProvider([
		{ content: 'thinking out loud', toolCalls: [] },
		{ content: 'still just talking', toolCalls: [] },
		{ content: 'and again', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(provider.seen.length, 2, 'no nudge loop — the run ends after one retry');
}

// 3. A truncated step is resumed, and the continuation does NOT consume the step budget.
{
	const steps = [];
	for (let i = 0; i < 6; i++) { steps.push({ content: `part ${i}`, toolCalls: [], truncated: true }); }
	steps.push({ content: 'finished', toolCalls: [] }, { content: 'yes really', toolCalls: [] });
	const provider = fakeProvider(steps);
	// maxSteps of 2 would have been exhausted long before step 8 if continuations cost budget.
	const runner = new AgentRunner(provider, approver, 2);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done', 'continuations do not burn the step budget');
	assert.strictEqual(provider.seen.length, 8);
}

// 4. A step truncated with EMPTY content is still resumed (it used to end the run silently).
{
	const provider = fakeProvider([
		{ content: '', toolCalls: [], truncated: true },
		{ content: 'recovered', toolCalls: [] },
		{ content: 'done now', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(provider.seen.length, 3, 'empty truncated step resumed rather than treated as done');
}

// 5. Endless truncation gives up with an explanation instead of looping forever.
{
	const provider = fakeProvider(Array.from({ length: 40 }, () => ({ content: 'x', toolCalls: [], truncated: true })));
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'truncated');
	assert.match(result.detail, /maxTokens/, 'tells the user which setting to raise');
}

// 5b. A tool call the model wrote as text and the token limit cut in half is recovered
// from the rejoined halves — neither half parses alone, which used to burn every
// continuation round and end the run with nothing done.
{
	const provider = fakeProvider([
		{ content: 'On it.\n<tool_call>{"name": "list_files", "argum', toolCalls: [], truncated: true },
		{ content: 'ents": {"path": "."}}</tool_call>', toolCalls: [], truncated: false },
		{ content: 'Listed them.', toolCalls: [] },
		{ content: 'yes really', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10);
	const calls = [];
	const cb = noopCallbacks();
	cb.onToolStart = c => calls.push(c.name);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, cb);
	assert.strictEqual(result.reason, 'done');
	assert.deepStrictEqual(calls, ['list_files'], 'the split tool call ran once');
	// The conversation keeps ONE assistant turn for the rejoined answer, not a fragment
	// per round plus the continuation prompts that carried them.
	const sent = provider.seen.at(-1);
	assert.deepStrictEqual(
		sent.filter(m => m.startsWith('assistant:')),
		['assistant:On it.', 'assistant:Listed them.'],
		'the halves were merged into one assistant turn with the recovered call stripped',
	);
	assert.ok(!sent.some(m => m.includes('cut off mid-response')), 'the provisional continuation prompt is gone');
}

// 5c. Once continuations stop paying off, the resume prompt tells the model to change
// tactics instead of repeating "continue" until the cap kills the run.
{
	const provider = fakeProvider(Array.from({ length: 40 }, () => ({ content: 'x', toolCalls: [], truncated: true })));
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'truncated');
	assert.match(provider.seen.at(-1).at(-1), /make ONE tool call now/, 'the later rounds push the model to use tools');
}

// 6. Exhausting the step budget reports `limit` with a recovery hint.
{
	const provider = fakeProvider(Array.from({ length: 20 }, (_, i) => ({
		content: '',
		toolCalls: [{ id: `c${i}`, name: 'list_files', args: { path: '.' } }],
	})));
	const runner = new AgentRunner(provider, approver, 3);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'limit');
	assert.match(result.detail, /3-step limit/);
	assert.match(result.detail, /continue/i, 'tells the user how to resume');
}

// 7. A provider-side content block is reported, never mistaken for a finished answer.
{
	const provider = fakeProvider([{ content: 'partial', toolCalls: [], finishReason: 'filtered' }]);
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'filtered');
	assert.match(result.detail, /content filter/i);
}

// 8. A refusal is likewise surfaced.
{
	const provider = fakeProvider([{ content: '', toolCalls: [], finishReason: 'refused' }]);
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'refused');
}

// 9. A run whose provider cannot do tools fails loudly before any step.
{
	const provider = fakeProvider([]);
	delete provider.runAgentStep;
	const runner = new AgentRunner(provider, approver, 10);
	await assert.rejects(
		() => runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks()),
		/does not support Agent mode/,
	);
}

// 10. An abort propagates as AbortError rather than resolving as a normal stop.
{
	const ac = new AbortController();
	ac.abort();
	const provider = fakeProvider([{ content: 'x', toolCalls: [] }]);
	const runner = new AgentRunner(provider, approver, 10);
	await assert.rejects(
		() => runner.run([{ role: 'user', content: 'go' }], { ...params, signal: ac.signal }, noopCallbacks()),
		err => err.name === 'AbortError',
	);
}

// 11. Auto-compaction: when the conversation passes 70% of contextWindow, the runner
// summarizes old turns via streamChat before the next step.
{
	const big = 'x'.repeat(60_000); // ~15k estimated tokens per message
	let streamChatCalls = 0;
	const stepsSeen = [];
	// Built on the file's fakeProvider shape, plus a streamChat the compactor can call.
	const provider = {
		...fakeProvider([]),
		async streamChat(request) {
			streamChatCalls++;
			request.onToken('SUMMARY OF OLD TURNS');
			return { truncated: false };
		},
		async runAgentStep(request) {
			stepsSeen.push(request.messages);
			return { content: 'done', toolCalls: [], truncated: false };
		},
	};
	// contextWindow 50_000 → trigger at 35k estimated tokens; the big seed turns cross it.
	const runner = new AgentRunner(provider, approver, 10, {
		readOnly: true,
		contextWindow: 50_000,
		maxContextTokens: 1_000_000, // keep trimming out of the way so compaction is what's tested
	});
	const cb = noopCallbacks();
	// The middle must hold at least MIN_COMPACTABLE (4) turns between the first user
	// message and the 6 protected recent ones, or compaction correctly declines to run.
	const seed = [
		{ role: 'system', content: 'SYS' },
		{ role: 'user', content: 'GOAL' },
		{ role: 'assistant', content: big },
		{ role: 'assistant', content: big },
		{ role: 'assistant', content: big },
		{ role: 'assistant', content: big },
		{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
		{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
		{ role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
	];
	const result = await runner.run(seed, params, cb);
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(streamChatCalls, 1, 'summarizer ran exactly once');
	assert.ok(cb.notes.some(n => n.includes('Compacted')), 'user was told about the compaction');
	// The first model step already saw the compacted conversation: summary marker present, big turns gone.
	const firstStep = stepsSeen[0];
	assert.ok(firstStep.some(msg => msg.content.includes('SUMMARY OF OLD TURNS')));
	assert.ok(!firstStep.some(msg => msg.content.length >= 60_000));
}


// 12. Compaction that fails to get under the threshold is not retried every few steps:
// when the protected head alone exceeds it, summarizing again costs a request and
// shrinks nothing, so the run falls through to trimming instead.
{
	const big = 'x'.repeat(60_000);
	let streamChatCalls = 0;
	let steps = 0;
	const provider = {
		...fakeProvider([]),
		async streamChat(request) {
			streamChatCalls++;
			request.onToken('SUMMARY');
			return { truncated: false };
		},
		async runAgentStep() {
			steps++;
			// Keep requesting tools so the loop keeps going and re-evaluates compaction.
			return steps < 8
				? { content: '', toolCalls: [{ id: 'c' + steps, name: 'list_dir', args: { path: 'dir' + steps } }], truncated: false }
				: { content: 'done', toolCalls: [], truncated: false };
		},
	};
	// Window 30k => threshold 21k, but keepHead protects two 15k-token seed messages, so
	// the head alone (~30k) can never fit — exactly the condition that used to
	// re-summarize forever.
	const runner = new AgentRunner(provider, approver, 20, {
		readOnly: true,
		contextWindow: 30_000,
		maxContextTokens: 1_000_000,
		keepHead: 3,
	});
	const cb = noopCallbacks();
	const seed = [
		{ role: 'system', content: 'SYS' },
		{ role: 'user', content: big },
		{ role: 'user', content: big },
		...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: 'work ' + i })),
		...Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: 'recent ' + i })),
	];
	const result = await runner.run(seed, params, cb);
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(streamChatCalls, 1, 'compaction is attempted once, not once per step');
	assert.ok(cb.notes.some(n => n.includes('still near the context limit')), 'the user is told trimming takes over');
}

// 13. Crossing the threshold BEFORE there is enough middle to summarize is transient, not
// a failure: the run must still compact once the middle has grown. Treating that early
// "nothing to compact yet" as terminal used to disable compaction for the whole run.
{
	let streamChatCalls = 0;
	let steps = 0;
	const provider = {
		...fakeProvider([]),
		async streamChat(request) {
			streamChatCalls++;
			request.onToken('SUMMARY');
			return { truncated: false };
		},
		async runAgentStep() {
			steps++;
			return steps < 12
				? { content: 'x'.repeat(40_000), toolCalls: [{ id: 'c' + steps, name: 'list_dir', args: { path: 'dir' + steps } }], truncated: false }
				: { content: 'done', toolCalls: [], truncated: false };
		},
	};
	// The seed is small, so the protected head can never be the problem. Bulk arrives from
	// the run itself: the threshold (21k) is crossed around step 3, but keepHead 4 means
	// nothing is compactable until the array reaches 14 messages (~step 5).
	const seed = [
		{ role: 'system', content: 'SYS' },
		{ role: 'user', content: 'CONTEXT' },
		{ role: 'assistant', content: 'plan' },
		{ role: 'user', content: 'implement' },
	];
	const runner = new AgentRunner(provider, approver, 20, {
		readOnly: true,
		contextWindow: 30_000,
		maxContextTokens: 1_000_000,
		keepHead: seed.length,
	});
	const cb = noopCallbacks();
	const result = await runner.run(seed, params, cb);
	assert.strictEqual(result.reason, 'done');
	assert.ok(streamChatCalls >= 1, 'compaction still happens once the run accumulates a middle');
	assert.ok(!cb.notes.some(n => n.includes('still near the context limit')),
		'a small head is never reported as exhausted');
}

// 14. A step with neither text nor a tool call is a lost turn, not an answer. The run
// must ask again instead of ending — this is the "chat goes blank and stops mid-task"
// bug: the webview drops the empty bubble and `done` explains nothing, so the work
// simply vanishes from the user's view.
{
	const provider = fakeProvider([
		{ content: '', toolCalls: [] },
		{ content: '', toolCalls: [{ id: 'c1', name: 'list_files', args: { path: '.' } }] },
		{ content: 'Fixed it.', toolCalls: [] },
		{ content: 'Yes, really done.', toolCalls: [] },
	]);
	const cb = noopCallbacks();
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, cb);
	assert.deepStrictEqual(result, { reason: 'done' }, 'the run recovered and finished');
	assert.strictEqual(provider.seen.length, 4, 'the empty reply was retried, not treated as done');
	assert.match(provider.seen[1].at(-1), /^user:.*empty/i, 'the retry is injected as a user turn');
	assert.ok(cb.notes.some(n => /empty reply/i.test(n)), 'the user is told about the empty reply');
	// The empty turn itself is never recorded: several backends reject an assistant
	// message with no content and no tool calls.
	assert.ok(!provider.seen[1].some(m => m === 'assistant:'), 'no empty assistant turn is sent back');
}

// 14b. Read-only runs (Ask/Plan) get the same treatment. They end on the first *prose*
// step, but an EMPTY step there used to end the run instantly with nothing shown at all.
{
	const provider = fakeProvider([
		{ content: '', toolCalls: [] },
		{ content: 'Here is what I found.', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10, { readOnly: true });
	const result = await runner.run([{ role: 'user', content: 'q' }], params, noopCallbacks());
	assert.deepStrictEqual(result, { reason: 'done' });
	assert.strictEqual(provider.seen.length, 2, 'read-only retries an empty reply too');
}

// 14c. Empty replies are retried a bounded number of times, and giving up is reported —
// never as `done`, which the UI renders as silence.
{
	const provider = fakeProvider(Array.from({ length: 20 }, () => ({ content: '  \n ', toolCalls: [] })));
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'stalled', 'whitespace-only replies count as empty');
	assert.match(result.detail, /empty replies/i, 'the user is told why the run stopped');
	assert.strictEqual(provider.seen.length, 4, 'bounded retries: MAX_EMPTY_ROUNDS + the first try');
}

// 14d. An empty reply that recovers does not shorten the run: retries must not consume
// the step budget, since no work was done.
{
	const steps = [];
	for (let i = 0; i < 3; i++) {
		steps.push({ content: '', toolCalls: [] });
		steps.push({ content: '', toolCalls: [{ id: `c${i}`, name: 'list_files', args: { path: '.' } }] });
	}
	steps.push({ content: 'done', toolCalls: [] }, { content: 'confirmed', toolCalls: [] });
	const provider = fakeProvider(steps);
	// A budget of 5 covers the three tool steps plus the closing nudge and nothing more;
	// if the three empty retries also cost a step the run would hit `limit` instead.
	const runner = new AgentRunner(provider, approver, 5);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done', 'empty retries do not burn the step budget');
	assert.strictEqual(provider.seen.length, 8);
}

// 15. A tool that returns nothing must never be recorded as an empty `tool` message:
// Anthropic rejects an empty tool_result block with HTTP 400, killing the whole run over
// something as ordinary as a zero-byte file or an MCP tool with no output. Driven through
// the MCP path, which is the one tool route the runner resolves through an injectable.
{
	const provider = fakeProvider([
		{ content: '', toolCalls: [{ id: 'c1', name: 'mcp__srv__quiet', args: {} }] },
		{ content: 'ok', toolCalls: [] },
		{ content: 'really done', toolCalls: [] },
	]);
	const mcp = {
		tools: () => [{ name: 'mcp__srv__quiet', description: 'returns nothing', parameters: { type: 'object', properties: {} } }],
		call: async () => ({ result: '', isError: false }),
		isReadOnly: () => true,
	};
	const runner = new AgentRunner(provider, approver, 10, { mcp });
	await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	const toolTurn = provider.seen[1].find(m => m.startsWith('tool:'));
	assert.ok(toolTurn, 'the tool result was recorded');
	assert.ok(toolTurn.slice('tool:'.length).trim().length > 0,
		'an empty tool result is replaced with a description, never sent as empty content');
	assert.match(toolTurn, /mcp__srv__quiet/, 'the placeholder names the tool that stayed quiet');
}

// 16. Sub-agents inherit the parent's context window, or a research sub-agent that reads
// a dozen files runs with compaction disabled until the provider rejects the request.
// Observable through the note the parent forwards when the child compacts.
{
	const big = 'x'.repeat(60_000); // ~15k estimated tokens
	let childSteps = 0;
	const provider = {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async streamChat(request) { request.onToken('SUMMARY'); return { truncated: false }; },
		async runAgentStep(request) {
			const isChild = request.messages.some(m => m.content.includes('RESEARCH THIS'));
			if (isChild) {
				childSteps++;
				// Pile on bulk so the child crosses its own compaction threshold, then finish.
				return childSteps < 6
					? { content: big, toolCalls: [{ id: 'k' + childSteps, name: 'list_dir', args: { path: 'dir' + childSteps } }] }
					: { content: 'child answer', toolCalls: [] };
			}
			return request.messages.some(m => m.role === 'tool')
				? { content: 'parent done', toolCalls: [] }
				: { content: '', toolCalls: [{ id: 's1', name: 'spawn_subagent', args: { goal: 'RESEARCH THIS', readOnly: true } }] };
		},
	};
	const runner = new AgentRunner(provider, approver, 20, {
		contextWindow: 60_000,
		maxContextTokens: 1_000_000, // keep trimming out of the way so compaction is what's tested
	});
	const cb = noopCallbacks();
	const result = await runner.run([{ role: 'user', content: 'go' }], params, cb);
	assert.strictEqual(result.reason, 'done');
	assert.ok(cb.notes.some(n => /^Sub-agent: Compacted/.test(n)),
		'the child compacted, so it inherited the parent contextWindow');
}

// 17. A run must not declare victory with its own checklist half-done. The nudge quotes
// the outstanding items back — both to push the model on and to restore a list that
// compaction may have summarized away.
{
	const todos = [
		{ content: 'Fix the parser', status: 'completed' },
		{ content: 'Update the tests', status: 'pending' },
	];
	const provider = fakeProvider([
		{ content: '', toolCalls: [{ id: 't1', name: 'update_todos', args: { items: todos } }] },
		{ content: 'All finished!', toolCalls: [] },
		{ content: 'Really, finished.', toolCalls: [] },
		{ content: 'Nothing more to do.', toolCalls: [] },
	]);
	const cb = noopCallbacks();
	let reported;
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params,
		{ ...cb, onTodos: items => { reported = items; } });
	assert.strictEqual(result.reason, 'done');
	assert.deepStrictEqual(reported, todos, 'the checklist reached the UI');
	// Step 2 and 3 are both nudged about the open item; the fourth quiet step ends it.
	assert.strictEqual(provider.seen.length, 4, 'the open item is chased twice, then the run ends');
	const nudge = provider.seen[2].at(-1);
	assert.match(nudge, /Update the tests/, 'the nudge quotes the outstanding item');
	// The tool result echoes the list, so it survives in the transcript as the model's plan.
	const toolTurn = provider.seen[1].find(m => m.startsWith('tool:'));
	assert.match(toolTurn, /Update the tests/, 'update_todos echoes the checklist back');
	assert.match(toolTurn, /1\/2 complete/, 'and reports progress');
}

// 17b. A fully-completed checklist does not trigger the checklist nudge.
{
	const provider = fakeProvider([
		{ content: '', toolCalls: [{ id: 't1', name: 'update_todos', args: { items: [{ content: 'Ship it', status: 'completed' }] } }] },
		{ content: 'Done.', toolCalls: [] },
		{ content: 'Confirmed.', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(provider.seen.length, 3, 'only the single generic nudge fires');
	assert.doesNotMatch(provider.seen[2].at(-1), /checklist still has open items/);
}

// 18. An MCP tool the server did NOT declare read-only can have changed the workspace, so
// stopping afterwards without running anything must be challenged — otherwise a run that
// did all its work through an MCP filesystem server sails past the gate untouched.
{
	const mcp = {
		tools: () => [{ name: 'mcp__fs__write', description: 'w', parameters: { type: 'object', properties: {} } }],
		call: async () => ({ result: 'ok', isError: false }),
		isReadOnly: () => false,
	};
	const provider = fakeProvider([
		{ content: '', toolCalls: [{ id: 'w1', name: 'mcp__fs__write', args: {} }] },
		{ content: 'Changed the file.', toolCalls: [] },
		{ content: 'Still nothing to add.', toolCalls: [] },
		{ content: 'Done.', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10, { mcp });
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(provider.seen.length, 4, 'the unannotated MCP write armed the gate');
	assert.match(provider.seen[2].at(-1), /npm run test/, 'the nudge names a command this workspace really has');
}

// 18b. A tool the server declared read-only does not arm it: research through MCP is not
// a change, and nagging about it would teach the model to invent an excuse.
{
	const mcp = {
		tools: () => [{ name: 'mcp__db__query', description: 'r', parameters: { type: 'object', properties: {} } }],
		call: async () => ({ result: 'rows', isError: false }),
		isReadOnly: () => true,
	};
	const provider = fakeProvider([
		{ content: '', toolCalls: [{ id: 'r1', name: 'mcp__db__query', args: {} }] },
		{ content: 'Here is what I found.', toolCalls: [] },
		{ content: 'Nothing further.', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, approver, 10, { mcp });
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(provider.seen.length, 3, 'only the single generic nudge fires');
}

// 18c. In a workspace with nothing to run, the gate stays silent. Demanding verification
// that is impossible is nagging, and the model answers it with a plausible excuse.
{
	const previous = workspaceFiles;
	workspaceFiles = {};
	try {
		const mcp = {
			tools: () => [{ name: 'mcp__fs__write', description: 'w', parameters: { type: 'object', properties: {} } }],
			call: async () => ({ result: 'ok', isError: false }),
			isReadOnly: () => false,
		};
		const provider = fakeProvider([
			{ content: '', toolCalls: [{ id: 'w1', name: 'mcp__fs__write', args: {} }] },
			{ content: 'Changed it.', toolCalls: [] },
			{ content: 'Done.', toolCalls: [] },
		]);
		const runner = new AgentRunner(provider, approver, 10, { mcp });
		const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
		assert.strictEqual(result.reason, 'done');
		assert.strictEqual(provider.seen.length, 3, 'no verify nudge when there is no command to run');
	} finally {
		workspaceFiles = previous;
	}
}

// 19. ask_user blocks the loop on the user's answer and feeds it back as the tool result.
{
	const asked = [];
	const answering = {
		confirm: async () => ({ approved: true }),
		ask: async q => { asked.push(q); return 'Rewrite it'; },
	};
	const provider = fakeProvider([
		{
			content: '', toolCalls: [{
				id: 'q1', name: 'ask_user', args: {
					question: 'Patch the existing parser or rewrite it?',
					options: [{ label: 'Patch it', description: 'Smaller diff' }, { label: 'Rewrite it' }],
				},
			}],
		},
		{ content: 'Rewriting then.', toolCalls: [] },
		{ content: 'Done.', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, answering, 10);
	const result = await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(result.reason, 'done');
	assert.strictEqual(asked.length, 1, 'the question reached the UI channel');
	assert.deepStrictEqual(asked[0].options, [{ label: 'Patch it', description: 'Smaller diff' }, { label: 'Rewrite it' }]);
	const toolTurn = provider.seen[1].find(m => m.startsWith('tool:'));
	assert.match(toolTurn, /Rewrite it/, 'the answer comes back as the tool result');
}

// 19b. A question with fewer than two options is rejected as a tool error rather than
// putting a pointless card in front of the user.
{
	let asks = 0;
	const counting = { confirm: async () => ({ approved: true }), ask: async () => { asks++; return 'x'; } };
	const provider = fakeProvider([
		{ content: '', toolCalls: [{ id: 'q1', name: 'ask_user', args: { question: 'Shall I continue?', options: [{ label: 'Yes' }] } }] },
		{ content: 'Carrying on.', toolCalls: [] },
		{ content: 'Done.', toolCalls: [] },
	]);
	const runner = new AgentRunner(provider, counting, 10);
	await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.strictEqual(asks, 0, 'the user was never bothered');
	assert.match(provider.seen[1].find(m => m.startsWith('tool:')), /at least 2/);
}

// 19c. Sub-agents never get ask_user — nobody is watching them answer.
{
	let offered;
	const provider = {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async runAgentStep(request) {
			const isChild = request.messages.some(m => m.content.includes('GO LOOK'));
			if (isChild) {
				offered = request.tools.map(t => t.name);
				return { content: 'child answer', toolCalls: [] };
			}
			return request.messages.some(m => m.role === 'tool')
				? { content: 'parent done', toolCalls: [] }
				: { content: '', toolCalls: [{ id: 's1', name: 'spawn_subagent', args: { goal: 'GO LOOK', readOnly: true } }] };
		},
	};
	const runner = new AgentRunner(provider, approver, 20);
	await runner.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.ok(offered, 'the sub-agent ran');
	assert.ok(!offered.includes('ask_user'), 'sub-agents cannot ask the user questions');
}

// 19d. The top-level read-only loop (Ask/Plan) DOES get it: the user is right there.
{
	let offered;
	const provider = {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async runAgentStep(request) { offered = request.tools.map(t => t.name); return { content: 'answer', toolCalls: [] }; },
	};
	const runner = new AgentRunner(provider, approver, 10, { readOnly: true });
	await runner.run([{ role: 'user', content: 'q' }], params, noopCallbacks());
	assert.ok(offered.includes('ask_user'), 'Ask/Plan can ask a clarifying question');
	assert.ok(!offered.includes('write_file'), 'but still cannot write');
}

// 20. Repeating an identical read is answered from the transcript, not from disk — the
// classic way a run stalls is a model re-reading the same file every step. A write in
// between expires that, because the file it already read has just changed.
{
	const script = [
		{ content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }] },
		{ content: '', toolCalls: [{ id: 't2', name: 'read_file', args: { path: 'a.ts' } }] },
		{ content: '', toolCalls: [{ id: 't3', name: 'write_file', args: { path: 'a.ts', content: 'x' } }] },
		{ content: '', toolCalls: [{ id: 't4', name: 'read_file', args: { path: 'a.ts' } }] },
		{ content: 'done', toolCalls: [] },
	];
	const results = [];
	const cb = { ...noopCallbacks(), onToolEnd: (call, result) => results.push([call.name, result]) };
	const runner = new AgentRunner(fakeProvider(script), approver, 20);
	await runner.run([{ role: 'user', content: 'go' }], params, cb);
	const repeated = results.map(([, result]) => /already ran read_file\(path="a\.ts"\)/.test(result));
	assert.deepStrictEqual(repeated, [false, true, false, false],
		'only the immediate repeat is short-circuited; the read after the write runs again');
}

// 20b. …but a change from outside the run expires it too. The agent reads from disk, so a
// file the user saves mid-run really has changed; answering the re-read with "nothing has
// changed since" refuses the model the one call that would show it the edit.
{
	const script = [
		{ content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }] },
		{ content: '', toolCalls: [{ id: 't2', name: 'read_file', args: { path: 'a.ts' } }] },
		{ content: 'done', toolCalls: [] },
	];
	const results = [];
	const runner = new AgentRunner(fakeProvider(script), approver, 20);
	const cb = {
		...noopCallbacks(),
		onToolEnd: (call, result) => {
			results.push(result);
			// Stands in for the user saving the file between the two reads.
			runner.invalidateReads();
		},
	};
	await runner.run([{ role: 'user', content: 'go' }], params, cb);
	assert.deepStrictEqual(results.map(r => /already ran read_file/.test(r)), [false, false],
		'the second read runs against disk rather than being refused');
}

// 20c. The guard keys on the file, not on how the model spelled it. `a.ts`, `./a.ts` and
// `/repo/a.ts` are one file but three different strings, so keying on the raw argument let a
// model re-read the same file forever just by varying the spelling — walking straight around
// the one guard that exists to stop it.
{
	const script = [
		{ content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }] },
		{ content: '', toolCalls: [{ id: 't2', name: 'read_file', args: { path: './a.ts' } }] },
		{ content: '', toolCalls: [{ id: 't3', name: 'read_file', args: { path: '/repo/a.ts' } }] },
		{ content: 'done', toolCalls: [] },
	];
	const results = [];
	const cb = { ...noopCallbacks(), onToolEnd: (_call, result) => results.push(result) };
	await new AgentRunner(fakeProvider(script), approver, 20)
		.run([{ role: 'user', content: 'go' }], params, cb);
	assert.deepStrictEqual(results.map(r => /already ran read_file/.test(r)), [false, true, true],
		'every respelling of the same file is recognized as the repeat it is');
}

// 20d. A read that FAILED is not remembered as answered. Caching it told the model it had
// "already read" a file it had never seen, and refused the retry that would have worked
// once the cause cleared — the guard against loops turned into a guarantee of one.
{
	const script = [
		{ content: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'missing.ts' } }] },
		{ content: '', toolCalls: [{ id: 't2', name: 'read_file', args: { path: 'missing.ts' } }] },
		{ content: 'done', toolCalls: [] },
	];
	const results = [];
	const cb = { ...noopCallbacks(), onToolEnd: (_call, result) => results.push(result) };
	await new AgentRunner(fakeProvider(script), approver, 20)
		.run([{ role: 'user', content: 'go' }], params, cb);
	assert.deepStrictEqual(results.map(r => /already ran read_file/.test(r)), [false, false],
		'a failed read is retried rather than answered with a false "you already read it"');
}

// 21. A call that fails identically over and over is stopped rather than run forever. The
// step budget used to drain into a model re-sending the same broken edit; the loop now
// refuses the repeat and tells it to change approach.
{
	const bad = () => ({ content: '', toolCalls: [{ id: `e${Math.random()}`, name: 'edit_file', args: { path: 'nope.ts', oldText: 'x', newText: 'y' } }] });
	const script = [bad(), bad(), bad(), bad(), bad(), { content: 'done', toolCalls: [] }];
	const results = [];
	const cb = { ...noopCallbacks(), onToolEnd: (_call, result) => results.push(result) };
	await new AgentRunner(fakeProvider(script), approver, 20)
		.run([{ role: 'user', content: 'go' }], params, cb);
	assert.deepStrictEqual(results.map(r => /failed 3 times in a row/.test(r)), [false, false, false, true, true],
		'the fourth identical failure is refused instead of executed');
}

// 21b. …but a success that CHANGED something clears the slate: the write may have created
// the very file the edit could not find, so the next attempt must be allowed to run.
{
	const failingEdit = id => ({ content: '', toolCalls: [{ id, name: 'edit_file', args: { path: 'nope.ts', oldText: 'x', newText: 'y' } }] });
	const script = [
		failingEdit('e1'), failingEdit('e2'), failingEdit('e3'),
		{ content: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'nope.ts', content: 'x' } }] },
		failingEdit('e4'),
		{ content: 'done', toolCalls: [] },
	];
	const results = [];
	const cb = { ...noopCallbacks(), onToolEnd: (call, result) => { if (call.name === 'edit_file') { results.push(result); } } };
	await new AgentRunner(fakeProvider(script), approver, 20)
		.run([{ role: 'user', content: 'go' }], params, cb);
	assert.deepStrictEqual(results.map(r => /failed 3 times in a row/.test(r)), [false, false, false, false],
		'a successful write in between resets the failure count');
}

// 21c. A successful READ does not reset the failure count. Reads change nothing, so they
// cannot have unblocked the failing call — and clearing on them let a model defeat the
// guard for free by alternating the broken edit with a read of some new path.
{
	const failingEdit = id => ({ content: '', toolCalls: [{ id, name: 'edit_file', args: { path: 'nope.ts', oldText: 'x', newText: 'y' } }] });
	const read = (id, path) => ({ content: '', toolCalls: [{ id, name: 'read_file', args: { path } }] });
	const script = [
		failingEdit('e1'), read('r1', 'a.ts'),
		failingEdit('e2'), read('r2', 'package.json'),
		failingEdit('e3'),
		failingEdit('e4'),
		{ content: 'done', toolCalls: [] },
	];
	const results = [];
	const cb = { ...noopCallbacks(), onToolEnd: (call, result) => { if (call.name === 'edit_file') { results.push(result); } } };
	await new AgentRunner(fakeProvider(script), approver, 20)
		.run([{ role: 'user', content: 'go' }], params, cb);
	assert.deepStrictEqual(results.map(r => /failed 3 times in a row/.test(r)), [false, false, false, true],
		'interleaved successful reads do not reset the loop guard');
}

// 21d. A refused repeat still costs a step, so a model that ignores the refusal drains the
// whole budget re-reading one file. The wording escalates after a few tries instead of
// repeating the same polite note forever.
{
	const read = id => ({ content: '', toolCalls: [{ id, name: 'read_file', args: { path: 'a.ts' } }] });
	const script = [read('r1'), read('r2'), read('r3'), read('r4'), { content: 'done', toolCalls: [] }];
	const results = [];
	const cb = { ...noopCallbacks(), onToolEnd: (_call, result) => results.push(result) };
	await new AgentRunner(fakeProvider(script), approver, 20)
		.run([{ role: 'user', content: 'go' }], params, cb);
	const classify = r => /Stop re-reading/.test(r) ? 'escalated' : /already ran/.test(r) ? 'refused' : 'ran';
	assert.deepStrictEqual(
		results.map(classify),
		['ran', 'refused', 'refused', 'escalated'],
		'the third refusal escalates rather than repeating the same note',
	);
}

// 22. A transient provider failure mid-run is retried rather than destroying the run. The
// conversation lives only inside run(), so throwing threw away every file read and command
// result the task had gathered.
{
	let calls = 0;
	const provider = {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async runAgentStep() {
			calls++;
			if (calls === 1) { throw new Error('Fake: the response stalled — no data for 120s.'); }
			return { content: 'recovered and done', toolCalls: [] };
		},
	};
	const cb = noopCallbacks();
	const result = await new AgentRunner(provider, approver, 20, { retryDelaysMs: [1] })
		.run([{ role: 'user', content: 'go' }], params, cb);
	// Three calls: the failure, the retry, and the one completion nudge a prose-only
	// answer always earns.
	assert.deepStrictEqual(
		[result.reason, calls, cb.notes.some(n => /retrying step \(1\/3\)/.test(n))],
		['done', 3, true],
		'the dropped stream is retried and the run completes',
	);
}

// 22b. A permanent failure is NOT retried, and ends the run with a reported reason instead
// of a thrown error — everything the run achieved stays on screen either way.
{
	let calls = 0;
	const provider = {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async runAgentStep() { calls++; throw new Error('Fake: authentication failed (HTTP 401). Check that your API key is valid.'); },
	};
	const result = await new AgentRunner(provider, approver, 20, { retryDelaysMs: [1] })
		.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.deepStrictEqual(
		[result.reason, calls, /authentication failed/.test(result.detail ?? '')],
		['error', 1, true],
		'a bad key fails immediately with an explanation rather than being retried',
	);
}

// 22c. A transient failure that never clears gives up after the retry budget, still as a
// reported outcome rather than an exception.
{
	let calls = 0;
	const provider = {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async runAgentStep() { calls++; throw new Error('Fake: request failed (HTTP 503).'); },
	};
	const result = await new AgentRunner(provider, approver, 20, { retryDelaysMs: [1] })
		.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	assert.deepStrictEqual([result.reason, calls], ['error', 4],
		'three retries then a clean stop, not an infinite loop');
}

// 23. Steering typed while a truncated answer is being continued survives. The continuation
// block is spliced out of the tail by index, so a steering turn appended after it used to be
// deleted in its place — the user's correction silently dropped and the half-written answer
// left stranded in the history.
{
	let steer = ['actually, use TypeScript'];
	const script = [
		{ content: 'first half', toolCalls: [], truncated: true, finishReason: 'length' },
		{ content: 'second half', toolCalls: [] },
		{ content: 'done', toolCalls: [] },
	];
	const provider = fakeProvider(script);
	await new AgentRunner(provider, approver, 20, { steering: () => { const s = steer; steer = []; return s; } })
		.run([{ role: 'user', content: 'go' }], params, noopCallbacks());
	const last = provider.seen.at(-1);
	assert.ok(last.some(m => m.includes('actually, use TypeScript')),
		'the steering message is still in the conversation after the continuation resolves');
	assert.ok(!last.some(m => m === 'assistant:first half'),
		'and the provisional half-answer was replaced by the rejoined whole, not left behind');
}

// 24. What counts as "verified". The completion gate clears only on a command that
// plausibly checks the code — clearing on any successful command made it bypassable by
// `ls`, which is precisely the "reported success without checking" failure it exists for.
{
	const { isVerificationCommand } = await import(new URL('../out/agent/tools.js', import.meta.url));
	const verifies = [
		'npm run build', 'npm test', 'pnpm run typecheck', 'yarn lint', 'npx tsc --noEmit',
		'cargo test', 'go build ./...', 'python -m pytest -q', 'dotnet build', 'make',
		'cd sub && npm run compile', 'mvn -q compile', './gradlew test',
		'npm run test:unit', 'npm run build --if-present', 'make -j8',
		'node_modules/.bin/jest', 'CI=1 npm test', 'npm run lint; npm test',
	];
	const doesNot = [
		'ls -la', 'git status', 'echo done', 'cat package.json', 'pwd', 'git add -A',
		'npm install', 'mkdir out', 'node -v',
		// Substring matching used to accept all of these. `make` and `ava` are ordinary
		// English, so a commit message cleared the gate and the run reported success over
		// code nothing had checked — the exact failure the gate exists to prevent.
		'git commit -m "make it work"',
		'git commit -m "add tests for the build"',
		'npm i ava',
		'echo "run npm test later"',
		'node scripts/make-report.js',
		'grep -r "cargo test" .',
		'python deploy.py',
		'cargo run',
		'go run main.go',
	];
	assert.deepStrictEqual(
		[verifies.filter(c => !isVerificationCommand(c)), doesNot.filter(c => isVerificationCommand(c))],
		[[], []],
		'build/test/lint commands verify; inspection and setup commands do not',
	);
}

// --- MCP tool-name namespacing (src/mcp/manager.ts) -----------------------------------
// Lives here rather than in its own file because the repo's allowlist for JavaScript test
// files is closed (see .eslint-allowed-javascript-files). Tool names go on the wire with
// EVERY request, so an illegal one does not break its own tool — it makes every agent step
// in the run fail with a 400 naming a tool the user never called.
const { safeToolName, isWireLegalToolName } = await import(new URL('../out/mcp/manager.js', import.meta.url));

// 25. No server id or tool name, however hostile, can produce an illegal name. The id is a
// user-written config key and the tool name comes from a third-party server.
{
	const pairs = [
		['my server', 'do thing'],
		['github.com/acme/tools', 'search:repos'],
		['ok', 'a'.repeat(200)],
		['cloudflare-observability', 'search_cloudflare_documentation'],
		['ünïcodé', 'tool!@#$%'],
		['...', '...'],
		['normal', 'plain_tool'],
	];
	assert.deepStrictEqual(
		pairs.map(([id, tool]) => safeToolName(id, tool, new Set())).filter(n => !isWireLegalToolName(n)),
		[],
		'every namespaced MCP tool name is accepted by the provider APIs',
	);
}

// 25b. A name that is already legal and short stays recognizable — the model reads these,
// so mangling a perfectly good name would cost tool-selection accuracy for nothing.
{
	assert.equal(safeToolName('files', 'read_file', new Set()), 'mcp__files__read_file');
}

// 25c. Truncation must not collide. Two long tool names sharing a 64-char prefix would
// otherwise produce one name twice, and the second would silently overwrite the first's
// route — handing the model a tool that calls something else entirely.
{
	const taken = new Set();
	const first = safeToolName('server-with-a-long-identifier', 'a'.repeat(80), taken);
	taken.add(first);
	const second = safeToolName('server-with-a-long-identifier', 'a'.repeat(81), taken);
	assert.deepStrictEqual(
		[first !== second, isWireLegalToolName(first), isWireLegalToolName(second)],
		[true, true, true],
		'colliding truncations are disambiguated and both stay legal',
	);
}

// --- Auto plan→implement→review pipeline (src/auto/orchestrator.ts) --------------------
// Also folded in here for the allowlist reason above. The subject is what the REVIEWER is
// told: a reviewer that cannot see the change it is reviewing does not report a smaller
// problem than a missing reviewer — it reports the work correct, which is worse.
const { AutoOrchestrator } = await import(new URL('../out/auto/orchestrator.js', import.meta.url));

const autoRouter = {
	isReviewEnabled: () => true,
	isDecompose: () => false,
	async resolveRoleCandidates(role) {
		return [{
			role, roleLabel: role, providerId: 'fake', providerLabel: 'Fake',
			model: 'fake-model', source: 'inferred', ready: true,
		}];
	},
};

/**
 * Drives one Auto run and returns the prompt the reviewer was actually sent. `agentSteps`
 * are replayed to the implementer; the plan and review phases stream a fixed string.
 */
async function runAuto(agentSteps, { maxSteps = 20 } = {}) {
	let reviewPrompt = '';
	let streamPhase = 0; // 0 = plan, 1 = review (the implementer uses runAgentStep)
	const provider = {
		info: { id: 'fake', label: 'Fake', supportsTools: true, toolModelPatterns: [], visionModelPatterns: [] },
		async listModels() { return []; },
		async streamChat(request) {
			if (streamPhase === 1) { reviewPrompt = request.messages.at(-1).content; }
			streamPhase++;
			request.onToken('1. do the thing');
			return { truncated: false, finishReason: 'stop' };
		},
		async runAgentStep() { return agentSteps.shift() ?? { content: 'implemented', toolCalls: [] }; },
	};
	const registry = {
		getMaxTokens: () => 1000,
		getProvider: () => provider,
		async getApiKey() { return 'k'; },
		getBaseUrl: () => 'u',
	};
	const noop = () => { };
	await new AutoOrchestrator(registry, autoRouter, approver, maxSteps).run(
		{ history: [{ role: 'user', content: 'do it' }], baseSystemPrompt: 'base', signal: new AbortController().signal },
		{
			phase: noop, token: noop, agentStepStart: noop, agentStepEnd: noop,
			onToolStart: noop, onToolEnd: noop, note: noop,
		},
	);
	return reviewPrompt;
}

// 26. An edit sent in the batch form reaches the reviewer. `edits: [...]` is the shape most
// models reach for, and reading `args.oldText` off that call yielded an edit of one empty
// string into another — a diff with nothing in it, which no reviewer can fault.
{
	const prompt = await runAuto([
		{
			content: '', toolCalls: [{
				id: 'e1', name: 'edit_file', args: {
					path: 'a.ts',
					edits: [
						{ oldText: 'const a = 1', newText: 'const a = 2' },
						{ oldText: 'const b = 3', newText: 'const b = 4' },
					],
				},
			}],
		},
		{ content: 'implemented', toolCalls: [] },
		{ content: 'implemented', toolCalls: [] },
	]);
	assert.deepStrictEqual(
		['const a = 1', 'const a = 2', 'const b = 3', 'const b = 4', '2 edits'].map(s => prompt.includes(s)),
		[true, true, true, true, true],
		'every edit in the batch is shown to the reviewer',
	);
}

// 26b. Another product's argument vocabulary reaches it too. The executor normalizes
// `old_string`/`file_path`; the change record did not, so a model using Anthropic's
// text-editor names had its work recorded as blank.
{
	const prompt = await runAuto([
		{
			content: '', toolCalls: [{
				id: 'e1', name: 'edit_file',
				args: { file_path: 'b.ts', old_string: 'before text', new_string: 'after text' },
			}],
		},
		{ content: 'implemented', toolCalls: [] },
		{ content: 'implemented', toolCalls: [] },
	]);
	assert.deepStrictEqual(
		['b.ts', 'before text', 'after text'].map(s => prompt.includes(s)),
		[true, true, true],
		'aliased edit arguments are normalized before being recorded',
	);
}

// 26c. An implementation that stopped short is declared to the reviewer. Reviewing a
// partial change against the whole plan and signing it off is the pipeline-level version
// of reporting success without checking.
{
	const busy = id => ({ content: '', toolCalls: [{ id, name: 'read_file', args: { path: `f${id}.ts` } }] });
	const prompt = await runAuto([busy('1'), busy('2'), busy('3')], { maxSteps: 2 });
	assert.deepStrictEqual(
		[/did NOT run to completion/.test(prompt), /step limit/.test(prompt), /do not report the work complete/.test(prompt)],
		[true, true, true],
		'the reviewer is told the implementation is partial',
	);
}

// 26d. …and a run that finished cleanly carries no such warning, or every review would
// open by hedging about work that is in fact complete.
{
	const prompt = await runAuto([{ content: 'all done', toolCalls: [] }, { content: 'all done', toolCalls: [] }]);
	assert.ok(!/did NOT run to completion/.test(prompt), 'a completed implementation is not flagged as partial');
}

console.log('test-agent-loop: all assertions passed');
