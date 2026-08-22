/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CompletionOutcome } from './types';

/**
 * Shows what inline completions are doing, and why they are silent when they are.
 *
 * A checkbox can say on or off; it cannot say "paused because this backend has 400 tokens
 * left in the window" or "this file is excluded because it looks like a credential store".
 * Those are exactly the states a user would otherwise report as the feature being broken.
 */
export class CompletionStatusBar {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
		this.item.command = 'openvsChat.completions.toggle';
		this.item.show();
		this.setEnabled(true);
	}

	/** Renders the resting state for an enabled or disabled feature. */
	setEnabled(enabled: boolean): void {
		this.item.text = enabled ? '$(sparkle) Thor' : '$(circle-slash) Thor';
		this.item.tooltip = enabled
			? 'OpenVS Thor inline completions are on. Click to turn them off.'
			: 'OpenVS Thor inline completions are off. Click to turn them on.';
	}

	/** Renders the outcome of the most recent attempt. */
	setOutcome(outcome: CompletionOutcome, detail?: string): void {
		switch (outcome) {
			case 'excluded':
				this.item.text = '$(circle-slash) Thor';
				this.item.tooltip = `Not offered here${detail ? `: ${detail}` : ''}.`;
				return;
			case 'paused-quota':
				this.item.text = '$(watch) Thor';
				this.item.tooltip = 'Paused: this provider\'s token window is nearly spent, leaving the remainder for Agent runs.';
				return;
			case 'paused-slow':
				this.item.text = '$(watch) Thor';
				this.item.tooltip = `Paused: this backend is too slow for inline completion${detail ? ` (${detail})` : ''}. Pin a smaller model in Settings.`;
				return;
			case 'no-model':
				this.item.text = '$(circle-slash) Thor';
				this.item.tooltip = 'No eligible completion model. Add a provider key, or pin one in Settings.';
				return;
			case 'error':
				this.item.text = '$(warning) Thor';
				this.item.tooltip = `Last completion failed${detail ? `: ${detail}` : ''}. See the OpenVS Thor Completions output channel.`;
				return;
			default:
				this.setEnabled(true);
		}
	}

	dispose(): void {
		this.item.dispose();
	}
}
