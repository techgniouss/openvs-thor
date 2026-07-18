/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';

/**
 * Redirects the native chat entry points to the openvs-chat webview and
 * suppresses the built-in GitHub Copilot setup chrome. OpenVS ships its own
 * chat; Copilot remains an optional Marketplace install.
 */
export class OpenVSChatRedirectContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openvsChatRedirect';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		// Suppress all Copilot setup chrome (welcome, status entry, quota prompts)
		// which gate on `chatSetupHidden` being false.
		ChatContextKeys.Setup.hidden.bindTo(contextKeyService).set(true);
	}
}
