/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ACTION_ID_OPEN_CHAT, CHAT_CATEGORY, CHAT_OPEN_ACTION_ID, getOpenChatActionIdForMode } from './actions/chatActions.js';
import { ChatViewContainerId } from './chat.js';
import { ChatMode } from '../common/chatModes.js';

export const openvsChatIcon = registerIcon('openvs-chat', Codicon.zap, localize('openvsChatIcon', "Icon for OpenVS Chat."));

/**
 * Identifier of the openvs-chat sidebar view, kept in sync with the view
 * registration in `extensions/openvs-chat`.
 */
const OPENVS_CHAT_VIEW_ID = 'openvsChat.view';

/**
 * Identifier of the openvs-chat view container, kept in sync with the view
 * container registration in `extensions/openvs-chat`.
 */
const OPENVS_CHAT_CONTAINER_ID = 'workbench.view.extension.openvsChat';
const OPENVS_CHAT_CONTAINER_RAW_ID = 'openvsChat';

/**
 * Identifier of the OpenVS chat toggle — the title-bar button and the Command
 * Palette entry both run this. Deliberately *not* one of the native chat
 * command ids: those are rerouted below, but their actions carry a
 * `ChatContextKeys.enabled` precondition that `chat.disableAIFeatures` turns
 * off, which hides them from the palette and disables their keybindings.
 */
const OPENVS_CHAT_TOGGLE_ACTION_ID = 'workbench.action.openvsChat.toggle';

/**
 * Reveals the openvs-chat webview and focuses it. If the openvs-chat extension
 * is disabled or uninstalled, {@link IViewsService.openView} resolves to
 * `null`; surface that to the user instead of silently doing nothing.
 */
async function openOpenVSChatView(accessor: ServicesAccessor): Promise<void> {
	// Both services are resolved up front: the accessor is only valid
	// synchronously, so nothing may be read off it after the await below.
	const viewsService = accessor.get(IViewsService);
	const notificationService = accessor.get(INotificationService);

	const view = await viewsService.openView(OPENVS_CHAT_VIEW_ID, true);
	if (!view) {
		notificationService.info(localize('openvsChatUnavailable', "The OpenVS Chat view is unavailable. Check that the openvs-chat extension is installed and enabled."));
	}
}

/**
 * Opens the openvs-chat view, or closes it when it is already the visible
 * secondary-side-bar view — the same toggle behavior the native chat button
 * has, so a second click on the title-bar icon puts the editor back to full
 * width.
 */
registerAction2(class ToggleOpenVSChatAction extends Action2 {

	constructor() {
		super({
			id: OPENVS_CHAT_TOGGLE_ACTION_ID,
			title: localize2('openvsChat.toggle', "Open Chat with Agent"),
			category: CHAT_CATEGORY,
			icon: openvsChatIcon,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI }
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		if (viewsService.isViewVisible(OPENVS_CHAT_VIEW_ID)) {
			viewsService.closeView(OPENVS_CHAT_VIEW_ID);
			return;
		}

		await openOpenVSChatView(accessor);
	}
});

// Title-bar chat button. The command center is on by default and hosts the
// button next to the search box (where Copilot's sits); when it is turned off
// the same action falls back to the global title-bar toolbar, mirroring how
// the native chat entry is registered.
MenuRegistry.appendMenuItem(MenuId.CommandCenter, {
	command: {
		id: OPENVS_CHAT_TOGGLE_ACTION_ID,
		title: localize('openvsChat.titleBar', "Chat"),
		icon: openvsChatIcon
	},
	order: 10001
});

MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: {
		id: OPENVS_CHAT_TOGGLE_ACTION_ID,
		title: localize('openvsChat.titleBarFallback', "Chat"),
		icon: openvsChatIcon
	},
	group: 'navigation',
	when: ContextKeyExpr.has('config.window.commandCenter').negate(),
	order: 1
});

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
		@IPaneCompositePartService private readonly paneCompositePartService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
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
			this._register(CommandsRegistry.registerCommand(commandId, openOpenVSChatView));
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

	private getOpenVSChatContainer() {
		return this.viewDescriptorService.getViewContainerById(OPENVS_CHAT_CONTAINER_ID)
			?? this.viewDescriptorService.getViewContainerById(OPENVS_CHAT_CONTAINER_RAW_ID);
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
		const container = this.getOpenVSChatContainer();
		if (!container) {
			return;
		}

		const currentLocation = this.viewDescriptorService.getViewContainerLocation(container);
		const defaultLocation = this.viewDescriptorService.getDefaultViewContainerLocation(container);
		if (currentLocation === defaultLocation && defaultLocation !== ViewContainerLocation.AuxiliaryBar) {
			this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'openvs-chat default placement');
		}

		this.relocateListener.clear();

		this.fillEmptyAuxiliaryBar();
	}

	/**
	 * Opens openvs-chat in the secondary side bar when that bar is showing but
	 * has no active view container.
	 *
	 * The workbench decides what to restore into the secondary side bar during
	 * `initLayout`, long before the extension host starts: with nothing stored
	 * for the workspace it falls back to the location's *default* container,
	 * which upstream is the native chat container — the one
	 * {@link hideNativeChatContainer} deregisters moments later. The restore
	 * then finds nothing to open and the bar renders empty, which is what a
	 * first run in every new workspace would otherwise look like.
	 *
	 * Deliberately narrow: it never reveals a bar the user has hidden, never
	 * displaces a container the user is looking at, and does not take focus —
	 * the editor keeps it on startup.
	 */
	private fillEmptyAuxiliaryBar(): void {
		if (!this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)) {
			return;
		}

		if (this.paneCompositePartService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)) {
			return;
		}

		const container = this.getOpenVSChatContainer();
		if (container) {
			this.paneCompositePartService.openPaneComposite(container.id, ViewContainerLocation.AuxiliaryBar, false);
		}
	}
}
