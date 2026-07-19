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
const vscodeStub = {
	workspace: {
		workspaceFolders: [],
		getConfiguration: () => ({ get: () => undefined }),
		isTrusted: true,
		fs: {},
	},
	window: { showInformationMessage: () => { }, showErrorMessage: () => { } },
	Uri: { file: p => ({ fsPath: p }) },
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

const approver = { confirm: async () => true };
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
	assert.match(nudge, /keep working/i, 'the nudge tells the model to keep going');
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

console.log('test-agent-loop: all assertions passed');
