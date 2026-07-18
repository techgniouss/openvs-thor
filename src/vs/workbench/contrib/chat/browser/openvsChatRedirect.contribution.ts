/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CHAT_OPEN_ACTION_ID } from './actions/chatActions.js';
import { ChatContextKeys } from '../common/actions/chatContextKeys.js';

/**
 * Identifier of the openvs-chat sidebar view, kept in sync with the view
 * registration in `extensions/openvs-chat`.
 */
const OPENVS_CHAT_VIEW_ID = 'openvsChat.view';

/**
 * Identifier of the openvs-chat view container, kept in sync with the view
 * container registration in `extensions/openvs-chat`.
 */
const OPENVS_CHAT_CONTAINER_ID = 'openvsChat';

/**
 * Redirects the native chat entry points to the openvs-chat webview and
 * suppresses the built-in GitHub Copilot setup chrome. OpenVS ships its own
 * chat; Copilot remains an optional Marketplace install.
 */
export class OpenVSChatRedirectContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.openvsChatRedirect';

	/**
	 * Listens for the openvs-chat view container to be registered by the
	 * extension so it can be relocated once available; disposed after the
	 * first successful relocation so a later manual move by the user sticks.
	 */
	private readonly relocateListener = this._register(new MutableDisposable());

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();

		// Suppress all Copilot setup chrome (welcome, status entry, quota prompts)
		// which gate on `chatSetupHidden` being false.
		ChatContextKeys.Setup.hidden.bindTo(contextKeyService).set(true);

		// The keybinding (Ctrl+Alt+I) and the title-bar Chat button both invoke
		// `workbench.action.chat.open`; overriding the command reroutes all of them.
		this._register(CommandsRegistry.registerCommand(CHAT_OPEN_ACTION_ID, this.openOpenVSChatView));

		// The extension may not have registered its view container yet; listen
		// for it to show up, then try immediately in case it already has.
		this.relocateListener.value = this.viewDescriptorService.onDidChangeViewContainers(() => this.relocateOpenVSChatContainer());
		this.relocateOpenVSChatContainer();
	}

	/**
	 * Moves the openvs-chat view container to the AuxiliaryBar (secondary
	 * sidebar) if it exists and is not already there — the spot Copilot chat
	 * used to occupy. Once a relocation succeeds, stops listening for further
	 * container changes so a later manual move by the user is respected.
	 */
	private relocateOpenVSChatContainer(): void {
		const container = this.viewDescriptorService.getViewContainerById(OPENVS_CHAT_CONTAINER_ID);
		if (!container) {
			return;
		}

		if (this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
			this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'openvs-chat default placement');
		}

		this.relocateListener.clear();
	}

	/**
	 * Reveals the openvs-chat webview, standing in for the native chat open
	 * command. Kept as a reusable method so other redirects (e.g. menu-based
	 * overrides) can invoke the same behavior.
	 */
	private openOpenVSChatView = async (accessor: ServicesAccessor): Promise<void> => {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(OPENVS_CHAT_VIEW_ID, true);
	};
}
