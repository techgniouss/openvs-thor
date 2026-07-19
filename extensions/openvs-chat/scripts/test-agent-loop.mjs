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

console.log('test-agent-loop: all assertions passed');
