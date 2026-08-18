/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
/**
 * The "Remote control" panel in Settings: a persistent connection-status indicator plus a
 * "Pair a device" card (QR code + manually-typeable code + expiry countdown). Phase 5b of
 * "remote control" — see `i-need-your-help-unified-scott.md`'s "Auth" section — replacing the
 * `openvsChat.remotePair` command-palette stopgap.
 *
 * Follows `media/prompts.js`'s house rules exactly, for the same reasons that file states:
 * every node is built with createElement/createElementNS + textContent — no `innerHTML`, no
 * `querySelector` — and dependencies are injected via a `create(deps)` factory, which is what
 * lets `scripts/test-pairing-card.mjs` drive this against a small DOM stand-in with no real
 * browser.
 *
 * Phase 7c adds the device-management section this file used to placeholder: a `listDevices`
 * request fires on load (and on demand via "Refresh"), each row shows a device's name, a
 * relative "last seen" time and a "Revoke" button, and a `revokeDevice { deviceId }` fires on
 * click. Both message types are desktop-only — see `src/remote/policy.ts`'s `REMOTE_DENIED`.
 */
(function () {
	'use strict';

	/**
	 * @typedef {{ code: string, expiresAt: number, url: string }} PairingResult
	 * @typedef {{ id: string, name: string, createdAt: number, lastSeenAt: number|null, revokedAt: number|null }} DeviceInfo
	 * @typedef {{ enabled: boolean, connected: boolean, idleDisabled?: boolean, pairing?: PairingResult, devices?: DeviceInfo[], error?: string }} RemoteStatusPayload
	 */

	/**
	 * @param {string} tag
	 * @param {string} [className]
	 * @param {string} [text]
	 */
	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) { node.className = className; }
		if (text !== undefined) { node.textContent = text; }
		return node;
	}

	/**
	 * Builds an inline SVG rendering of `text`'s QR code (via `media/qr.js`, loaded before this
	 * file — see the script order in `chatViewProvider.ts`'s `getHtml`). One `<rect>` per dark
	 * module plus a white background `<rect>`; no `<image>`, no data URI, no innerHTML.
	 * @param {string} text
	 */
	function buildQrSvg(text) {
		const { size, modules } = OpenVSQr.encode(text);
		const MODULE_PX = 4;
		const QUIET_ZONE_MODULES = 4; // the spec's minimum quiet zone, so a phone camera can find the finder patterns
		const dim = (size + QUIET_ZONE_MODULES * 2) * MODULE_PX;

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`);
		svg.setAttribute('width', String(dim));
		svg.setAttribute('height', String(dim));
		svg.setAttribute('class', 'remote-pairing-qr');
		svg.setAttribute('role', 'img');
		svg.setAttribute('aria-label', 'Pairing QR code');

		const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		background.setAttribute('x', '0');
		background.setAttribute('y', '0');
		background.setAttribute('width', String(dim));
		background.setAttribute('height', String(dim));
		background.setAttribute('fill', '#fff');
		svg.appendChild(background);

		for (let row = 0; row < size; row++) {
			for (let col = 0; col < size; col++) {
				if (!modules[row][col]) {
					continue;
				}
				const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
				rect.setAttribute('x', String((col + QUIET_ZONE_MODULES) * MODULE_PX));
				rect.setAttribute('y', String((row + QUIET_ZONE_MODULES) * MODULE_PX));
				rect.setAttribute('width', String(MODULE_PX));
				rect.setAttribute('height', String(MODULE_PX));
				rect.setAttribute('fill', '#000');
				svg.appendChild(rect);
			}
		}
		return svg;
	}

	/**
	 * Creates the remote-control panel controller.
	 *
	 * @param {{
	 *   container: { appendChild(node: any): void },
	 *   post: (message: any) => void,
	 *   now?: () => number,
	 * }} deps
	 */
	function create(deps) {
		const now = deps.now || (() => Date.now());

		/** @type {{ enabled: boolean, connected: boolean, idleDisabled?: boolean }} */
		let status = { enabled: false, connected: false };
		/** @type {ReturnType<typeof setInterval> | undefined} */
		let countdownTimer;

		// ---- Persistent status indicator: a dot + label, not a card, never dismissed. ----
		const statusRow = el('div', 'remote-status-row');
		const statusDot = el('span', 'remote-status-dot remote-status-off');
		const statusLabel = el('span', 'remote-status-label', 'Remote: off');
		statusRow.appendChild(statusDot);
		statusRow.appendChild(statusLabel);
		deps.container.appendChild(statusRow);

		function renderStatus() {
			statusDot.className = 'remote-status-dot ' + (
				!status.enabled ? 'remote-status-off' : status.connected ? 'remote-status-connected' : 'remote-status-connecting');
			statusLabel.textContent = !status.enabled ? 'Remote: off'
				: status.connected ? 'Remote: connected'
				// Phase 7c: `openvsChat.remote.idleDisableHours` tore the connection down without
				// touching the `enabled` setting — say so, rather than looking like an ordinary drop.
				: status.idleDisabled ? 'Remote: paused (idle)'
				: 'Remote: connecting…';
		}
		renderStatus();

		// ---- Inline error line: denials/failures from requestPairing, listDevices and
		// revokeDevice (see chatViewProvider.ts's postRemote doc for why these route here
		// instead of the generic chat-tab error notice, which is invisible while this panel is
		// open on top of it). Empty and unrendered until the first error arrives. ----
		const errorLine = el('div', 'remote-error hidden');
		deps.container.appendChild(errorLine);

		// ---- "Pair a device" trigger. ----
		const actions = el('div', 'remote-actions');
		const pairButton = el('button', 'mini-button', 'Pair a device');
		pairButton.addEventListener('click', () => {
			deps.post({ type: 'requestPairing' });
		});
		actions.appendChild(pairButton);
		deps.container.appendChild(actions);

		const cardMount = el('div', 'remote-card-mount');
		deps.container.appendChild(cardMount);

		// ---- Paired-device list (Phase 7c): name, relative last-seen, revoke. ----
		const deviceHeader = el('div', 'remote-device-header');
		deviceHeader.appendChild(el('span', 'remote-pairing-title', 'Paired devices'));
		const refreshButton = el('button', 'mini-button', 'Refresh');
		refreshButton.addEventListener('click', () => { deps.post({ type: 'listDevices' }); });
		deviceHeader.appendChild(refreshButton);
		deps.container.appendChild(deviceHeader);

		const deviceList = el('div', 'remote-device-list');
		deps.container.appendChild(deviceList);
		deps.post({ type: 'listDevices' });

		/** Relative last-seen time, mirroring `main.js`'s own `relTime` helper — duplicated, not shared, since this is a separate script with no module boundary between the two. */
		function relDeviceTime(ts) {
			if (!ts) { return 'never'; }
			const min = Math.floor((now() - ts) / 60000);
			if (min < 1) { return 'just now'; }
			if (min < 60) { return `${min}m ago`; }
			const hr = Math.floor(min / 60);
			if (hr < 24) { return `${hr}h ago`; }
			const day = Math.floor(hr / 24);
			if (day < 7) { return `${day}d ago`; }
			return new Date(ts).toLocaleDateString();
		}

		/** @param {DeviceInfo[]} devices */
		function renderDevices(devices) {
			deviceList.textContent = ''; // textContent assignment, not innerHTML — drops any previous rows
			const active = devices.filter(d => d.revokedAt === null);
			if (active.length === 0) {
				deviceList.appendChild(el('div', 'hint remote-device-empty', 'No paired devices yet.'));
				return;
			}
			for (const device of active) {
				const row = el('div', 'remote-device-row');
				row.appendChild(el('span', 'remote-device-name', device.name));
				row.appendChild(el('span', 'remote-device-lastseen', relDeviceTime(device.lastSeenAt)));
				const revokeButton = el('button', 'mini-button', 'Revoke');
				revokeButton.addEventListener('click', () => {
					// No follow-up `listDevices` here: `chatViewProvider.ts`'s `case
					// 'revokeDevice':` now awaits the relay's confirmation and pushes the
					// refreshed list back itself. Firing our own `listDevices` immediately after
					// used to race the revoke it was meant to reflect — two independent round
					// trips with no guaranteed order — and could show this device as still active
					// right after clicking Revoke.
					deps.post({ type: 'revokeDevice', deviceId: device.id });
				});
				row.appendChild(revokeButton);
				deviceList.appendChild(row);
			}
		}

		function clearCountdown() {
			if (countdownTimer !== undefined) {
				clearInterval(countdownTimer);
				countdownTimer = undefined;
			}
		}

		/** @param {PairingResult} pairing */
		function renderPairingCard(pairing) {
			clearCountdown();
			cardMount.textContent = ''; // drops any previous card; textContent assignment, not innerHTML

			const card = el('div', 'remote-pairing-card');
			card.appendChild(el('div', 'remote-pairing-title', 'Pair a device'));
			card.appendChild(el('div', 'hint', 'Scan with the OpenVS PWA, or enter the code by hand.'));
			card.appendChild(buildQrSvg(pairing.url));

			const codeRow = el('div', 'remote-pairing-code', pairing.code);
			card.appendChild(codeRow);

			const expiry = el('div', 'remote-pairing-expiry');
			card.appendChild(expiry);

			function tick() {
				const remainingMs = pairing.expiresAt - now();
				if (remainingMs <= 0) {
					expiry.textContent = 'Expired — request a new code.';
					clearCountdown();
					return;
				}
				expiry.textContent = `Expires in ${Math.ceil(remainingMs / 1000)}s`;
			}
			tick();
			countdownTimer = setInterval(tick, 1000);
			// Node's timer has `.unref()` so a lingering interval never keeps a test process
			// alive; a browser's numeric timer id has no such method, hence the guard.
			if (countdownTimer && typeof (/** @type {any} */ (countdownTimer)).unref === 'function') {
				(/** @type {any} */ (countdownTimer)).unref();
			}

			const doneButton = el('button', 'mini-button', 'Done');
			doneButton.addEventListener('click', () => {
				clearCountdown();
				cardMount.textContent = '';
			});
			card.appendChild(doneButton);

			cardMount.appendChild(card);
		}

		return {
			/**
			 * Applies the host's `remote` message: connection status, and — when this reply is
			 * answering a `requestPairing`/`listDevices` — a freshly minted pairing code or
			 * device list to show.
			 * @param {RemoteStatusPayload} payload
			 */
			update(payload) {
				status = { enabled: !!payload.enabled, connected: !!payload.connected, idleDisabled: !!payload.idleDisabled };
				renderStatus();
				// Cleared on every update that doesn't carry one — a stale denial ("not
				// connected yet") must not keep showing once a request actually succeeds.
				errorLine.textContent = payload.error || '';
				errorLine.classList.toggle('hidden', !payload.error);
				if (payload.pairing) {
					renderPairingCard(payload.pairing);
				}
				if (payload.devices) {
					renderDevices(payload.devices);
				}
			},
		};
	}

	// @ts-ignore — the webview's own namespace, consumed by main.js and the pairing-card tests.
	globalThis.OpenVSPairing = { create };
}());
