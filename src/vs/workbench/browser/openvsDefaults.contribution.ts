/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';

/**
 * OpenVS ships a deliberately lean workbench: the editor, git/SCM, debug,
 * terminal, search and extensions, plus the first-party `openvs-chat` panel.
 * Everything else that upstream Code - OSS turns on by default — the native
 * (Copilot-oriented) agent chrome, its sign-in affordances, telemetry, and the
 * first-run/promotional surfaces — is switched off here.
 *
 * These are *default* overrides, the lowest-precedence configuration layer, so
 * a user or workspace setting still wins. Nothing is deleted from the product,
 * which keeps rebasing on `microsoft/vscode` mechanical: the whole opt-out
 * lives in this one file.
 *
 * Deliberately **not** disabled:
 * - the Accounts entry in the activity/title bar — it is how GitHub (and other)
 *   authentication is managed, which git workflows depend on;
 * - `telemetry.feedback.enabled` — it also gates the issue reporter, and
 *   `product.json` points `reportIssueUrl` at the OpenVS tracker;
 * - `workbench.tips.enabled` — the empty-editor watermark is a keyboard-shortcut
 *   affordance, not promotion.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {

		// Native AI chrome. `openvs-chat` is the chat surface in OpenVS; the
		// built-in chat is already rerouted and its view container deregistered
		// by `OpenVSChatRedirectContribution`. These turn off what is left: the
		// title-bar "Sign In" button, the "Open in Agents Window" button, the
		// agent status indicator and unified agents bar in the command center,
		// and the agent-sessions list rendered inside the chat view.
		'chat.disableAIFeatures': true,
		'chat.titleBar.signIn.enabled': false,
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'chat.agentsControl.enabled': 'hidden',
		'chat.unifiedAgentsBar.enabled': false,
		'chat.viewSessions.enabled': false,

		// Telemetry and experimentation. OpenVS defines no telemetry endpoints,
		// so this mainly removes the surrounding UI and the settings-search
		// round trip to a remote service.
		'telemetry.telemetryLevel': 'off',
		'workbench.enableExperiments': false,
		'workbench.settings.enableNaturalLanguageSearch': false,

		// First-run and promotional surfaces.
		'workbench.startupEditor': 'none',
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'extensions.ignoreRecommendations': true,
		'workbench.remoteIndicator.showExtensionRecommendations': false,
		'update.showReleaseNotes': false,
	}
}]);
