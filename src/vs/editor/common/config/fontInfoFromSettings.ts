/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorOption, EditorOptions } from './editorOptions.js';
import { IValidatedEditorOptions, BareFontInfo } from './fontInfo.js';

function getOption(name: string): { validate: (input: any) => any } {
	if (typeof EditorOptions !== 'undefined' && (EditorOptions as any)[name]) {
		return (EditorOptions as any)[name];
	}
	switch (name) {
		case 'fontFamily':
			return { validate: (input: any) => typeof input === 'string' ? input : 'monospace' };
		case 'fontWeight':
			return { validate: (input: any) => typeof input === 'string' ? input : 'normal' };
		case 'fontSize':
			return { validate: (input: any) => typeof input === 'number' ? input : 12 };
		case 'fontLigatures2':
			return {
				validate: (input: any) => {
					if (typeof input === 'undefined') return '"liga" off, "calt" off';
					if (typeof input === 'string') {
						if (input === 'false' || input.length === 0) return '"liga" off, "calt" off';
						if (input === 'true') return '"liga" on, "calt" on';
						return input;
					}
					return Boolean(input) ? '"liga" on, "calt" on' : '"liga" off, "calt" off';
				}
			};
		case 'fontVariations':
			return {
				validate: (input: any) => {
					if (typeof input === 'undefined') return 'normal';
					if (typeof input === 'string') {
						if (input === 'false' || input.length === 0) return 'normal';
						if (input === 'true') return 'normal';
						return input;
					}
					return 'normal';
				}
			};
		case 'lineHeight':
			return { validate: (input: any) => typeof input === 'number' ? input : 0 };
		case 'letterSpacing':
			return { validate: (input: any) => typeof input === 'number' ? input : 0 };
		default:
			return { validate: (input: any) => input };
	}
}

export function createBareFontInfoFromValidatedSettings(options: IValidatedEditorOptions, pixelRatio: number, ignoreEditorZoom: boolean): BareFontInfo {
	const fontFamily = options.get(EditorOption.fontFamily);
	const fontWeight = options.get(EditorOption.fontWeight);
	const fontSize = options.get(EditorOption.fontSize);
	const fontFeatureSettings = options.get(EditorOption.fontLigatures);
	const fontVariationSettings = options.get(EditorOption.fontVariations);
	const lineHeight = options.get(EditorOption.lineHeight);
	const letterSpacing = options.get(EditorOption.letterSpacing);
	return BareFontInfo._create(fontFamily, fontWeight, fontSize, fontFeatureSettings, fontVariationSettings, lineHeight, letterSpacing, pixelRatio, ignoreEditorZoom);
}

export function createBareFontInfoFromRawSettings(opts: {
	fontFamily?: unknown;
	fontWeight?: unknown;
	fontSize?: unknown;
	fontLigatures?: unknown;
	fontVariations?: unknown;
	lineHeight?: unknown;
	letterSpacing?: unknown;
} | undefined | null, pixelRatio: number, ignoreEditorZoom: boolean = false): BareFontInfo {
	if (!opts) {
		opts = {};
	}
	const fontFamily = getOption('fontFamily').validate(opts.fontFamily);
	const fontWeight = getOption('fontWeight').validate(opts.fontWeight);
	const fontSize = getOption('fontSize').validate(opts.fontSize);
	const fontFeatureSettings = getOption('fontLigatures2').validate(opts.fontLigatures);
	const fontVariationSettings = getOption('fontVariations').validate(opts.fontVariations);
	const lineHeight = getOption('lineHeight').validate(opts.lineHeight);
	const letterSpacing = getOption('letterSpacing').validate(opts.letterSpacing);
	return BareFontInfo._create(fontFamily, fontWeight, fontSize, fontFeatureSettings, fontVariationSettings, lineHeight, letterSpacing, pixelRatio, ignoreEditorZoom);
}
