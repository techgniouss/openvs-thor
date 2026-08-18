/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
/**
 * A minimal QR Code encoder: byte mode, error-correction level L, versions 1–6 (up to 134
 * bytes of payload) — enough for a pairing URL like `https://relay.example/p/<roomId>#<code>`.
 * Pure encoding logic only; `media/pairing.js` turns the returned module matrix into an SVG.
 *
 * Implements ISO/IEC 18004 directly (Reed–Solomon error correction over GF(256), BCH(15,5)
 * format-info coding, the standard function-pattern layout, zig-zag data placement, and
 * penalty-scored mask selection) rather than approximating it — see `scripts/test-qr.mjs` for
 * what is actually checked and why.
 *
 * Dependency-free by design, matching `media/prompts.js`'s house rules (no `innerHTML`, no
 * `querySelector` — irrelevant here since this file touches no DOM at all) and this
 * extension's zero-npm-dependency posture for `media/`.
 */
(function () {
	'use strict';

	// ---- GF(256) arithmetic --------------------------------------------------------
	// QR's Reed–Solomon codes work over GF(256) with the primitive polynomial
	// x^8 + x^4 + x^3 + x^2 + 1 (0x11D) and primitive element 2.

	/** @type {Uint8Array} `GF_EXP[i]` = 2^i in GF(256), extended to 512 entries so `GF_EXP[a+b]` never needs a modulo. */
	const GF_EXP = new Uint8Array(512);
	/** @type {Uint8Array} `GF_LOG[x]` = the discrete log of `x` (base 2) in GF(256); `GF_LOG[0]` is unused. */
	const GF_LOG = new Uint8Array(256);
	(function initGaloisTables() {
		let x = 1;
		for (let i = 0; i < 255; i++) {
			GF_EXP[i] = x;
			GF_LOG[x] = i;
			x <<= 1;
			if (x & 0x100) {
				x ^= 0x11d;
			}
		}
		for (let i = 255; i < 512; i++) {
			GF_EXP[i] = GF_EXP[i - 255];
		}
	}());

	/**
	 * Multiplies two GF(256) elements.
	 * @param {number} a
	 * @param {number} b
	 */
	function gfMul(a, b) {
		if (a === 0 || b === 0) {
			return 0;
		}
		return GF_EXP[GF_LOG[a] + GF_LOG[b]];
	}

	/**
	 * The Reed–Solomon generator polynomial of the given `degree` (= number of EC codewords),
	 * as coefficients highest-degree-first, monic (`gen[0] === 1`). `g(x) = ∏_{i=0}^{degree-1} (x + 2^i)`.
	 * @param {number} degree
	 * @returns {number[]}
	 */
	function rsGeneratorPoly(degree) {
		let gen = [1];
		for (let i = 0; i < degree; i++) {
			const c = GF_EXP[i];
			const next = new Array(gen.length + 1).fill(0);
			next[0] = gen[0];
			for (let k = 1; k < gen.length; k++) {
				next[k] = gen[k] ^ gfMul(gen[k - 1], c);
			}
			next[gen.length] = gfMul(gen[gen.length - 1], c);
			gen = next;
		}
		return gen;
	}

	/**
	 * Computes the `ecLen` Reed–Solomon error-correction codewords for one block of data
	 * codewords, via the standard "long division by the generator polynomial" LFSR algorithm.
	 * @param {Uint8Array} dataBytes
	 * @param {number} ecLen
	 * @returns {Uint8Array}
	 */
	function rsComputeEc(dataBytes, ecLen) {
		const gen = rsGeneratorPoly(ecLen);
		const msg = new Uint8Array(dataBytes.length + ecLen);
		msg.set(dataBytes, 0);
		for (let i = 0; i < dataBytes.length; i++) {
			const coef = msg[i];
			if (coef !== 0) {
				for (let j = 0; j < gen.length; j++) {
					msg[i + j] ^= gfMul(gen[j], coef);
				}
			}
		}
		return msg.slice(dataBytes.length);
	}

	// ---- Version/block tables (versions 1–6, error correction level L only) --------

	/**
	 * Per-version codeword layout at ECC level L: how many EC codewords each block carries, and
	 * how many data codewords are in each block (more than one block only from version 6 up).
	 * @type {Record<number, { ecPerBlock: number, blocks: number[] }>}
	 */
	const VERSION_INFO = {
		1: { ecPerBlock: 7, blocks: [19] },
		2: { ecPerBlock: 10, blocks: [34] },
		3: { ecPerBlock: 15, blocks: [55] },
		4: { ecPerBlock: 20, blocks: [80] },
		5: { ecPerBlock: 26, blocks: [108] },
		6: { ecPerBlock: 18, blocks: [68, 68] },
	};

	/** Byte-mode header size in bits: a 4-bit mode indicator plus an 8-bit character count (versions 1–9). */
	const HEADER_BITS = 12;

	/** Matrix side length, in modules, for `version` (1–6): `4*version + 17`. */
	function sizeForVersion(version) {
		return 4 * version + 17;
	}

	/**
	 * The largest byte-mode payload (in bytes) that fits in `version` at ECC level L, header
	 * included.
	 * @param {number} version
	 */
	function byteCapacity(version) {
		const dataCodewords = VERSION_INFO[version].blocks.reduce((a, b) => a + b, 0);
		return Math.floor((dataCodewords * 8 - HEADER_BITS) / 8);
	}

	/**
	 * The smallest version (1–6) whose byte-mode capacity fits `byteLen` bytes of payload.
	 * @param {number} byteLen
	 */
	function chooseVersion(byteLen) {
		for (let v = 1; v <= 6; v++) {
			if (byteLen <= byteCapacity(v)) {
				return v;
			}
		}
		throw new Error(`OpenVSQr: ${byteLen} bytes is too large for a version 1-6 QR code (max ${byteCapacity(6)} bytes).`);
	}

	// ---- Bit stream -----------------------------------------------------------------

	/** A little helper for building an MSB-first bit stream, one field at a time. */
	function makeBitWriter() {
		/** @type {number[]} one entry per bit, 0 or 1 */
		const bits = [];
		return {
			/** @param {number} value @param {number} width */
			push(value, width) {
				for (let i = width - 1; i >= 0; i--) {
					bits.push((value >>> i) & 1);
				}
			},
			get length() { return bits.length; },
			bits,
		};
	}

	/**
	 * Builds the full data-codeword sequence for `bytes` at `version`: byte-mode header, the
	 * payload itself, the terminator, bit padding to a byte boundary, and pad codewords
	 * (alternating 0xEC/0x11) up to the version's data-codeword capacity.
	 * @param {Uint8Array} bytes
	 * @param {number} version
	 * @returns {Uint8Array}
	 */
	function buildDataCodewords(bytes, version) {
		const dataCodewordCount = VERSION_INFO[version].blocks.reduce((a, b) => a + b, 0);
		const capacityBits = dataCodewordCount * 8;

		const writer = makeBitWriter();
		writer.push(0b0100, 4); // byte mode
		writer.push(bytes.length, 8); // character count (versions 1-9)
		for (const b of bytes) {
			writer.push(b, 8);
		}
		// Terminator: up to 4 zero bits, only as many as remain.
		const terminatorBits = Math.min(4, capacityBits - writer.length);
		for (let i = 0; i < terminatorBits; i++) {
			writer.bits.push(0);
		}
		// Pad to a byte boundary.
		while (writer.bits.length % 8 !== 0) {
			writer.bits.push(0);
		}

		const codewords = [];
		for (let i = 0; i < writer.bits.length; i += 8) {
			let byte = 0;
			for (let j = 0; j < 8; j++) {
				byte = (byte << 1) | writer.bits[i + j];
			}
			codewords.push(byte);
		}
		const PAD_BYTES = [0xec, 0x11];
		let padIndex = 0;
		while (codewords.length < dataCodewordCount) {
			codewords.push(PAD_BYTES[padIndex % 2]);
			padIndex++;
		}
		return Uint8Array.from(codewords);
	}

	/**
	 * Splits `dataCodewords` into per-block arrays, computes each block's EC codewords, and
	 * interleaves both (data codewords column-major across blocks, then EC codewords the same
	 * way) per the QR spec's "block interleaving" step — a no-op reshuffle when there is only
	 * one block (every version here except 6).
	 * @param {Uint8Array} dataCodewords
	 * @param {number} version
	 * @returns {Uint8Array} the final codeword sequence, ready for module placement.
	 */
	function interleaveCodewords(dataCodewords, version) {
		const { ecPerBlock, blocks } = VERSION_INFO[version];
		/** @type {Uint8Array[]} */
		const dataBlocks = [];
		/** @type {Uint8Array[]} */
		const ecBlocks = [];
		let offset = 0;
		for (const len of blocks) {
			const block = dataCodewords.slice(offset, offset + len);
			dataBlocks.push(block);
			ecBlocks.push(rsComputeEc(block, ecPerBlock));
			offset += len;
		}
		const maxDataLen = Math.max(...blocks);
		/** @type {number[]} */
		const out = [];
		for (let col = 0; col < maxDataLen; col++) {
			for (const block of dataBlocks) {
				if (col < block.length) {
					out.push(block[col]);
				}
			}
		}
		for (let col = 0; col < ecPerBlock; col++) {
			for (const block of ecBlocks) {
				out.push(block[col]);
			}
		}
		return Uint8Array.from(out);
	}

	/** Remainder bits appended after the interleaved codewords, before module placement. Version 1 has none; versions 2–6 have 7. */
	function remainderBits(version) {
		return version === 1 ? 0 : 7;
	}

	// ---- Matrix construction ---------------------------------------------------------

	/**
	 * The mutable module grid being built. `dark`/`isFunction` are flat `size*size` arrays
	 * (row-major) rather than arrays-of-arrays — one allocation, simpler bounds checks.
	 * @typedef {{ size: number, dark: Uint8Array, isFunction: Uint8Array }} Matrix
	 */

	/** @param {number} size @returns {Matrix} */
	function makeMatrix(size) {
		return { size, dark: new Uint8Array(size * size), isFunction: new Uint8Array(size * size) };
	}

	/** @param {Matrix} m @param {number} row @param {number} col */
	function inBounds(m, row, col) {
		return row >= 0 && row < m.size && col >= 0 && col < m.size;
	}

	/** @param {Matrix} m @param {number} row @param {number} col @param {number} value 0 or 1 */
	function setModule(m, row, col, value) {
		if (!inBounds(m, row, col)) {
			return;
		}
		m.dark[row * m.size + col] = value;
		m.isFunction[row * m.size + col] = 1;
	}

	/** Draws one 7×7 finder pattern with its corner at `(row0, col0)`, plus the light separator ring around it. @param {Matrix} m */
	function drawFinderPattern(m, row0, col0) {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const row = row0 + dr;
				const col = col0 + dc;
				if (!inBounds(m, row, col)) {
					continue;
				}
				const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
				let value = 0;
				if (inRing) {
					const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
					const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
					value = (onBorder || inCenter) ? 1 : 0;
				}
				setModule(m, row, col, value);
			}
		}
	}

	/** Draws the horizontal + vertical timing patterns (alternating dark/light, starting dark) between the finder patterns. @param {Matrix} m */
	function drawTimingPatterns(m) {
		for (let i = 8; i < m.size - 8; i++) {
			const value = i % 2 === 0 ? 1 : 0;
			setModule(m, 6, i, value);
			setModule(m, i, 6, value);
		}
	}

	/**
	 * Draws the single alignment pattern versions 2–6 have (a 5×5 pattern centered at `(p, p)`,
	 * where `p = 4*version + 10`). Versions 1–6 never have more than one, and the standard
	 * position-list combinations that would overlap a finder pattern are exactly the ones
	 * skipped by using this single center for versions in this range.
	 * @param {Matrix} m @param {number} version
	 */
	function drawAlignmentPattern(m, version) {
		if (version < 2) {
			return;
		}
		const p = 4 * version + 10;
		for (let dr = -2; dr <= 2; dr++) {
			for (let dc = -2; dc <= 2; dc++) {
				const onBorder = dr === -2 || dr === 2 || dc === -2 || dc === 2;
				const isCenter = dr === 0 && dc === 0;
				setModule(m, p + dr, p + dc, (onBorder || isCenter) ? 1 : 0);
			}
		}
	}

	/**
	 * Reserves (marks function, value irrelevant here — {@link writeFormatBits} fills it in
	 * after mask selection) the two format-info strips flanking the top-left finder pattern,
	 * plus their mirrored copy along the top-right and bottom-left patterns, and the one fixed
	 * dark module every version 1–6 symbol has at `(4*version+9, 8)`.
	 * @param {Matrix} m @param {number} version
	 */
	function reserveFormatInfo(m, version) {
		for (let i = 0; i <= 8; i++) {
			if (i !== 6) {
				setModule(m, 8, i, 0);
				setModule(m, i, 8, 0);
			}
		}
		for (let i = 0; i < 8; i++) {
			setModule(m, 8, m.size - 1 - i, 0);
			setModule(m, m.size - 1 - i, 8, 0);
		}
		setModule(m, 4 * version + 9, 8, 1); // the fixed dark module
	}

	/**
	 * Places the 15-bit masked format codeword (ECC level + mask pattern, BCH-protected) into
	 * its two redundant locations, per the layout {@link reserveFormatInfo} reserved. Bit `i`
	 * (LSB-first, i.e. `(formatBits15 >>> i) & 1`, per ISO/IEC 18004's own indexing) is written
	 * to a "vertical" cell in column 8 AND a "horizontal" cell in row 8 simultaneously — the two
	 * together form both redundant copies at once, rather than one copy-array per corner. Bit
	 * order used to run the other way (`>>> (14 - i)`, MSB-first) and the column-8 loop ran one
	 * iteration too far into the fixed dark module's own row — between them every copy came out
	 * with roughly half its bits wrong, and a real decoder could recover neither the mask/ECC
	 * declaration nor (via the wrong mask) the data that placement itself had gotten right.
	 * @param {Matrix} m @param {number} formatBits15
	 */
	function writeFormatBits(m, formatBits15) {
		const size = m.size;
		for (let i = 0; i < 15; i++) {
			const mod = (formatBits15 >>> i) & 1;
			if (i < 6) {
				m.dark[i * size + 8] = mod;
			} else if (i < 8) {
				m.dark[(i + 1) * size + 8] = mod;
			} else {
				m.dark[(size - 15 + i) * size + 8] = mod;
			}
			if (i < 8) {
				m.dark[8 * size + (size - 1 - i)] = mod;
			} else if (i < 9) {
				m.dark[8 * size + 7] = mod;
			} else {
				m.dark[8 * size + (14 - i)] = mod;
			}
		}
		m.dark[(size - 8) * size + 8] = 1; // the fixed dark module, written last so nothing above can clobber it
	}

	/**
	 * BCH(15,5) encodes a 5-bit format value (2-bit ECC-level indicator + 3-bit mask pattern)
	 * into the 15-bit format codeword, then applies the fixed XOR mask the spec requires so an
	 * all-zero symbol never produces an all-zero format string. Generator `0x537` = `x^10 + x^8
	 * + x^5 + x^4 + x^2 + x + 1`; mask `0x5412` per ISO/IEC 18004 Annex C.
	 * @param {number} eccIndicator 2-bit ECC-level indicator (L = 0b01)
	 * @param {number} maskPattern 3-bit mask pattern index (0-7)
	 */
	function encodeFormatBits(eccIndicator, maskPattern) {
		const data = ((eccIndicator & 0x3) << 3) | (maskPattern & 0x7);
		const GENERATOR = 0b10100110111;
		let g = data << 10;
		for (let i = 14; i >= 10; i--) {
			if ((g >>> i) & 1) {
				g ^= GENERATOR << (i - 10);
			}
		}
		const codeword = (data << 10) | g;
		return codeword ^ 0x5412;
	}

	/** ECC-level indicator bits for level L, per ISO/IEC 18004 Table 25. */
	const ECC_L_INDICATOR = 0b01;

	/**
	 * Places `codewordBytes` (already interleaved + remainder-padded into a bit stream) into
	 * every non-function module, in the standard zig-zag order: starting at the bottom-right
	 * corner, moving up two columns at a time, alternating direction, skipping the vertical
	 * timing column entirely.
	 * @param {Matrix} m @param {number[]} bitStream
	 */
	function placeData(m, bitStream) {
		let bitIndex = 0;
		let upward = true;
		for (let colPair = m.size - 1; colPair >= 1; colPair -= 2) {
			if (colPair === 6) {
				colPair = 5; // the vertical timing column is never used for data
			}
			for (let step = 0; step < m.size; step++) {
				const row = upward ? m.size - 1 - step : step;
				for (let dc = 0; dc < 2; dc++) {
					const col = colPair - dc;
					const idx = row * m.size + col;
					if (m.isFunction[idx]) {
						continue;
					}
					m.dark[idx] = bitIndex < bitStream.length ? bitStream[bitIndex] : 0;
					bitIndex++;
				}
			}
			upward = !upward;
		}
	}

	/** The 8 standard QR mask formulas; `true` means "flip this module". @type {((row: number, col: number) => boolean)[]} */
	const MASKS = [
		(row, col) => (row + col) % 2 === 0,
		(row, col) => row % 2 === 0,
		(row, col) => col % 3 === 0,
		(row, col) => (row + col) % 3 === 0,
		(row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
		(row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
		(row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
		(row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
	];

	/**
	 * Applies mask `maskIndex` to every non-function module (XOR), returning a fresh matrix —
	 * the caller keeps the unmasked original so it can try every mask independently.
	 * @param {Matrix} m @param {number} maskIndex
	 * @returns {Matrix}
	 */
	function applyMask(m, maskIndex) {
		const out = { size: m.size, dark: m.dark.slice(), isFunction: m.isFunction };
		const formula = MASKS[maskIndex];
		for (let row = 0; row < m.size; row++) {
			for (let col = 0; col < m.size; col++) {
				const idx = row * m.size + col;
				if (!m.isFunction[idx] && formula(row, col)) {
					out.dark[idx] ^= 1;
				}
			}
		}
		return out;
	}

	/**
	 * The standard 4-rule penalty score (ISO/IEC 18004 §8.8.2) for a candidate masked matrix.
	 * Lower is better; the mask minimizing this is the one used. Evaluated over the whole
	 * symbol including function patterns — those are identical across every mask candidate, so
	 * they contribute the same constant to every score and do not change which mask wins.
	 * @param {Matrix} m
	 */
	function penaltyScore(m) {
		let score = 0;
		const size = m.size;
		const at = (row, col) => m.dark[row * size + col];

		// Rule 1: runs of 5+ same-colour modules, in each row and each column.
		for (let pass = 0; pass < 2; pass++) {
			for (let i = 0; i < size; i++) {
				let runColor = -1;
				let runLen = 0;
				for (let j = 0; j < size; j++) {
					const v = pass === 0 ? at(i, j) : at(j, i);
					if (v === runColor) {
						runLen++;
					} else {
						if (runLen >= 5) {
							score += 3 + (runLen - 5);
						}
						runColor = v;
						runLen = 1;
					}
				}
				if (runLen >= 5) {
					score += 3 + (runLen - 5);
				}
			}
		}

		// Rule 2: every 2x2 block of one colour.
		for (let row = 0; row < size - 1; row++) {
			for (let col = 0; col < size - 1; col++) {
				const v = at(row, col);
				if (v === at(row, col + 1) && v === at(row + 1, col) && v === at(row + 1, col + 1)) {
					score += 3;
				}
			}
		}

		// Rule 3: the finder-like 1:1:3:1:1 pattern (with 4 light modules on one side),
		// found in a row or a column.
		const PATTERN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
		const PATTERN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
		/** @param {number[]} line */
		function countPattern(line) {
			let count = 0;
			for (let i = 0; i + 11 <= line.length; i++) {
				const window = line.slice(i, i + 11);
				if (window.every((v, k) => v === PATTERN_A[k]) || window.every((v, k) => v === PATTERN_B[k])) {
					count++;
				}
			}
			return count;
		}
		for (let row = 0; row < size; row++) {
			const line = [];
			for (let col = 0; col < size; col++) { line.push(at(row, col)); }
			score += 40 * countPattern(line);
		}
		for (let col = 0; col < size; col++) {
			const line = [];
			for (let row = 0; row < size; row++) { line.push(at(row, col)); }
			score += 40 * countPattern(line);
		}

		// Rule 4: how far the proportion of dark modules is from 50%.
		let dark = 0;
		for (let i = 0; i < m.dark.length; i++) { dark += m.dark[i]; }
		const percent = (dark * 100) / m.dark.length;
		score += Math.floor(Math.abs(percent - 50) / 5) * 10;

		return score;
	}

	/**
	 * Encodes `text` (as UTF-8 bytes, byte mode) into a QR code matrix at ECC level L, choosing
	 * the smallest version (1–6) that fits and the mask pattern with the lowest penalty score.
	 * @param {string} text
	 * @returns {{ size: number, modules: boolean[][] }}
	 */
	function encode(text) {
		const bytes = new TextEncoder().encode(text);
		const version = chooseVersion(bytes.length);
		const dataCodewords = buildDataCodewords(bytes, version);
		const finalCodewords = interleaveCodewords(dataCodewords, version);

		/** @type {number[]} */
		const bitStream = [];
		for (const byte of finalCodewords) {
			for (let i = 7; i >= 0; i--) {
				bitStream.push((byte >>> i) & 1);
			}
		}
		for (let i = 0; i < remainderBits(version); i++) {
			bitStream.push(0);
		}

		const size = sizeForVersion(version);
		const base = makeMatrix(size);
		drawFinderPattern(base, 0, 0);
		drawFinderPattern(base, 0, size - 7);
		drawFinderPattern(base, size - 7, 0);
		drawTimingPatterns(base);
		drawAlignmentPattern(base, version);
		reserveFormatInfo(base, version);
		placeData(base, bitStream);

		let best;
		let bestScore = Infinity;
		let bestMask = 0;
		for (let maskIndex = 0; maskIndex < 8; maskIndex++) {
			const candidate = applyMask(base, maskIndex);
			const score = penaltyScore(candidate);
			if (score < bestScore) {
				bestScore = score;
				best = candidate;
				bestMask = maskIndex;
			}
		}
		// `best`/`bestMask` are always assigned: the loop above always runs at least once.
		const chosen = /** @type {Matrix} */ (best);
		writeFormatBits(chosen, encodeFormatBits(ECC_L_INDICATOR, bestMask));

		/** @type {boolean[][]} */
		const modules = [];
		for (let row = 0; row < size; row++) {
			const line = [];
			for (let col = 0; col < size; col++) {
				line.push(chosen.dark[row * size + col] === 1);
			}
			modules.push(line);
		}
		return { size, modules };
	}

	// @ts-ignore — the webview's own namespace, consumed by pairing.js and the QR tests.
	globalThis.OpenVSQr = { encode };
}());
