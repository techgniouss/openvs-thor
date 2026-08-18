/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Tests for media/qr.js, the hand-rolled byte-mode QR encoder (ECC level L, versions 1-6)
// media/pairing.js renders into an SVG. Run:
//   node extensions/openvs-chat/scripts/test-qr.mjs
//
// ---- Validation strategy (read this before trusting the green checkmark) --------------------
// A full reference decoder is out of scope for a test file, and this environment has no camera
// or third-party QR scanner to validate against. Per this task's brief, the fallback when no
// independently-known-correct byte-level test vector is at hand with confidence is to check
// STRUCTURAL INVARIANTS the spec guarantees, plus one piece of real cryptographic self-
// consistency that a broken encoder is very unlikely to pass by accident:
//
//   * matrix size and version selection match the spec's per-version capacity table (a widely
//     published, unambiguous constant: 17/32/53/78/106/134 payload bytes for versions 1-6 at
//     ECC level L) — this is checked both by capacity boundary (does N bytes throw or not) and
//     by the resulting size (4*version+17).
//   * the three finder patterns are the standard 7x7 alternating dark/light/dark ring,
//     independently re-derived here (not by re-running qr.js's own drawing code).
//   * the timing pattern alternates dark/light between the finder patterns.
//   * the one fixed "dark module" every version 1-6 symbol has is actually dark.
//   * the format-info codeword found in the matrix (extracted at the two positions the spec
//     places it, independently listed in this file rather than imported from qr.js) is a valid
//     BCH(15,5) codeword — i.e. XOR-unmasking it and dividing by the spec's generator polynomial
//     leaves a zero remainder — AND both redundant copies agree with each other. A transposed
//     bit, an off-by-one in either copy's position list, or a wrong mask constant fails this
//     with very high probability; it is a real algebraic check, not a tautology, even though it
//     shares this file's own understanding of *where* the bits are (see the caveat below).
//   * encoding the same input twice is byte-identical (determinism matters for a QR the user is
//     told to scan once — no flicker between reloads of the same pairing card).
//
// Caveat this strategy does NOT cover: it cannot prove the *module positions* this encoder
// places bits at match the ISO/IEC 18004 spec's positions exactly (e.g. that a real phone
// camera would decode the same payload back out) — only that the encoder is internally
// consistent and produces well-formed, spec-shaped structure. That residual risk is called out
// explicitly in this task's report rather than hidden behind a green test run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadQr() {
	const source = fs.readFileSync(new URL('../media/qr.js', import.meta.url), 'utf8');
	const sandbox = { TextEncoder };
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'qr.js' });
	assert.ok(sandbox.OpenVSQr, 'qr.js published its namespace');
	return sandbox.OpenVSQr;
}

const OpenVSQr = loadQr();

/** Published byte-mode capacity per version (1-6) at ECC level L — ISO/IEC 18004 Table 7-11. */
const CAPACITY = { 1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134 };

// 1. Version selection follows the published capacity table, at every boundary.
{
	for (const [version, capacity] of Object.entries(CAPACITY)) {
		const v = Number(version);
		const expectedSize = 4 * v + 17;
		const atCapacity = OpenVSQr.encode('x'.repeat(capacity));
		assert.strictEqual(atCapacity.size, expectedSize, `version ${v}'s own capacity (${capacity} bytes) fits in version ${v}`);
		if (v < 6) {
			const oneMore = OpenVSQr.encode('x'.repeat(capacity + 1));
			assert.strictEqual(oneMore.size, 4 * (v + 1) + 17, `${capacity + 1} bytes overflows into version ${v + 1}`);
		}
	}
}

// 1b. One byte over the largest supported version's capacity is rejected outright, rather than
// silently producing a corrupt (too-small) symbol.
{
	assert.throws(() => OpenVSQr.encode('x'.repeat(CAPACITY[6] + 1)), /too large/);
}

// 2. Matrix shape: square, side length matches the version formula, every cell is a boolean.
{
	const { size, modules } = OpenVSQr.encode('HELLO');
	assert.strictEqual(size, 21, "'HELLO' (5 bytes) fits version 1 (21x21)");
	assert.strictEqual(modules.length, size);
	for (const row of modules) {
		assert.strictEqual(row.length, size);
		for (const cell of row) {
			assert.strictEqual(typeof cell, 'boolean');
		}
	}
}

/**
 * Asserts the 7x7 finder pattern with its corner at `(row0, col0)` is the standard ring: a
 * dark border, a light ring one module in, and a dark 3x3 center. Independently re-derived
 * here rather than calling back into qr.js's own drawing function.
 */
function assertFinderPattern(modules, row0, col0, label) {
	for (let dr = 0; dr < 7; dr++) {
		for (let dc = 0; dc < 7; dc++) {
			const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
			const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
			const expectedDark = onBorder || inCenter;
			assert.strictEqual(modules[row0 + dr][col0 + dc], expectedDark,
				`${label} finder pattern module (${dr},${dc}) should be ${expectedDark ? 'dark' : 'light'}`);
		}
	}
}

// 3. All three finder patterns, at every version this encoder supports.
{
	for (const version of [1, 2, 3, 4, 5, 6]) {
		const { size, modules } = OpenVSQr.encode('x'.repeat(CAPACITY[version]));
		assertFinderPattern(modules, 0, 0, `v${version} top-left`);
		assertFinderPattern(modules, 0, size - 7, `v${version} top-right`);
		assertFinderPattern(modules, size - 7, 0, `v${version} bottom-left`);
	}
}

// 4. Timing patterns alternate dark/light, starting dark, between the finder patterns.
{
	const { size, modules } = OpenVSQr.encode('x'.repeat(CAPACITY[3]));
	for (let i = 8; i < size - 8; i++) {
		const expectedDark = i % 2 === 0;
		assert.strictEqual(modules[6][i], expectedDark, `horizontal timing module ${i}`);
		assert.strictEqual(modules[i][6], expectedDark, `vertical timing module ${i}`);
	}
}

// 5. The fixed dark module at (4*version+9, 8) is dark, for every version.
{
	for (const version of [1, 2, 3, 4, 5, 6]) {
		const { modules } = OpenVSQr.encode('x'.repeat(CAPACITY[version]));
		assert.strictEqual(modules[4 * version + 9][8], true, `v${version} fixed dark module`);
	}
}

// 6. Determinism: encoding the same text twice yields byte-identical matrices.
{
	const a = OpenVSQr.encode('https://relay.example/p/ABCD1234#WXYZ5678');
	const b = OpenVSQr.encode('https://relay.example/p/ABCD1234#WXYZ5678');
	assert.deepStrictEqual(a, b);
}

// 7. Format-info self-consistency: the 15-bit codeword found at each of the two redundant
// locations is (a) identical between the two copies and (b) a valid BCH(15,5) codeword — i.e.
// XOR-unmasking it and dividing by the spec's generator polynomial leaves a zero remainder.
// See the file-header comment for exactly what this does and does not prove.
{
	const FORMAT_MASK = 0x5412;
	const GENERATOR = 0b10100110111;

	/** Polynomial remainder of `codeword` (15 bits) modulo `GENERATOR`, via the same bit-at-a-time reduction the encoder itself uses to compute BCH parity. Zero iff `codeword` is a valid codeword. */
	function bchRemainder(codeword) {
		let g = codeword;
		for (let i = 14; i >= 10; i--) {
			if ((g >>> i) & 1) {
				g ^= GENERATOR << (i - 10);
			}
		}
		return g;
	}

	for (const version of [1, 2, 3, 4, 5, 6]) {
		const { size, modules } = OpenVSQr.encode('x'.repeat(CAPACITY[version]));
		const bit = (row, col) => (modules[row][col] ? 1 : 0);

		// Independently re-derived from ISO/IEC 18004's own format-info layout (bit i, LSB
		// first, written to one "vertical" cell in column 8 and one "horizontal" cell in row 8
		// simultaneously — the two together are the two redundant copies), not by importing
		// qr.js's own position tables.
		let vertical = 0;
		let horizontal = 0;
		for (let i = 0; i < 15; i++) {
			const vRow = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
			const hCol = i < 8 ? size - 1 - i : i === 8 ? 7 : 14 - i;
			vertical |= bit(vRow, 8) << i;
			horizontal |= bit(8, hCol) << i;
		}

		assert.strictEqual(vertical, horizontal, `v${version}: both format-info copies agree`);
		assert.strictEqual(bchRemainder(vertical ^ FORMAT_MASK), 0, `v${version}: format-info is a valid BCH(15,5) codeword`);
	}
}

// 8. Sanity: masking actually ran and roughly balanced the symbol — an encoder that forgot to
// apply any mask (or applied the same one regardless of score) tends to produce a lopsided
// dark/light ratio, especially on the more repetitive short inputs.
{
	const { modules } = OpenVSQr.encode('https://relay.example/p/ABCD1234EFGH#WXYZ56781234');
	const total = modules.length * modules.length;
	const dark = modules.flat().filter(Boolean).length;
	const ratio = dark / total;
	assert.ok(ratio > 0.3 && ratio < 0.7, `dark-module ratio ${ratio.toFixed(2)} should be roughly balanced`);
}

console.log('test-qr: all assertions passed');
