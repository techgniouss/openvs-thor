/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Behavioural tests for media/pairing.js (status indicator + "Pair a device" card), mirroring
// scripts/test-prompt-cards.mjs's DOM-stand-in style. Run:
//   node extensions/openvs-chat/scripts/test-pairing-card.mjs
//
// pairing.js is written with the same discipline prompts.js documents: createElement /
// createElementNS + textContent only, no innerHTML, no querySelector — so this stand-in needs
// no HTML parser or selector engine to be faithful, and can be reused nearly verbatim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// ---- Minimal DOM (HTML + SVG), same shape as test-prompt-cards.mjs's El -------------------

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attributes = {};
		this.listeners = {};
		this.value = '';
		this._text = '';
		const classes = new Set();
		this.classList = {
			add: (...names) => names.forEach(n => classes.add(n)),
			remove: (...names) => names.forEach(n => classes.delete(n)),
			contains: name => classes.has(name),
			toggle: (name, force) => {
				const on = force === undefined ? !classes.has(name) : !!force;
				if (on) { classes.add(name); } else { classes.delete(name); }
				return on;
			},
			_all: classes,
		};
	}
	set className(value) {
		this.classList._all.clear();
		for (const name of String(value).split(/\s+/).filter(Boolean)) { this.classList._all.add(name); }
	}
	get className() { return [...this.classList._all].join(' '); }
	set textContent(value) {
		this.children = [];
		this._text = String(value);
	}
	get textContent() {
		return this.children.length ? this.children.map(c => c.textContent).join('') : this._text;
	}
	appendChild(node) { this.children.push(node); return node; }
	setAttribute(name, value) { this.attributes[name] = String(value); }
	getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
	addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
	fire(type, event = {}) { for (const h of this.listeners[type] || []) { h(event); } }
	find(className) {
		if (this.classList.contains(className)) { return this; }
		for (const child of this.children) {
			const hit = child.find(className);
			if (hit) { return hit; }
		}
		return undefined;
	}
	findAll(className) {
		const out = this.classList.contains(className) ? [this] : [];
		for (const child of this.children) { out.push(...child.findAll(className)); }
		return out;
	}
}

/** Loads media/qr.js then media/pairing.js into one shared sandbox, so pairing.js's `OpenVSQr` reference resolves. */
function loadPairing() {
	const qrSource = fs.readFileSync(new URL('../media/qr.js', import.meta.url), 'utf8');
	const pairingSource = fs.readFileSync(new URL('../media/pairing.js', import.meta.url), 'utf8');
	const sandbox = {
		document: {
			createElement: tag => new El(tag),
			createElementNS: (_ns, tag) => new El(tag),
		},
		TextEncoder,
		setInterval,
		clearInterval,
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(qrSource, sandbox, { filename: 'qr.js' });
	vm.runInContext(pairingSource, sandbox, { filename: 'pairing.js' });
	assert.ok(sandbox.OpenVSPairing, 'pairing.js published its namespace');
	return sandbox.OpenVSPairing;
}

const OpenVSPairing = loadPairing();

/** A controller plus the container and the messages it posted. Payloads round-trip through JSON, matching test-prompt-cards.mjs's harness (and real postMessage's structured clone). */
function harness(extraDeps = {}) {
	const container = new El('div');
	const posted = [];
	const api = OpenVSPairing.create({
		container,
		post: m => posted.push(JSON.parse(JSON.stringify(m))),
		...extraDeps,
	});
	return { container, posted, api };
}

const pairing = {
	code: 'ABCD1234',
	expiresAt: Date.now() + 120_000,
	url: 'https://relay.example/p/ROOMROOMROOMROOM#ABCD1234',
};

// 1. On creation, the status indicator (not a card) is rendered immediately as "off", and the
// "Pair a device" button is present. No pairing card yet.
{
	const h = harness();
	assert.strictEqual(h.container.find('remote-status-label').textContent, 'Remote: off');
	assert.ok(h.container.find('remote-status-dot').classList.contains('remote-status-off'));
	assert.ok(h.container.find('remote-actions'), 'the pair button is in its own row, not a dismissable card');
	assert.strictEqual(h.container.findAll('remote-pairing-card').length, 0, 'no card until a pairing code arrives');
}

// 2. Status updates drive the dot class and label text through every state, without ever
// requiring a pairing code.
{
	const h = harness();
	h.api.update({ enabled: true, connected: false });
	assert.strictEqual(h.container.find('remote-status-label').textContent, 'Remote: connecting…');
	assert.ok(h.container.find('remote-status-dot').classList.contains('remote-status-connecting'));

	h.api.update({ enabled: true, connected: true });
	assert.strictEqual(h.container.find('remote-status-label').textContent, 'Remote: connected');
	assert.ok(h.container.find('remote-status-dot').classList.contains('remote-status-connected'));

	h.api.update({ enabled: false, connected: false });
	assert.strictEqual(h.container.find('remote-status-label').textContent, 'Remote: off');
	assert.ok(h.container.find('remote-status-dot').classList.contains('remote-status-off'));
}

// 3. Clicking "Pair a device" asks the host for a code — no client-generated code, no fake QR
// shown before the host actually answers. Creation itself already requested the device list
// once (Phase 7c, see test 10), so that message is expected ahead of the click.
{
	const h = harness();
	assert.deepStrictEqual(h.posted, [{ type: 'listDevices' }], 'creation requests the device list once, up front');
	// mini-button isn't a unique class (Done reuses it later) — find it via the actions row.
	const actions = h.container.find('remote-actions');
	const button = actions.children.find(c => c.className.includes('mini-button'));
	button.fire('click');
	assert.deepStrictEqual(h.posted, [{ type: 'listDevices' }, { type: 'requestPairing' }]);
}

// 4. A `remote` message carrying `pairing` renders the card: QR (as an inline SVG built from
// OpenVSQr, not an <img>/data-URI), the raw code as plain selectable text, and an expiry note.
{
	const h = harness();
	h.api.update({ enabled: true, connected: true, pairing });
	const card = h.container.find('remote-pairing-card');
	assert.ok(card, 'the pairing card is rendered');
	const svg = card.children.find(c => c.tagName === 'SVG');
	assert.ok(svg, 'the QR code is an inline <svg>');
	assert.ok(Number(svg.getAttribute('width')) > 0, 'the QR has real dimensions');
	assert.ok(svg.children.some(c => c.tagName === 'RECT'), 'the QR is built from <rect> modules, not an image');
	assert.strictEqual(card.find('remote-pairing-code').textContent, 'ABCD1234');
	assert.match(card.find('remote-pairing-expiry').textContent, /Expires in \d+s/);
}

// 5. An already-expired code says so immediately, rather than showing a countdown running from
// a negative number.
{
	const h = harness();
	h.api.update({ enabled: true, connected: true, pairing: { ...pairing, expiresAt: Date.now() - 5_000 } });
	assert.strictEqual(h.container.find('remote-pairing-expiry').textContent, 'Expired — request a new code.');
}

// 6. The expiry countdown reads from the injected clock, not the wall clock — so this test
// never has to sleep a real second to prove the math.
{
	let clock = 1_000_000;
	const h = harness({ now: () => clock });
	h.api.update({ enabled: true, connected: true, pairing: { ...pairing, expiresAt: clock + 42_000 } });
	assert.strictEqual(h.container.find('remote-pairing-expiry').textContent, 'Expires in 42s');
}

// 7. Requesting a second code replaces the first card outright — never two stacked cards for
// one pairing flow.
{
	const h = harness();
	h.api.update({ enabled: true, connected: true, pairing });
	h.api.update({ enabled: true, connected: true, pairing: { ...pairing, code: 'WXYZ9999' } });
	assert.strictEqual(h.container.findAll('remote-pairing-card').length, 1, 'only one card at a time');
	assert.strictEqual(h.container.find('remote-pairing-code').textContent, 'WXYZ9999');
}

// 8. "Done" dismisses the card without posting anything — it is a local dismissal, not an
// action the host needs to know about.
{
	const h = harness();
	h.api.update({ enabled: true, connected: true, pairing });
	h.posted.length = 0; // drop creation's own listDevices call — irrelevant to this assertion
	const card = h.container.find('remote-pairing-card');
	const doneButton = card.children.find(c => c.tagName === 'BUTTON' && c.textContent === 'Done');
	doneButton.fire('click');
	assert.strictEqual(h.container.findAll('remote-pairing-card').length, 0, 'the card is gone');
	assert.strictEqual(h.posted.length, 0, 'dismissal never posts to the host');
}

// 9. Model-agnostic here (nothing renders arbitrary text from a model), but the same discipline
// as prompts.js applies: no innerHTML anywhere in the source.
{
	const source = fs.readFileSync(new URL('../media/pairing.js', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /\.innerHTML\s*=/, 'pairing.js never assigns innerHTML');
	// Note: this doesn't grep for the literal string "querySelector" — the file's own header
	// comment mentions it by name when documenting the house rule, which would false-positive.
	assert.doesNotMatch(source, /\.querySelector\(/, 'pairing.js never calls querySelector(...)');
}

// 10. Device list (Phase 7c): a `remote` reply carrying `devices` renders one row per
// non-revoked device (name + relative last-seen); a revoked device is filtered out entirely.
{
	const h = harness();
	const now = Date.now();
	const devices = [
		{ id: 'd1', name: 'Pixel 8', createdAt: now - 1_000, lastSeenAt: now - 60_000, revokedAt: null },
		{ id: 'd2', name: 'Old iPad', createdAt: now - 1_000, lastSeenAt: null, revokedAt: now },
	];
	h.api.update({ enabled: true, connected: true, devices });
	const rows = h.container.findAll('remote-device-row');
	assert.strictEqual(rows.length, 1, 'a revoked device is not shown');
	assert.strictEqual(rows[0].find('remote-device-name').textContent, 'Pixel 8');
	assert.match(rows[0].find('remote-device-lastseen').textContent, /ago$/, 'last-seen renders a relative time');
}

// 10b. An empty device list says so, rather than rendering nothing (indistinguishable from a
// list that hasn't loaded yet).
{
	const h = harness();
	h.api.update({ enabled: true, connected: true, devices: [] });
	assert.ok(h.container.find('remote-device-empty'), 'an empty device list says so');
	assert.strictEqual(h.container.findAll('remote-device-row').length, 0);
}

// 10c. A device with no `lastSeenAt` (never connected since being paired) reads "never", not a
// broken relative time computed from `null`.
{
	const h = harness();
	h.api.update({ enabled: true, connected: true, devices: [{ id: 'd1', name: 'New phone', createdAt: Date.now(), lastSeenAt: null, revokedAt: null }] });
	assert.strictEqual(h.container.find('remote-device-lastseen').textContent, 'never');
}

// 10d. Clicking "Revoke" on a row sends only `revokeDevice` for that specific device — no
// follow-up `listDevices` here. `chatViewProvider.ts`'s `case 'revokeDevice':` now awaits the
// relay's confirmation and pushes the refreshed list back itself (see that handler's own doc);
// this card firing its own immediate `listDevices` right after used to race the revoke it was
// meant to reflect, since those were two independent round trips with no guaranteed order.
{
	const h = harness();
	h.api.update({ enabled: true, connected: true, devices: [{ id: 'd1', name: 'Pixel 8', createdAt: Date.now(), lastSeenAt: null, revokedAt: null }] });
	h.posted.length = 0; // drop the creation-time and update-time listDevices calls already asserted above
	const row = h.container.find('remote-device-row');
	const revokeButton = row.children.find(c => c.tagName === 'BUTTON' && c.textContent === 'Revoke');
	revokeButton.fire('click');
	assert.deepStrictEqual(h.posted, [{ type: 'revokeDevice', deviceId: 'd1' }]);
}

// 10e. "Refresh" re-requests the device list on demand.
{
	const h = harness();
	h.posted.length = 0;
	const refreshButton = h.container.find('remote-device-header').children.find(c => c.tagName === 'BUTTON');
	refreshButton.fire('click');
	assert.deepStrictEqual(h.posted, [{ type: 'listDevices' }]);
}

// 10f. An idle auto-disconnect (Phase 7c) shows a distinct status label — "paused", not an
// ordinary "connecting…" — since `enabled` is still true and nothing here is reconnecting.
{
	const h = harness();
	h.api.update({ enabled: true, connected: false, idleDisabled: true });
	assert.strictEqual(h.container.find('remote-status-label').textContent, 'Remote: paused (idle)');
}

// 11. A `remote` message carrying `error` (requestPairing/listDevices/revokeDevice denials and
// failures — see chatViewProvider.ts's postRemote doc) renders inline in the panel itself,
// hidden until the first one arrives, and clears on a later update that carries none — a stale
// denial must not keep showing once a request actually succeeds.
{
	const h = harness();
	const line = h.container.find('remote-error');
	assert.ok(line, 'the error line exists from creation, even with nothing to show');
	assert.ok(line.classList.contains('hidden'), 'no error yet, so it starts hidden');

	h.api.update({
		enabled: true, connected: false,
		error: 'Remote control is not connected yet — enable it and wait for a connection before pairing a device.',
	});
	assert.strictEqual(line.textContent, 'Remote control is not connected yet — enable it and wait for a connection before pairing a device.');
	assert.ok(!line.classList.contains('hidden'), 'a real error must not stay hidden');

	h.api.update({ enabled: true, connected: true });
	assert.strictEqual(line.textContent, '');
	assert.ok(line.classList.contains('hidden'), 'a cleared error goes back to hidden');
}

console.log('test-pairing-card: all assertions passed');
