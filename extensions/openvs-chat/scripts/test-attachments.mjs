/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Standalone unit test for src/remote/attachments.ts's UploadAssembler (Phase 6c). Run:
//   npx tsc -p extensions/openvs-chat/tsconfig.json
//   node extensions/openvs-chat/scripts/test-attachments.mjs
//
// attachments.ts imports nothing from `vscode` (the same reason src/session/ doesn't — see
// test-session-store.mjs's own doc), so the compiled module is imported directly, no stub
// needed.
import assert from 'node:assert/strict';
import { MAX_SESSION_BYTES, MAX_UPLOAD_BYTES, UploadAssembler } from '../out/remote/attachments.js';

/** Builds a base64 string that decodes to exactly `bytes` raw bytes. */
function base64OfSize(bytes) {
	return Buffer.alloc(bytes, 'a').toString('base64');
}

/** Splits `base64` into chunks of at most `size` base64 characters, preserving order. */
function splitBase64(base64, size) {
	const chunks = [];
	for (let i = 0; i < base64.length; i += size) {
		chunks.push(base64.slice(i, i + size));
	}
	return chunks;
}

// 1. Basic reassembly, chunks fed in order: the final image decodes back to the original bytes.
{
	const assembler = new UploadAssembler();
	const original = base64OfSize(300_000); // ~300KB, well under any cap
	const parts = splitBase64(original, 65_536);
	assert.ok(parts.length > 1, 'test setup: expected more than one chunk');

	let last;
	parts.forEach((chunk, index) => {
		last = assembler.addChunk({ sessionId: 's1', uploadId: 'u1', index, total: parts.length, chunk, mimeType: index === 0 ? 'image/jpeg' : undefined });
		if (index < parts.length - 1) {
			assert.deepStrictEqual(last, { status: 'progress' }, `chunk ${index} should still be in progress`);
		}
	});
	assert.strictEqual(last.status, 'complete', 'the last chunk completes the upload');
	assert.strictEqual(last.sessionId, 's1');
	assert.strictEqual(last.image.mimeType, 'image/jpeg', 'mimeType carried on chunk 0 is kept');
	assert.strictEqual(last.image.data, original, 'reassembled base64 must equal the original exactly');
}

// 2. Out-of-order arrival: the plan does not require strict ordering since `index` is explicit
// on every chunk — reassembly must still produce the exact original regardless of arrival order.
{
	const assembler = new UploadAssembler();
	const original = base64OfSize(200_000);
	const parts = splitBase64(original, 65_536);
	assert.ok(parts.length >= 3, 'test setup: need at least 3 chunks to meaningfully reorder');
	const order = [...parts.keys()].reverse(); // last chunk first, first chunk last

	let last;
	for (const index of order) {
		last = assembler.addChunk({ sessionId: 's2', uploadId: 'u2', index, total: parts.length, chunk: parts[index], mimeType: 'image/png' });
	}
	assert.strictEqual(last.status, 'complete', 'an upload completes once every index has arrived, regardless of order');
	assert.strictEqual(last.image.data, original, 'out-of-order reassembly must still equal the original exactly');
}

// 3. A malformed/truncated upload (missing a chunk) never completes.
{
	const assembler = new UploadAssembler();
	const original = base64OfSize(200_000);
	const parts = splitBase64(original, 65_536);
	assert.ok(parts.length >= 3, 'test setup: need at least 3 chunks');
	// Send every chunk except the last.
	let lastResult;
	for (let index = 0; index < parts.length - 1; index++) {
		lastResult = assembler.addChunk({ sessionId: 's3', uploadId: 'u3', index, total: parts.length, chunk: parts[index] });
	}
	assert.strictEqual(lastResult.status, 'progress', 'an upload missing its final chunk must never report complete');
}

// 3b. An invalid index (>= total, or negative) is rejected outright, not silently accepted or ignored.
{
	const assembler = new UploadAssembler();
	const result = assembler.addChunk({ sessionId: 's3b', uploadId: 'u3b', index: 5, total: 3, chunk: base64OfSize(10) });
	assert.strictEqual(result.status, 'rejected', 'index >= total must be rejected');
}

// 4. The 8MB per-upload cap rejects a single upload whose chunks sum past it, and does not
// silently truncate — no `complete` is ever reported for it.
{
	const assembler = new UploadAssembler();
	const chunkBytes = 3 * 1024 * 1024; // 3MB raw per chunk; 3 chunks = 9MB > 8MB cap
	const total = 3;
	let results = [];
	for (let index = 0; index < total; index++) {
		results.push(assembler.addChunk({ sessionId: 's4', uploadId: 'u4', index, total, chunk: base64OfSize(chunkBytes) }));
	}
	assert.strictEqual(results[0].status, 'progress');
	assert.strictEqual(results[1].status, 'progress');
	assert.strictEqual(results[2].status, 'rejected', 'the chunk that pushes the upload past 8MB must be rejected');
	assert.match(results[2].reason, /upload exceeds/);
	// The upload must be fully dropped, not left half-assembled: resending the same 3 chunks
	// from scratch must behave identically (still rejects on the 3rd), not "complete" from
	// leftover state.
	const retry = [0, 1, 2].map(index =>
		assembler.addChunk({ sessionId: 's4', uploadId: 'u4', index, total, chunk: base64OfSize(chunkBytes) }));
	assert.strictEqual(retry[2].status, 'rejected', 'a dropped upload must not silently resume from stale state');
}

// 5. Two concurrent uploads on different uploadIds (same session) do not interfere: interleaving
// their chunks must still let both complete independently and exactly.
{
	const assembler = new UploadAssembler();
	const originalA = base64OfSize(100_000);
	const originalB = base64OfSize(150_000);
	const partsA = splitBase64(originalA, 40_000);
	const partsB = splitBase64(originalB, 40_000);

	let resultA, resultB;
	const maxLen = Math.max(partsA.length, partsB.length);
	for (let i = 0; i < maxLen; i++) {
		if (i < partsA.length) {
			resultA = assembler.addChunk({ sessionId: 's5', uploadId: 'uA', index: i, total: partsA.length, chunk: partsA[i], mimeType: 'image/jpeg' });
		}
		if (i < partsB.length) {
			resultB = assembler.addChunk({ sessionId: 's5', uploadId: 'uB', index: i, total: partsB.length, chunk: partsB[i], mimeType: 'image/png' });
		}
	}
	assert.strictEqual(resultA.status, 'complete');
	assert.strictEqual(resultA.image.data, originalA, 'upload A must reassemble to exactly its own bytes, not a mix with B');
	assert.strictEqual(resultA.image.mimeType, 'image/jpeg');
	assert.strictEqual(resultB.status, 'complete');
	assert.strictEqual(resultB.image.data, originalB, 'upload B must reassemble to exactly its own bytes, not a mix with A');
	assert.strictEqual(resultB.image.mimeType, 'image/png');
}

// 6. The 32MB per-session ceiling counts across multiple uploads for the same session: five
// separate ~7MB uploads (each individually under the 8MB per-upload cap) must be rejected once
// their sum would cross 32MB, even though no single upload ever approaches the per-upload cap.
{
	const assembler = new UploadAssembler();
	const perUploadBytes = 7 * 1024 * 1024; // under MAX_UPLOAD_BYTES individually
	assert.ok(perUploadBytes < MAX_UPLOAD_BYTES, 'test setup: each upload must stay under the per-upload cap');
	const results = [];
	for (let n = 0; n < 5; n++) {
		results.push(assembler.addChunk({ sessionId: 's6', uploadId: `u6-${n}`, index: 0, total: 1, chunk: base64OfSize(perUploadBytes) }));
	}
	// 4 * 7MB = 28MB (under 32MB), the 5th (35MB total) crosses the session ceiling.
	assert.deepStrictEqual(results.slice(0, 4).map(r => r.status), ['complete', 'complete', 'complete', 'complete'],
		'the first four uploads together (28MB) must stay under the 32MB session ceiling');
	assert.strictEqual(results[4].status, 'rejected', 'the fifth upload must be rejected once the cumulative session total would exceed 32MB');
	assert.match(results[4].reason, /session exceeds/);

	// A different session is unaffected by this session's cumulative total.
	const otherSession = assembler.addChunk({ sessionId: 's6-other', uploadId: 'u6-other', index: 0, total: 1, chunk: base64OfSize(perUploadBytes) });
	assert.strictEqual(otherSession.status, 'complete', "one session's usage must not count against another session's ceiling");
}

// 6b. Sanity on the exported constants themselves, so the test above stays meaningful if they change.
{
	assert.strictEqual(MAX_UPLOAD_BYTES, 8 * 1024 * 1024);
	assert.strictEqual(MAX_SESSION_BYTES, 32 * 1024 * 1024);
}

console.log('test-attachments: all assertions passed');
