/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for the CodeWhisperer response-shape extractor and credential parser
// in src/providers/kiro.ts. Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-kiro-extract.mjs
import assert from 'node:assert/strict';

const m = await import(new URL('../out/providers/kiro.js', import.meta.url));

// Shape 1: plain JSON with a top-level text field.
assert.equal(m.extractCodeWhispererText({ completion: 'hello' }), 'hello');
assert.equal(m.extractCodeWhispererText({ content: 'hi there' }), 'hi there');
assert.equal(m.extractCodeWhispererText({ text: 'plain text field' }), 'plain text field');

// Shape 2: an events list, each with assistantResponseEvent.content.
assert.equal(
	m.extractCodeWhispererText({
		events: [
			{ assistantResponseEvent: { content: 'part one ' } },
			{ assistantResponseEvent: { content: 'part two' } },
		],
	}),
	'part one part two',
);
assert.equal(
	m.extractCodeWhispererText({ completionEvents: [{ assistantResponseEvent: { content: 'x' } }] }),
	'x',
);

// Shape 3: a raw string blob with embedded {"content":"..."} fragments (the AWS
// event-stream framing case) — regex fallback scrapes them out and unescapes each one.
assert.equal(
	m.extractCodeWhispererText('garbage-prefix{"content":"He said \\"hi\\""}garbage-suffix{"content":" bye"}'),
	'He said "hi" bye',
);

// Empty/unrecognized shapes return '' rather than throwing.
assert.equal(m.extractCodeWhispererText({}), '');
assert.equal(m.extractCodeWhispererText(null), '');
assert.equal(m.extractCodeWhispererText(42), '');
assert.equal(m.extractCodeWhispererText(''), '');

// parseKiroCredential accepts a well-formed import and rejects a malformed one with a
// message that tells the user what to do (re-run the import), not a bare parse error.
{
	const cred = m.parseKiroCredential(JSON.stringify({ accessToken: 'tok', refreshToken: 'ref', expiresAt: 123, region: 'us-west-2' }));
	assert.deepStrictEqual(cred, { accessToken: 'tok', refreshToken: 'ref', expiresAt: 123, region: 'us-west-2' });
}
{
	const cred = m.parseKiroCredential(JSON.stringify({ accessToken: 'tok' }));
	assert.deepStrictEqual(cred, { accessToken: 'tok', refreshToken: undefined, expiresAt: 0, region: undefined });
}
assert.throws(() => m.parseKiroCredential('not json'), /Import Kiro Credential/);
assert.throws(() => m.parseKiroCredential(JSON.stringify({ noAccessToken: true })), /Import Kiro Credential/);

console.log('All kiro-extract assertions passed.');
