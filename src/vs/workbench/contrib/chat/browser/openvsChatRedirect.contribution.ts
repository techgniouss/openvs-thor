/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ACTION_ID_OPEN_CHAT, CHAT_OPEN_ACTION_ID, getOpenChatActionIdForMode } from './actions/chatActions.js';
import { ChatViewContainerId } from './chat.js';
import { ChatMode } from '../common/chatModes.js';

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
		@IChatEntitlementService chatEntitlementService: IChatEntitlementService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super();

		// Suppress all Copilot setup chrome (welcome, status entry, quota prompts)
		// via the entitlement service's purpose-built override, rather than
		// poking the `chatSetupHidden` context key directly.
		chatEntitlementService.setForceHidden(true);

		// Reroute every native chat entry point — the title-bar Chat button and
		// its icon variants, the toggle command, each mode-specific "Open Chat
		// (Ask/Edit/Agent)" command, the new-chat-editor command, quick chat
		// (both the toggle and its "open in chat view" escape hatch), and
		// editor inline chat (plus its legacy `interactiveEditor.start` alias)
		// — to the openvs-chat view. The native commands' `{query, mode}`
		// arguments are intentionally ignored here — forwarding query text into
		// the webview is a separate follow-up.
		for (const commandId of [
			CHAT_OPEN_ACTION_ID,
			getOpenChatActionIdForMode(ChatMode.Ask),
			getOpenChatActionIdForMode(ChatMode.Edit),
			getOpenChatActionIdForMode(ChatMode.Agent),
			'workbench.action.chat.toggle', // TOGGLE_CHAT_ACTION_ID (not exported)
			ACTION_ID_OPEN_CHAT,
			'workbench.action.openChat.copilotIcon',
			'workbench.action.openChat.newSessionIcon',
			'workbench.action.openChat.commentIcon',
			'workbench.action.quickchat.toggle', // ASK_QUICK_QUESTION_ACTION_ID (not exported)
			'workbench.action.quickchat.openInChatView',
			'inlineChat.start', // ACTION_START in contrib/inlineChat/common/inlineChat.ts (not exported)
			'interactiveEditor.start', // legacy alias of inlineChat.start
		]) {
			this._register(CommandsRegistry.registerCommand(commandId, this.openOpenVSChatView));
		}

		// The extension may not have registered its view container yet; listen
		// for it to show up, then try immediately in case it already has.
		this.relocateListener.value = this.viewDescriptorService.onDidChangeViewContainers(() => this.relocateOpenVSChatContainer());
		this.relocateOpenVSChatContainer();

		this.hideNativeChatContainer();
	}

	/**
	 * Deregisters the native chat view container so its panel can no longer be
	 * shown. Combined with the command reroutes above, this removes the last
	 * way a user could reach the built-in Copilot/native chat surface — OpenVS
	 * ships its own chat instead. Best-effort: if the container hasn't been
	 * registered (e.g. Copilot is disabled/uninstalled), this is a no-op.
	 *
	 * This is intentionally aggressive. If any native-chat-dependent feature
	 * (e.g. agent sessions, chat sessions) misbehaves as a result, this can be
	 * reverted by removing this one call without touching the command reroutes.
	 */
	private hideNativeChatContainer(): void {
		const container = this.viewDescriptorService.getViewContainerById(ChatViewContainerId);
		if (container) {
			Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).deregisterViewContainer(container);
		}
	}

	/**
	 * Moves the openvs-chat view container to the AuxiliaryBar (secondary
	 * sidebar) if it exists and is still at its default location — the spot
	 * Copilot chat used to occupy. Only relocates a container the user hasn't
	 * already customized, since {@link IViewDescriptorService.moveViewContainerToLocation}
	 * persists the new location; once a relocation succeeds (or is skipped
	 * because the user moved it), stops listening for further container
	 * changes so a later manual move by the user is respected.
	 */
	private relocateOpenVSChatContainer(): void {
		const container = this.viewDescriptorService.getViewContainerById(OPENVS_CHAT_CONTAINER_ID);
		if (!container) {
			return;
		}

		const currentLocation = this.viewDescriptorService.getViewContainerLocation(container);
		const defaultLocation = this.viewDescriptorService.getDefaultViewContainerLocation(container);
		if (currentLocation === defaultLocation && defaultLocation !== ViewContainerLocation.AuxiliaryBar) {
			this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'openvs-chat default placement');
		}

		this.relocateListener.clear();
	}

	/**
	 * Reveals the openvs-chat webview, standing in for the native chat open
	 * command. Kept as a reusable method so other redirects (e.g. menu-based
	 * overrides) can invoke the same behavior. If the openvs-chat extension is
	 * disabled or uninstalled, {@link IViewsService.openView} resolves to
	 * `null`; surface that to the user instead of silently doing nothing.
	 */
	private openOpenVSChatView = async (accessor: ServicesAccessor): Promise<void> => {
		const viewsService = accessor.get(IViewsService);
		const view = await viewsService.openView(OPENVS_CHAT_VIEW_ID, true);
		if (!view) {
			const notificationService = accessor.get(INotificationService);
			notificationService.info(localize('openvsChatUnavailable', "The OpenVS Chat view is unavailable. Check that the openvs-chat extension is installed and enabled."));
		}
	};
}
