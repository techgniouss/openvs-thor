// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// The PWA's core client: pairing-code claim, the envelope protocol (mirrored from
// ../src/protocol.ts — this file ships as a plain browser module with no bundler, so it cannot
// `import` the TypeScript source; the shape is duplicated here by hand and kept honest by
// scripts/test-pwa-contract.mjs), and the `t: 'm'` app-message switch, which is a deliberately
// plain-text port of extensions/openvs-chat/media/main.js's own switch — same message types,
// none of its markdown rendering or rich tool-call formatting. Outbound app messages are
// constructed only from `REMOTE_ALLOWED` types (extensions/openvs-chat/src/remote/policy.ts);
// this file also duplicates that list by hand, and the contract test checks the two stay equal.
'use strict';

import { render as renderTranscript, appendNotice, renderTodos, appendAutoSummary } from './transcript.js';
import { create as createCards } from './cards.js';

// ---- Envelope protocol (mirrors ../src/protocol.ts) ------------------------------------------

/**
 * @typedef {{ v: 1, t: 'm' | 'c' | 'a', seq: number, ack?: number, p?: any }} Envelope
 */

const HEARTBEAT_INTERVAL_MS = 25_000;
/**
 * How long a `ping` is allowed to go unanswered before it counts as missed. Mirrors
 * `extensions/openvs-chat/src/remote/socket.ts`'s `RemoteSocket` (the *host*'s own client to
 * this same relay) exactly — including its "2 missed pongs" threshold below — which already
 * has this staleness check; this file, the mobile-facing side of the same protocol and the one
 * actually prone to a backgrounded tab zombying its socket, never did.
 */
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Consecutive failed reconnect attempts (never reaching `open`) before the status line stops
 * just saying "Reconnecting…" and starts hinting this might be a revocation, not an outage — see
 * `connect()`'s `close` handler doc for why a revoked-while-disconnected device can't be told
 * apart from an ordinary network drop from the close event alone. Below this threshold, a normal
 * blip (elevator, tunnel, backgrounded app) shouldn't get an alarming message; above it, a device
 * that keeps failing to even complete the WebSocket upgrade — which is exactly what `/ws/client`
 * rejecting a revoked token looks like from here — has been retrying for roughly 10-15 seconds
 * (the sum of the first three backoff delays: ~1s + ~2s + ~4s, before jitter), which is enough
 * repeated failure that the user deserves more than a spinner that will never resolve on its own.
 */
const REVOKE_HINT_AFTER_FAILURES = 4;
/** Mirrors `../src/room.ts`'s `DEVICE_REVOKED_CLOSE_CODE` — the close code the relay uses on a live socket when the host revokes this device, so the `close` handler below can tell "revoked, stop retrying" apart from an ordinary drop that's worth reconnecting from. */
const DEVICE_REVOKED_CLOSE_CODE = 4001;

// ---- Image attachments (Phase 6c) -------------------------------------------------------------
//
// `resizeImageForUpload`/`uploadImage` below are a hand-copied, PWA-side take on
// extensions/openvs-chat/media/main.js's own `resizeImage`/`pendingImages` pipeline — same
// approach (FileReader + <canvas>, downscale to a long-edge cap, re-encode as JPEG), kept as an
// independent copy per this file's established cross-package duplication pattern (see the
// top-of-file doc) rather than a shared import, since a plain browser module here cannot import
// from the extension's TypeScript sources anyway. Unlike the desktop webview, this PWA cannot
// paste/drop into a native file input, so the image goes to the host over `attachImage`'s
// chunked-upload channel instead of a local `pendingImages` array — see
// extensions/openvs-chat/src/remote/attachments.ts for the host-side reassembly and the real
// size ceilings (8MB/upload, 32MB/session) that actually bound this, not anything below.
const MAX_IMAGE_DIM = 1568; // Matches media/main.js's own cap — a sane default everywhere.
/** Base64 *text* characters per `attachImage` chunk (not raw bytes) — slices of one already-encoded string, per the plan's "64KB base64 chunks". */
const ATTACH_CHUNK_CHARS = 64 * 1024;

// ---- DOM shell -----------------------------------------------------------------------------

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

const els = {
	status: document.getElementById('status'),
	tabs: document.getElementById('tabs'),
	messages: document.getElementById('messages'),
	todos: document.getElementById('todos'),
	composer: /** @type {HTMLTextAreaElement} */ (document.getElementById('composer')),
	sendBtn: document.getElementById('sendBtn'),
	stopBtn: document.getElementById('stopBtn'),
	newSessionBtn: document.getElementById('newSessionBtn'),
	enhanceBtn: document.getElementById('enhanceBtn'),
	modeSelect: /** @type {HTMLSelectElement} */ (document.getElementById('modeSelect')),
	providerSelect: /** @type {HTMLSelectElement} */ (document.getElementById('providerSelect')),
	modelSelect: /** @type {HTMLSelectElement} */ (document.getElementById('modelSelect')),
	skillsList: document.getElementById('skillsList'),
	contextChip: document.getElementById('contextChip'),
	queueChips: document.getElementById('queueChips'),
	attachImageInput: /** @type {HTMLInputElement} */ (document.getElementById('attachImageInput')),
	attachImageBtn: document.getElementById('attachImageBtn'),
	attachActiveBtn: document.getElementById('attachActiveBtn'),
	pairForm: document.getElementById('pairForm'),
	pairCode: /** @type {HTMLInputElement} */ (document.getElementById('pairCode')),
	pairError: document.getElementById('pairError'),
	app: document.getElementById('app'),
	pairScreen: document.getElementById('pairScreen'),
};

const cards = createCards({ container: els.messages, post: sendApp });

// ---- Connection state ------------------------------------------------------------------------

let ws = null;
let outSeq = 0;
/** @type {number | undefined} */
let heartbeatTimer;
/** @type {number | undefined} */
let pongTimeoutTimer;
let awaitingPong = false;
let missedPongs = 0;
let reconnectDelayMs = RECONNECT_MIN_MS;
/** Consecutive `close` events without an intervening `open` — see `REVOKE_HINT_AFTER_FAILURES`'s own doc. Reset to 0 the moment a connection actually opens. */
let consecutiveReconnectFailures = 0;
let roomId = '';
let deviceToken = '';

/** @type {any[]} */
let sessions = [];
let activeSessionId = '';
let providers = [];
let selectedProvider = '';
/** @type {Record<string, any[]>} */
let fetchedModels = {};
/**
 * The `{ provider, model }` this device most recently asked the host to switch to, held until
 * a `config` message confirms it (or the provider changes again) — see `renderModelSelect`'s
 * doc for why this exists: over the relay's real network round trip a `models` catalog refresh
 * (`listModels`, kicked off by this same provider switch, or an unrelated `postConfig` on the
 * host) can land *after* the user's pick but *before* the `config` that confirms it, and would
 * otherwise reset the dropdown back to the pre-pick model out from under them.
 * @type {{provider: string, model: string} | null}
 */
let pendingModel = null;
/**
 * Per-session queue edits this device has made locally but the host hasn't yet confirmed via a
 * `sessions` snapshot that actually reflects them — same problem `pendingModel` solves for the
 * model picker, applied to `session.queue`: `case 'sessions':` preserves a session's `.messages`
 * across a rebuild but has no such protection for `.queue`, so an edit still in flight (or lost
 * to a disconnect before it reached the host) was silently overwritten by whatever queue the
 * host's snapshot carried — reconnecting could make a just-queued or just-removed follow-up
 * reappear/vanish out from under the user. Also replayed on reconnect (`case 'welcome':`) for
 * an edit that never reached the host at all before the socket dropped.
 * @type {Map<string, string[]>}
 */
let pendingQueues = new Map();
let skillsCatalog = [];
/**
 * The current `attachContext`/`attachActive` reply, awaiting the next `send` — mirrors
 * media/main.js's own `currentContext`. Set from a `context` message, cleared once actually
 * sent (or removed via the chip's own ✕).
 * @type {{label: string, content: string} | null}
 */
let attachedContext = null;

// ---- Storage (bearer-token-only for this phase; the non-extractable ECDSA key binding from
// the plan's Auth step 5 is Phase 7 work, tracked in src/room.ts's upgradeClient comment) -------

function storageKey(room) {
	return `openvsRelay.device.${room}`;
}

function loadDevice(room) {
	try {
		const raw = localStorage.getItem(storageKey(room));
		return raw ? JSON.parse(raw) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Remembers which room this browser most recently paired to, so a launch that carries no room
 * of its own (see {@link loadLastRoom}'s doc) can still recover an existing pairing instead of
 * always landing back on the pairing screen.
 */
const LAST_ROOM_KEY = 'openvsRelay.lastRoom';

function saveDevice(room, device) {
	try {
		localStorage.setItem(storageKey(room), JSON.stringify(device));
		// Every successful pairing is "the most recent one" — recorded here, the one place a
		// device actually gets persisted, rather than at each call site that happens to know a
		// room id, so this can never drift out of sync with what {@link loadDevice} would find.
		localStorage.setItem(LAST_ROOM_KEY, room);
	} catch {
		// Storage can be unavailable (private browsing, quota) — pairing simply has to be
		// redone next visit; nothing here is safety-critical to persist.
	}
}

/**
 * The room this browser most recently paired to, or `''` if none/unavailable. `boot()`'s
 * {@link parseLocation} falls back to this when the launch URL carries no room of its own —
 * critically, the *installed* PWA's own icon: `manifest.webmanifest`'s `start_url` is the fixed
 * `"/"`, not the `/p/<roomId>#<code>` URL pairing actually happened at, so without this every
 * launch from the home-screen icon parsed an empty `roomId`, found nothing under `storageKey('')`
 * and showed the pairing screen again — every single time — even though the device was already
 * paired and its real token was sitting in storage under the room it actually paired to. A
 * bookmarked or shared plain `/pair` link with no room is the one case this is *not* wanted; those
 * still explicitly carry `?room=` and take precedence in `parseLocation` regardless.
 */
function loadLastRoom() {
	try {
		return localStorage.getItem(LAST_ROOM_KEY) || '';
	} catch {
		return '';
	}
}

// ---- Service worker auth handoff (Phase 6b: web push triggers) -------------------------------
//
// `sw.js`'s `readActiveAuth()` needs the active device token + room id to authenticate its own
// `/api/pending` fetch when it wakes on a payload-less push — a service worker cannot reach
// `localStorage`. Written to IndexedDB, which a service worker *can* read directly and which
// survives the worker being evicted and restarted between pushes (unlike an in-memory value
// cached only from a `message` event). Also `postMessage`d to an already-running worker as an
// immediate, best-effort update; `sw.js` persists that into the same IndexedDB store on receipt,
// so either path — a direct write from here, or a relayed one via the worker — lands in the one
// place `readActiveAuth()` reads from. `sw.js` hand-duplicates the constants and open/write
// helpers below (a classic, non-module service worker script can't `import` this file) — the
// same cross-boundary duplication this file already does for the wire protocol itself.
const AUTH_DB_NAME = 'openvs-relay-auth';
const AUTH_DB_VERSION = 1;
const AUTH_STORE_NAME = 'auth';
const AUTH_RECORD_KEY = 'active';

/** @returns {Promise<IDBDatabase>} */
function openAuthDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(AUTH_DB_NAME, AUTH_DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(AUTH_STORE_NAME)) {
				req.result.createObjectStore(AUTH_STORE_NAME);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Writes `{room, token}` to the shared auth store, then — for an already-running service worker
 * — also posts it directly so a live worker doesn't have to wait for a restart to see it.
 * Best-effort throughout: IndexedDB and `serviceWorker.ready` can each fail or be unavailable the
 * same way `localStorage` can (private browsing, an old browser, no worker registered yet), and
 * a push arriving before any of this succeeds still falls back to `sw.js`'s generic notification.
 * @param {string} room
 * @param {string} token
 */
async function syncAuthToServiceWorker(room, token) {
	try {
		const db = await openAuthDb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(AUTH_STORE_NAME, 'readwrite');
			tx.objectStore(AUTH_STORE_NAME).put({ room, token }, AUTH_RECORD_KEY);
			tx.oncomplete = () => resolve(undefined);
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		// See this function's doc — not fatal, sw.js's own read just misses this update.
	}
	if (!('serviceWorker' in navigator)) { return; }
	try {
		const registration = await navigator.serviceWorker.ready;
		if (registration.active) {
			registration.active.postMessage({ type: 'auth', room, token });
		}
	} catch {
		// No controller yet, or the worker isn't ready — the IndexedDB write above still stands.
	}
}

/** Registers `/sw.js`, if this browser supports service workers at all. Idempotent — a second registration for the same script/scope is a no-op per the spec. */
function registerServiceWorker() {
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.register('/sw.js').catch(() => { /* offline-support is best-effort */ });
	}
}

// ---- Pairing claim ------------------------------------------------------------------------

/**
 * Exchanges a pairing code for a device token via POST /pair/claim (plan's Auth step 4).
 * @param {string} room
 * @param {string} code
 */
async function claim(room, code) {
	const res = await fetch(`/pair/claim?room=${encodeURIComponent(room)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ code, name: 'OpenVS Remote (PWA)' }),
	});
	if (!res.ok) {
		// `room.ts`'s handlePairClaim responds with a plain-text reason (`code expired`, `invalid
		// or already-used code`, `too many attempts`, `signup key required`), not JSON — surface
		// it verbatim rather than collapsing every 4xx/5xx into the same opaque status code, which
		// made "expired" and "already used" and "wrong signup key" all read identically here.
		const reason = await res.text().catch(() => '');
		throw new Error(reason || `pairing failed (${res.status})`);
	}
	const body = await res.json();
	saveDevice(room, { deviceId: body.deviceId, token: body.token });
	// Fire-and-forget, not awaited: `syncAuthToServiceWorker` is explicitly best-effort (see its
	// own doc) and — critically — `navigator.serviceWorker.ready` never rejects or times out on
	// its own. On a first-ever pairing no service worker has registered yet at this point
	// (`registerServiceWorker()` only runs after `claim()` returns, further down in both
	// callers), so `.ready` waits for a controller that will never arrive and `await`ing it here
	// hung the entire pairing flow forever — no error, no UI change, exactly "click Pair, nothing
	// happens". Letting it run in the background costs nothing: a push arriving before it finishes
	// (or fails) still falls back to `sw.js`'s generic notification, same as this function's own
	// doc already says for every other failure mode here.
	void syncAuthToServiceWorker(room, body.token);
	return body.token;
}

// ---- Wire send helpers ----------------------------------------------------------------------

/**
 * Wraps `payload` in a `t: 'm'` envelope and sends it. Every call site below must construct a
 * `type` that appears in {@link REMOTE_ALLOWED} — see this file's own top-of-file doc.
 * @param {Record<string, unknown> & { type: string }} payload
 */
/** @returns {boolean} whether the frame actually went out — callers that clear UI state (composer text, chips, …) on send must check this instead of assuming success (see `sendMessage`). */
function sendApp(payload) {
	if (!ws || ws.readyState !== WebSocket.OPEN) { return false; }
	outSeq += 1;
	ws.send(JSON.stringify({ v: 1, t: 'm', seq: outSeq, p: payload }));
	return true;
}

/** @param {Record<string, unknown> & { c: string }} frame */
function sendControl(frame) {
	if (!ws || ws.readyState !== WebSocket.OPEN) { return; }
	outSeq += 1;
	ws.send(JSON.stringify({ v: 1, t: 'c', seq: outSeq, p: frame }));
}

/**
 * The exact set of `extensions/openvs-chat/src/remote/policy.ts`'s `REMOTE_ALLOWED` array,
 * copied by hand. `scripts/test-pwa-contract.mjs` asserts every type this file actually sends is
 * both in this list AND in the real `REMOTE_ALLOWED` — so a drift between the two fails loudly
 * instead of silently letting the phone send a message the relay's own policy would reject.
 */
const REMOTE_ALLOWED = [
	'ready', 'send', 'promptResponse', 'stop', 'stopAll', 'setProvider', 'setModel', 'listModels',
	'listSkills', 'setSkill', 'toggleSkill', 'listMcp', 'enhancePrompt', 'steer', 'createSession',
	'switchSession', 'closeSession', 'clearSession', 'restoreSession', 'setMode', 'setQueue',
	'sync', 'fetchTranscript', 'slash', 'attachActive', 'attachImage',
];
void REMOTE_ALLOWED; // referenced by the contract test via source text, not by import

// ---- Session helpers --------------------------------------------------------------------------

function activeSession() {
	return sessions.find(s => s.id === activeSessionId);
}

function sessionFor(msg) {
	return sessions.find(s => s.id === msg.sessionId) || (msg.sessionId ? undefined : activeSession());
}

// ---- Rendering ---------------------------------------------------------------------------------

function renderTabs() {
	if (!els.tabs) { return; }
	els.tabs.replaceChildren();
	for (const session of sessions) {
		// A wrapper div, not a button: it holds two independently-clickable controls
		// (switch, close), and a button can't nest a button per HTML's interactive-content rule.
		const classes = ['tab', session.id === activeSessionId ? 'tab-active' : '', session.streaming ? 'tab-streaming' : ''];
		const tab = el('div', classes.filter(Boolean).join(' '));
		if (session.streaming) {
			// A run can be going in a *background* tab — nothing else in this tab strip would show
			// it, since `renderAll()` (the transcript/stop-button/etc. refresh) only ever runs for
			// the active session. This dot is what answers "is anything happening in one of my
			// other chats right now" without switching to look, mirrors the desktop panel's own
			// spinner-per-tab, and is what makes `switchSession` below worth reaching for.
			tab.appendChild(el('span', 'tab-spinner', '●'));
		}
		// A real <button>, not a <span>: the old single-element tab was itself a <button> and
		// so was keyboard-focusable/Enter-activatable — splitting it into title+close must not
		// silently drop that for the switch half.
		const title = el('button', 'tab-title', session.title || 'Chat');
		title.type = 'button';
		title.addEventListener('click', () => switchSession(session.id));
		const close = el('button', 'tab-close', '✕');
		close.type = 'button';
		close.title = 'Close chat';
		close.addEventListener('click', (e) => {
			e.stopPropagation();
			closeSession(session.id);
		});
		tab.appendChild(title);
		tab.appendChild(close);
		els.tabs.appendChild(tab);
	}
}

/**
 * Whether the messages pane should auto-scroll to the bottom after the next render — a plain
 * `replaceChildren()` rebuild (see `transcript.js`'s `render`) resets `scrollTop` to 0 on every
 * single token, which without this reads as "the chat won't stay scrolled down", the opposite of
 * every native messaging app. Tracked rather than unconditional so a user who has scrolled up to
 * reread earlier turns mid-stream isn't yanked back down on the next token — see the `scroll`
 * listener below, which is what keeps this honest.
 */
let stickToBottom = true;
/** Distance (px) from the true bottom still counted as "at the bottom" — matches the small rubber-band slop touch scrolling leaves even when a user meant to land at the end. */
const STICK_BOTTOM_THRESHOLD_PX = 48;

if (els.messages) {
	els.messages.addEventListener('scroll', () => {
		const el = els.messages;
		stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_THRESHOLD_PX;
	});
}

function renderAll() {
	const session = activeSession();
	if (!session || !els.messages) { return; }
	renderTranscript(els.messages, session);
	if (stickToBottom) {
		els.messages.scrollTop = els.messages.scrollHeight;
	}
	if (els.todos) {
		renderTodos(els.todos, session.todos || []);
	}
	if (els.modeSelect) { els.modeSelect.value = session.mode || 'ask'; }
	if (els.stopBtn) { els.stopBtn.hidden = !session.streaming; }
	renderQueueChips();
}

function renderProviderSelect() {
	if (!els.providerSelect) { return; }
	els.providerSelect.replaceChildren();
	for (const provider of providers) {
		const opt = el('option', undefined, provider.label || provider.id);
		opt.setAttribute('value', provider.id);
		els.providerSelect.appendChild(opt);
	}
	els.providerSelect.value = selectedProvider;
}

function renderModelSelect() {
	if (!els.modelSelect) { return; }
	els.modelSelect.replaceChildren();
	const p = providers.find(x => x.id === selectedProvider);
	const seen = new Set();
	const addOption = id => {
		if (!id || seen.has(id)) { return; }
		seen.add(id);
		const opt = el('option', undefined, id);
		opt.setAttribute('value', id);
		els.modelSelect.appendChild(opt);
	};
	// `p.model` is the provider's actual configured model (kept in sync with `setModel` — see
	// `case 'config':` above), so it's added even before the live catalog arrives; without this
	// the freshly rendered <select> had no matching <option> and defaulted to whatever the
	// browser picks (its first option, or '' with none yet) instead of the model that's actually
	// selected — media/main.js's own `renderModelSelect` does the same thing for this reason.
	if (p && p.model) { addOption(p.model); }
	// A pick this device made but the host hasn't confirmed via `config` yet (see `pendingModel`'s
	// own doc) wins over `p.model` below — otherwise a `models` catalog refresh landing in that
	// gap (this same provider switch's own `listModels` call, or an unrelated `postConfig`
	// elsewhere) rebuilds this list and resets the selection back to the pre-pick model, which
	// over a phone's real network latency is common enough to read as "my pick never sticks".
	const effective = (pendingModel && pendingModel.provider === selectedProvider) ? pendingModel.model : (p && p.model);
	if (effective) { addOption(effective); }
	// The live-fetched catalog (`fetchedModels`) is the ideal source, but it can take a real
	// network round trip (this provider's `/models` endpoint, not just the relay) to arrive —
	// media/main.js's own renderModelSelect falls back to the provider's `suggestedModels` while
	// nothing has been fetched yet, and this one has to too: without it, right after a provider
	// switch the dropdown has exactly one option (the just-received default) until that fetch
	// lands, so picking anything else isn't possible yet — which reads exactly like "my selection
	// keeps reverting to the default", when really there was nothing else to select.
	const live = fetchedModels[selectedProvider];
	for (const model of (live && live.length) ? live : (p && p.suggestedModels) || []) {
		addOption(typeof model === 'string' ? model : model.id);
	}
	if (effective) { els.modelSelect.value = effective; }
}

function renderSkills() {
	if (!els.skillsList) { return; }
	els.skillsList.replaceChildren();
	for (const skill of skillsCatalog) {
		const row = el('label', 'skill-row');
		const checkbox = /** @type {HTMLInputElement} */ (el('input'));
		checkbox.setAttribute('type', 'checkbox');
		checkbox.checked = !!skill.active;
		// Field name must be `text`, not `id` — `chatViewProvider.ts`'s `case 'toggleSkill':` reads
		// `message.text` (see `media/main.js`'s own `{ type: 'toggleSkill', text: skill.id }`,
		// the desktop's real wire shape). Sending `id` instead meant `message.text` was always
		// `undefined`, `toggleSkill('')` always missed, and every attempt answered "Unknown
		// skill:" with an empty name. `toggleSkill` itself flips current-state on the host, not a
		// caller-supplied boolean, so `checkbox.checked` was never read either — dropped, not
		// renamed.
		checkbox.addEventListener('change', () => sendApp({ type: 'toggleSkill', text: skill.id }));
		row.appendChild(checkbox);
		row.appendChild(el('span', 'skill-name', skill.name || skill.id));
		els.skillsList.appendChild(row);
	}
}

/** Renders the pending `attachedContext` as a removable chip above the composer, or hides it. */
function renderContextChip() {
	if (!els.contextChip) { return; }
	els.contextChip.replaceChildren();
	if (!attachedContext) {
		els.contextChip.hidden = true;
		return;
	}
	els.contextChip.hidden = false;
	els.contextChip.appendChild(el('span', undefined, `📎 ${attachedContext.label || 'context'}`));
	const remove = el('button', undefined, '✕');
	remove.addEventListener('click', () => { attachedContext = null; renderContextChip(); });
	els.contextChip.appendChild(remove);
}

/**
 * Mirrors the host's copy of a session's queue (see `setQueue`'s doc for why the host needs its
 * own copy at all) — a wholesale replace, like `src/session/store.ts`'s own `setQueue`, so a
 * chip removed locally can't race a host-side incremental push into a different order.
 * @param {any} session
 */
function persistQueue(session) {
	const queue = (session.queue || []).slice();
	// Marked pending *before* the send attempt, not just on failure — a `sendApp` that
	// genuinely goes out can still have its `config`/`sessions` confirmation lost to a drop
	// that happens moments later; `case 'sessions':` clears this once the host actually
	// confirms it, same as `pendingModel`'s equivalent guard.
	pendingQueues.set(session.id, queue);
	sendApp({ type: 'setQueue', sessionId: session.id, queue });
}

/** Shallow string-array equality — used to tell a `sessions` snapshot's queue apart from a still-unconfirmed local edit (see `pendingQueues`'s own doc). */
function sameQueue(a, b) {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) { return false; }
	}
	return true;
}

/** Renders the active session's queued follow-ups as removable chips above the composer — mirrors media/main.js's own `renderQueueChips`. */
function renderQueueChips() {
	if (!els.queueChips) { return; }
	const session = activeSession();
	els.queueChips.replaceChildren();
	const queue = (session && session.queue) || [];
	if (!queue.length) {
		els.queueChips.hidden = true;
		return;
	}
	els.queueChips.hidden = false;
	queue.forEach((text, index) => {
		const chip = el('span', 'queue-chip');
		chip.title = text;
		chip.appendChild(el('span', 'queue-chip-text', `⏳ ${text}`));
		const remove = el('button', undefined, '✕');
		remove.addEventListener('click', () => {
			session.queue.splice(index, 1);
			persistQueue(session);
			renderQueueChips();
		});
		chip.appendChild(remove);
		els.queueChips.appendChild(chip);
	});
}

function setStatus(text, className) {
	if (!els.status) { return; }
	els.status.textContent = text;
	els.status.className = `status ${className || ''}`.trim();
}

// ---- Outbound actions (each type here must be in REMOTE_ALLOWED) ------------------------------

/**
 * Echoes `text` into `session`'s transcript as a user turn and re-renders if it's the visible
 * tab — the host never posts the user's own message back (it only streams the *reply*), so
 * every path that actually delivers a turn (an ordinary send, a drained queue entry, a bounced
 * steer falling back to a real send) needs this, same as media/main.js's own `sendText`/`steer`
 * do inline. Shared here rather than duplicated per caller.
 * @param {any} session
 * @param {string} text
 */
function echoUserTurn(session, text) {
	(session.messages = session.messages || []).push({ role: 'user', content: text });
	if (session.id === activeSessionId) {
		// Sending (or steering) a turn always lands the view on it, the same as every native
		// chat app — even if the user had scrolled up to reread something first.
		stickToBottom = true;
		renderAll();
	}
}

/**
 * Sends `text` as a new turn in `session` right now — the shared path behind the composer's own
 * (non-streaming) send, a queue entry drained on `done`, and a bounced steer that falls back to
 * an immediate send once its run has actually ended (see `case 'steerRejected'`). `modeOverride`
 * lets a drain/bounce resend in the run's own `runMode` rather than whatever the mode dropdown
 * currently shows, which may have changed since — mirrors media/main.js's own queue drain.
 * @param {any} session
 * @param {string} text
 * @param {string} [modeOverride]
 * @returns {boolean} whether the frame actually went out — see `sendApp`'s own doc.
 */
function dispatchSend(session, text, modeOverride) {
	// `provider`/`model` must be sent explicitly, same as `media/main.js` always does (see
	// its own `send` payload) — `handleSend`'s fallback (`message.provider ||
	// registry.getDefaultProviderId()`) only kicks in when they're absent, and this used to
	// always omit them, so picking a provider/model here only ever worked by way of a shared
	// *global* setting (`setProvider`/`setModel`'s `openvsChat.defaultProvider`/`<id>.model`)
	// that anything else touching those settings — the desktop webview included, which never
	// writes them itself — could leave stale. Sending them directly is what the desktop
	// already does and is the only way this client's own dropdowns reliably drive its own runs.
	//
	// `attachedContext` is only ever meant for whatever the user is *actively* composing —
	// this function is now also the queue-drain and steer-bounce path (both of which can fire
	// for a *background* session, e.g. a different tab's run finishing while the user is
	// looking at and attaching context to another one entirely). Scoping it to the active
	// session avoids two bugs a global read here would otherwise cause: a background session's
	// queued follow-up silently picking up context the user attached for a completely
	// different chat, and — worse — that background send then clearing the chip out from under
	// context the user is still actively composing with in the tab they're looking at.
	const isActiveSend = session.id === activeSessionId;
	const context = isActiveSend ? attachedContext : undefined;
	const ok = sendApp({
		type: 'send', sessionId: session.id, text, mode: modeOverride || session.mode || 'ask',
		provider: selectedProvider, model: els.modelSelect ? els.modelSelect.value : '',
		...(context ? { context } : {}),
	});
	if (!ok) { return false; }
	echoUserTurn(session, text);
	if (isActiveSend) {
		attachedContext = null;
		renderContextChip();
	}
	return true;
}

/**
 * True if `text` was consumed as a leading-slash command, forwarded to the host's `slash`
 * dispatch (`extensions/openvs-chat/src/session/slash.ts`'s `runSlash`) instead of an ordinary
 * `send` — a plain-text port of `media/main.js`'s own `handleSlash`. Checked, like there, *before*
 * the streaming steer-vs-queue decision below: `/clear`, `/mode`, `/skill`, … must act immediately
 * even mid-run, not get queued behind whatever the current run is doing. `/history` and `/enhance`
 * stay client-owned on the desktop (a UI panel and a composer prefill, respectively) — this shell
 * has no history panel yet (see `case 'history':`'s own doc) and `/enhance` already has its own
 * ✨ button, so both are simply left to fall through to the host's "unrecognized — forward as an
 * ordinary message" fallback, exactly as an unrecognized command like `/foo` already does.
 * @param {any} session
 * @param {string} text
 * @returns {boolean}
 */
function handleSlash(session, rawText) {
	const text = rawText.trim();
	if (!/^\/\w+/.test(text)) { return false; }
	if (/^\/clear\b/i.test(text)) {
		// Composer attachments are client-only UI state; the host owns archiving/resetting the
		// session itself (`SessionStore.clearSession`, reached via `slash` below) — mirrors
		// `media/main.js`'s own `/clear` handling.
		attachedContext = null;
		renderContextChip();
	}
	// The host appends this turn to the session store itself and broadcasts the resulting
	// `sessions`/`transcript` update to every connected sink (see `sendFollowUp`/each
	// `SlashEffects` callback in `chatViewProvider.ts`) — unlike `dispatchSend`, this must not
	// also echo the turn locally, or it would show twice once that broadcast arrives.
	sendApp({ type: 'slash', sessionId: session.id, command: text });
	return true;
}

function sendMessage() {
	const session = activeSession();
	if (!session || !els.composer) { return; }
	const text = els.composer.value;
	if (!text.trim()) { return; }
	if (handleSlash(session, text)) {
		els.composer.value = '';
		return;
	}
	if (session.streaming) {
		// Mid-run input: steer a live agent run, queue for anything else — mirrors
		// media/main.js's own `send()` decision (`s.runMode === 'agent' && s.steerable !== false`).
		if (session.runMode === 'agent' && session.steerable !== false) {
			const ok = sendApp({ type: 'steer', sessionId: session.id, runId: session.runId, text });
			// `sendApp` silently no-ops while the socket isn't OPEN (e.g. a reconnect in flight
			// after the phone was backgrounded) — bail out before touching any UI state so the
			// text stays in the composer and the user knows to wait for "Connected" and retry,
			// instead of believing it went out.
			if (!ok) {
				if (els.messages) { appendNotice(els.messages, 'notice-error', '⚠ Not connected — message not sent. It will stay in the composer; try again once reconnected.'); }
				return;
			}
			echoUserTurn(session, text);
			els.composer.value = '';
			return;
		}
		// Not steerable right now (no agent loop, or the host said this run can't be): queue it
		// instead — sent once this session's current run finishes (see the `done` handler's own
		// drain) — rather than delivering it into a run that has nothing steering to receive it.
		// Not echoed into the transcript: nothing has actually been sent yet, only queued —
		// the chip above the composer is what shows it is pending.
		(session.queue = session.queue || []).push(text);
		persistQueue(session);
		renderQueueChips();
		els.composer.value = '';
		return;
	}
	if (!dispatchSend(session, text)) {
		if (els.messages) { appendNotice(els.messages, 'notice-error', '⚠ Not connected — message not sent. It will stay in the composer; try again once reconnected.'); }
		return;
	}
	els.composer.value = '';
}

/**
 * Reads an image File, downscales it to at most {@link MAX_IMAGE_DIM} on its long edge,
 * re-encodes as JPEG, and resolves a base64 payload — see this file's "Image attachments"
 * section doc for how this relates to media/main.js's own `resizeImage`.
 * @param {File} file
 * @returns {Promise<{mimeType: string, data: string}>}
 */
function resizeImageForUpload(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error || new Error('Failed to read image.'));
		reader.onload = () => {
			const img = new Image();
			img.onerror = () => reject(new Error('Failed to decode image.'));
			img.onload = () => {
				let width = img.naturalWidth;
				let height = img.naturalHeight;
				const longEdge = Math.max(width, height);
				if (longEdge > MAX_IMAGE_DIM) {
					const scale = MAX_IMAGE_DIM / longEdge;
					width = Math.round(width * scale);
					height = Math.round(height * scale);
				}
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('Canvas unavailable.')); return; }
				ctx.drawImage(img, 0, 0, width, height);
				const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
				resolve({ mimeType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
			};
			img.src = /** @type {string} */ (reader.result);
		};
		reader.readAsDataURL(file);
	});
}

/**
 * Resizes `file` client-side, then ships it to the host as a chunked `attachImage` upload:
 * {@link ATTACH_CHUNK_CHARS}-character slices of the already-base64-encoded image, so
 * reassembly on the host is plain concatenation (see `UploadAssembler`'s doc). The resize here
 * is a courtesy for well-behaved uploads, not a security boundary — the host enforces the real
 * per-upload/per-session ceilings regardless of what this function sends.
 * @param {File} file
 */
async function uploadImage(file) {
	const session = activeSession();
	if (!session) { return; }
	let resized;
	try {
		resized = await resizeImageForUpload(file);
	} catch (err) {
		if (els.messages) { appendNotice(els.messages, 'notice-error', `Could not attach image: ${err instanceof Error ? err.message : String(err)}`); }
		return;
	}
	const uploadId = crypto.randomUUID();
	const total = Math.max(1, Math.ceil(resized.data.length / ATTACH_CHUNK_CHARS));
	for (let index = 0; index < total; index++) {
		sendApp({
			type: 'attachImage',
			sessionId: session.id,
			uploadId,
			index,
			total,
			chunk: resized.data.slice(index * ATTACH_CHUNK_CHARS, (index + 1) * ATTACH_CHUNK_CHARS),
			// Carried on chunk 0 only — see AttachImageChunk's doc on the host side.
			...(index === 0 ? { mimeType: resized.mimeType } : {}),
		});
	}
}

function createSession() {
	sendApp({ type: 'createSession', activate: true, mode: (els.modeSelect && els.modeSelect.value) || 'ask' });
}

function switchSession(id) {
	if (id === activeSessionId) { return; }
	sendApp({ type: 'switchSession', sessionId: id });
}

function closeSession(id) {
	sendApp({ type: 'closeSession', sessionId: id });
}

function clearSession() {
	const session = activeSession();
	if (!session) { return; }
	sendApp({ type: 'clearSession', sessionId: session.id });
}

function stopRun() {
	const session = activeSession();
	if (!session) { return; }
	sendApp({ type: 'stop', sessionId: session.id });
}

function setMode(mode) {
	const session = activeSession();
	if (!session) { return; }
	sendApp({ type: 'setMode', sessionId: session.id, mode });
}

function setProvider(providerId) {
	selectedProvider = providerId;
	// A pending pick belongs to the provider it was made under — switching providers drops it
	// rather than let it wrongly win a race under the new one (see `pendingModel`'s own doc).
	pendingModel = null;
	sendApp({ type: 'setProvider', provider: providerId });
	sendApp({ type: 'listModels', provider: providerId });
	renderModelSelect();
}

function setModel(model) {
	pendingModel = { provider: selectedProvider, model };
	sendApp({ type: 'setModel', provider: selectedProvider, model });
}

function enhancePrompt() {
	if (!els.composer) { return; }
	const text = els.composer.value.trim();
	if (!text) { return; }
	sendApp({ type: 'enhancePrompt', text });
}

// ---- Inbound dispatch (mirrors media/main.js's `case 'x':` switch) -----------------------------

function handleAppMessage(msg) {
	switch (msg.type) {
		// Only the provider catalog + default selection are pulled out of `config` — mirrors
		// `media/main.js`'s own `case 'config':` for that part. The rest of the payload
		// (baseUrl/approval/systemPrompt/rules/…) is desktop-settings-only, which is why `config`
		// was originally left off this switch entirely — but that also silently dropped the one
		// field a remote client actually needs: without it, `providers` (declared above, never
		// assigned) stayed empty forever, `renderProviderSelect()` was dead code nothing ever
		// called, and the model dropdown — which only fills in once a provider is selected — was
		// empty too. `models` themselves don't need requesting here: the host already pushes one
		// `models` message per provider unprompted right after `config` (`pushAvailableModels`),
		// which `case 'models':` below already handles.
		case 'config': {
			providers = Array.isArray(msg.providers) ? msg.providers : [];
			// Always follow the host's `selectedProvider` (this PWA has no Auto mode to protect
			// from it, unlike media/main.js) — it's the one shared setting any connected client
			// can change, including the desktop panel, and a switch made there has to reach this
			// device too, not just get picked up once this device's own selection has gone
			// invalid.
			if (typeof msg.selectedProvider === 'string' && providers.some(p => p.id === msg.selectedProvider)) {
				selectedProvider = msg.selectedProvider;
			} else if (!providers.some(p => p.id === selectedProvider)) {
				selectedProvider = (providers[0] && providers[0].id) || '';
			}
			// The pending pick is confirmed once this config actually carries it (or it no
			// longer matches the current provider) — see `pendingModel`'s own doc.
			if (pendingModel) {
				const current = providers.find(p => p.id === pendingModel.provider);
				if (pendingModel.provider !== selectedProvider || !current || current.model === pendingModel.model) {
					pendingModel = null;
				}
			}
			renderProviderSelect();
			renderModelSelect();
			break;
		}
		case 'sessions': {
			// A tab switch (including the very first snapshot) always lands at the bottom of
			// that tab's own transcript, regardless of whatever scroll position/stickiness the
			// previously-active tab was left in — see `stickToBottom`'s own doc.
			if (msg.activeSessionId !== activeSessionId) {
				stickToBottom = true;
			}
			const prevById = new Map(sessions.map(s => [s.id, s]));
			sessions = (msg.sessions || []).map(s => {
				const queue = Array.isArray(s.queue) ? s.queue : [];
				const pending = pendingQueues.get(s.id);
				if (pending) {
					if (sameQueue(pending, queue)) {
						// The host has caught up — this edit is confirmed, stop overriding it.
						pendingQueues.delete(s.id);
					} else {
						// Still ahead of (or diverged from) what the host just sent — keep
						// showing the local edit rather than let a stale/partial snapshot
						// silently revert or resurrect it. `case 'welcome':`'s reconnect flush
						// is what gets this confirmed if the original send never landed.
						return { ...s, messages: (prevById.get(s.id) || {}).messages || [], queue: pending };
					}
				}
				return { ...s, messages: (prevById.get(s.id) || {}).messages || [], queue };
			});
			// Drop pending edits for sessions this snapshot no longer lists (closed elsewhere) —
			// otherwise a closed session's id lingers in the map forever.
			const liveIds = new Set(sessions.map(s => s.id));
			for (const id of [...pendingQueues.keys()]) {
				if (!liveIds.has(id)) { pendingQueues.delete(id); }
			}
			activeSessionId = msg.activeSessionId;
			renderTabs();
			renderAll();
			break;
		}
		case 'transcript': {
			const s = sessions.find(x => x.id === msg.sessionId);
			if (!s) { break; }
			s.messages = Array.isArray(msg.messages) ? msg.messages : [];
			if (s.id === activeSessionId) { renderAll(); }
			break;
		}
		case 'runStart': {
			const s = sessions.find(x => x.id === msg.sessionId);
			if (!s) { break; }
			s.runId = msg.runId;
			s.runMode = msg.mode;
			s.streaming = true;
			s.pending = '';
			// Unconditional, unlike renderAll() below: a run can start in a tab that isn't the
			// one on screen, and the tab strip's running dot is the only thing that has to know.
			renderTabs();
			if (s.id === activeSessionId) { renderAll(); }
			break;
		}
		case 'token': {
			const s = sessionFor(msg);
			if (!s) { break; }
			s.pending = (s.pending || '') + msg.delta;
			if (s.id === activeSessionId) { renderAll(); }
			break;
		}
		case 'agentStepStart':
			break;
		case 'agentStepEnd':
			break;
		case 'toolStart': {
			const s = sessionFor(msg);
			if (s && s.id === activeSessionId && els.messages) {
				appendNotice(els.messages, 'notice-tool', `▶ ${msg.name || 'tool'}`);
			}
			break;
		}
		case 'toolEnd': {
			const s = sessionFor(msg);
			if (s && s.id === activeSessionId && els.messages) {
				appendNotice(els.messages, 'notice-tool', `■ ${msg.name || 'tool'} done`);
			}
			break;
		}
		case 'todos': {
			const s = sessionFor(msg);
			if (!s) { break; }
			s.todos = msg.todos;
			if (s.id === activeSessionId && els.todos) { renderTodos(els.todos, s.todos || []); }
			break;
		}
		case 'done': {
			const s = sessionFor(msg);
			if (!s) { break; }
			s.streaming = false;
			if (typeof s.pending === 'string' && s.pending.length) {
				(s.messages = s.messages || []).push({ role: 'assistant', content: s.pending });
				s.pending = '';
			}
			// A queued follow-up starts as soon as the tab is idle again — mirrors media/main.js's
			// own drain in its `done` handler. Sent in the run's own `runMode` (not whatever the
			// mode dropdown currently shows, which may have changed mid-run), same as there.
			if (s.queue && s.queue.length) {
				const next = s.queue.shift();
				persistQueue(s);
				if (s.id === activeSessionId) { renderQueueChips(); }
				if (!dispatchSend(s, next, s.runMode)) {
					// Couldn't reach the host (e.g. offline) — put it back at the front rather
					// than lose it silently; it will be retried the next time this session goes
					// idle (another `done`) or the queue is otherwise touched.
					s.queue.unshift(next);
					persistQueue(s);
					if (s.id === activeSessionId) {
						renderQueueChips();
						if (els.messages) { appendNotice(els.messages, 'notice-warn', '⚠ Not connected — your queued message is still waiting and will send once reconnected.'); }
					}
				}
			}
			renderTabs();
			if (s.id === activeSessionId) { renderAll(); }
			break;
		}
		case 'error': {
			const s = sessionFor(msg);
			if (s) { s.streaming = false; renderTabs(); }
			if (els.messages) { appendNotice(els.messages, 'notice-error', `⚠ ${msg.message || 'Error'}`); }
			break;
		}
		case 'info':
			if (els.messages) { appendNotice(els.messages, 'notice-info', String(msg.text || '')); }
			break;
		case 'approvalRequest':
		case 'askRequest':
			cards.render(msg);
			break;
		case 'promptCancel':
			cards.cancel(msg.id, msg.reason);
			break;
		case 'commands':
			// Slash-command catalog — this phase's composer is plain text, so the catalog is
			// stored but not yet driving an autocomplete menu (Phase 6 polish item).
			break;
		case 'remote':
			setStatus(msg.connected ? 'Connected' : 'Disconnected', msg.connected ? 'status-ok' : 'status-warn');
			break;
		case 'models':
			fetchedModels[msg.provider] = Array.isArray(msg.models) ? msg.models : [];
			if (msg.provider === selectedProvider) { renderModelSelect(); }
			break;
		case 'skills':
			skillsCatalog = Array.isArray(msg.skills) ? msg.skills : [];
			renderSkills();
			break;
		case 'mcp':
			// MCP server/tool catalog — stored for a later phase's server-management UI; no
			// picker in this phase's minimal shell.
			break;
		case 'history':
			// Archived-session list, used by `restoreSession` — no dedicated history screen in
			// this phase's minimal shell yet.
			break;
		case 'steerable': {
			// Field is `steerable` (chatViewProvider.ts's `declareSteerable`: `post({ type:
			// 'steerable', steerable })`) — this used to read `msg.value`, which that message
			// never carries, so `s.steerable` stayed `undefined` forever and `sendMessage`'s
			// steer-vs-queue check (`session.steerable !== false`) always took the steer branch
			// even for a run the host had already said could not be steered.
			const s = sessionFor(msg);
			if (s) { s.steerable = !!msg.steerable; }
			break;
		}
		case 'steerRejected': {
			const s = sessionFor(msg);
			if (!s || typeof msg.text !== 'string') { break; }
			// The host had no agent loop to deliver this into — take back the optimistic
			// "delivered" bubble `sendMessage`'s steer branch already showed (mirrors
			// media/main.js's own `undoSteer`; searched from the end since the rejected turn is
			// always the most recently echoed one).
			if (Array.isArray(s.messages)) {
				for (let i = s.messages.length - 1; i >= 0; i--) {
					if (s.messages[i].role === 'user' && s.messages[i].content === msg.text) {
						s.messages.splice(i, 1);
						break;
					}
				}
			}
			if (s.streaming) {
				// The run itself is still going (just not steerable) — queue it instead of
				// losing the correction, same as media/main.js's own undoSteer.
				(s.queue = s.queue || []).push(msg.text);
				persistQueue(s);
				if (s.id === activeSessionId) { renderQueueChips(); }
			} else if (!dispatchSend(s, msg.text, s.runMode)) {
				// The bounce arrived after the run already ended, and the resend itself
				// couldn't reach the host either — fall back to the queue rather than drop the
				// correction entirely. Nothing is currently streaming to drain it on `done`, but
				// it stays visible as a chip (and is replayed on reconnect via `pendingQueues`)
				// so it's at worst a manual resend away instead of silently gone.
				(s.queue = s.queue || []).push(msg.text);
				persistQueue(s);
				if (s.id === activeSessionId) {
					renderQueueChips();
					if (els.messages) { appendNotice(els.messages, 'notice-warn', '⚠ Not connected — your message was queued and will send once reconnected.'); }
				}
			}
			if (s.id === activeSessionId) { renderAll(); }
			break;
		}
		case 'autoPhase':
			if (els.messages) { appendNotice(els.messages, 'notice-info', `Phase: ${msg.label || ''}`); }
			break;
		case 'autoSummary': {
			const s = sessionFor(msg);
			if (s) { (s.messages = s.messages || []).push({ role: 'assistant', kind: 'auto', content: '', phases: msg.phases }); }
			if (els.messages && s && s.id === activeSessionId) { appendAutoSummary(els.messages, msg.phases); }
			break;
		}
		case 'compacted':
			if (els.messages) { appendNotice(els.messages, 'notice-info', 'Conversation compacted.'); }
			break;
		case 'enhancedPrompt':
			if (els.composer) { els.composer.value = msg.text || els.composer.value; }
			break;
		case 'enhanceError':
			if (els.messages) { appendNotice(els.messages, 'notice-error', `Enhance failed: ${msg.message || ''}`); }
			break;
		case 'context':
			// The reply to `attachActive` (`attachContext` itself is REMOTE_DENIED — see
			// extensions/openvs-chat/src/remote/policy.ts). Queued the same way
			// media/main.js's own `currentContext` is: shown as a removable chip, sent along
			// with the next `send`, not sent standalone.
			attachedContext = (msg.context && typeof msg.context.label === 'string') ? msg.context : null;
			renderContextChip();
			break;
		case 'attachOk':
			if (els.messages) { appendNotice(els.messages, 'notice-info', 'Image attached — it will go out with your next message.'); }
			break;
		default:
			// Anything else (config/selectProvider/newChat/inline/editProposal) is
			// desktop-editor/settings-only traffic a lean remote client does not need — see
			// scripts/test-pwa-contract.mjs's documented exclusion list.
			break;
	}
}

// ---- Control-frame dispatch ---------------------------------------------------------------------

function handleControlFrame(frame) {
	switch (frame.c) {
		case 'welcome':
			sendApp({ type: 'ready' });
			sendApp({ type: 'listSkills' });
			sendApp({ type: 'listMcp' });
			// Replays any queue edit this device made that never reached the host before the
			// socket dropped (see `pendingQueues`'s own doc) — otherwise a chip removed or added
			// while offline silently reverts once the fresh `ready` catch-up's `sessions`
			// snapshot arrives, since that snapshot only ever reflects what the host actually saw.
			for (const [sessionId, queue] of pendingQueues) {
				sendApp({ type: 'setQueue', sessionId, queue });
			}
			break;
		case 'snapshotNeeded':
			sendApp({ type: 'sync' });
			break;
		case 'pong':
			handlePong();
			break;
		case 'revoke':
			handleRevoked();
			break;
		case 'bye':
			if (ws) { ws.close(); }
			break;
		default:
			break;
	}
}

// ---- Connection lifecycle -------------------------------------------------------------------

/**
 * Terminal state for a revoked device: drops the dead token (retrying `connect()` with it would
 * just hit `/ws/client`'s 403 forever — see `room.ts`'s revocation check) and sends the user back
 * to the pairing screen instead of leaving `status` stuck on "Reconnecting…" forever, which read
 * as "still trying to get back in" rather than the plain, permanent "no" it actually is. Reached
 * two ways: a live socket closed with `DEVICE_REVOKED_CLOSE_CODE` (the `close` handler below), or
 * — if a later relay change starts sending it — an explicit `{c: 'revoke'}` app frame.
 */
function handleRevoked() {
	if (heartbeatTimer) { window.clearInterval(heartbeatTimer); }
	if (ws) { const dead = ws; ws = null; dead.close(); }
	deviceToken = '';
	if (roomId) {
		try { localStorage.removeItem(storageKey(roomId)); } catch { /* best-effort */ }
	}
	setStatus('This device was revoked.', 'status-warn');
	if (els.app) { els.app.hidden = true; }
	if (els.pairScreen) { els.pairScreen.hidden = false; }
	if (els.pairError) { els.pairError.textContent = 'This device was revoked. Scan a new QR code or enter a fresh pairing code to reconnect.'; }
}

/** Stops the heartbeat interval and any armed missed-pong timeout. Mirrors socket.ts's `stopHeartbeat`. */
function stopHeartbeat() {
	if (heartbeatTimer) { window.clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
	if (pongTimeoutTimer) { window.clearTimeout(pongTimeoutTimer); pongTimeoutTimer = undefined; }
	awaitingPong = false;
}

/** Sends one heartbeat ping and arms the missed-pong timeout. Mirrors socket.ts's `sendPing`. */
function sendPing() {
	awaitingPong = true;
	sendControl({ c: 'ping' });
	if (pongTimeoutTimer) { window.clearTimeout(pongTimeoutTimer); }
	pongTimeoutTimer = window.setTimeout(handleMissedPong, HEARTBEAT_TIMEOUT_MS);
}

/** A `pong` arrived for the outstanding ping — connection's alive. Mirrors socket.ts's `handlePong`. */
function handlePong() {
	if (!awaitingPong) { return; }
	awaitingPong = false;
	missedPongs = 0;
	if (pongTimeoutTimer) { window.clearTimeout(pongTimeoutTimer); pongTimeoutTimer = undefined; }
}

/**
 * A ping went unanswered past `HEARTBEAT_TIMEOUT_MS`. One miss is tolerated (a slow relay
 * round trip, not necessarily a dead link) — mirrors socket.ts's own "2 missed pongs"
 * threshold. On the second, `readyState` may still report OPEN while nothing is actually
 * getting through (the zombie-socket case the `visibilitychange` resync above can't fix on
 * its own, since a `sync` sent into a truly dead socket goes nowhere either) — force-closing
 * hands off to the `close` handler's existing reconnect/backoff, the only path that reliably
 * re-syncs session state afterward.
 */
function handleMissedPong() {
	if (!awaitingPong) { return; }
	missedPongs++;
	awaitingPong = false;
	if (missedPongs >= 2 && ws) {
		ws.close(4000, 'heartbeat timeout');
	}
}

function connect() {
	const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const url = `${scheme}//${location.host}/ws/client?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(deviceToken)}`;
	setStatus('Connecting…', 'status-warn');
	ws = new WebSocket(url);
	ws.addEventListener('open', () => {
		reconnectDelayMs = RECONNECT_MIN_MS;
		consecutiveReconnectFailures = 0;
		setStatus('Connected', 'status-ok');
		missedPongs = 0;
		heartbeatTimer = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
		// Bootstrap gate: `handleControlFrame`'s `case 'welcome':` is what actually sends
		// `ready`/`listSkills`/`listMcp` — nothing else here does. The relay only answers a
		// `hello` with `welcome` (room.ts), so without this the socket sits "Connected" with an
		// empty app: no sessions, no providers, a composer with nothing to send to.
		sendControl({ c: 'hello', role: 'client' });
	});
	ws.addEventListener('message', event => {
		let envelope;
		try {
			envelope = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!envelope || envelope.v !== 1 || typeof envelope.seq !== 'number') { return; }
		if (envelope.t === 'm') {
			handleAppMessage(envelope.p);
		} else if (envelope.t === 'c') {
			handleControlFrame(envelope.p);
		}
	});
	ws.addEventListener('close', event => {
		// A revoked device must stay locked out, not retry forever with the same dead token —
		// see `handleRevoked`'s own doc. `room.ts`'s `revokeDevice` closes a *live* socket with
		// this exact code; `/ws/client` rejecting a stale token on a fresh connect attempt (the
		// app was closed when it got revoked) can't be told apart from an ordinary network drop
		// this way — the browser's WebSocket API doesn't expose the 403 an upgrade never
		// completed for — so that case still retries and relies on the server continuing to
		// reject it, same as before this fix.
		if (event.code === DEVICE_REVOKED_CLOSE_CODE) {
			handleRevoked();
			return;
		}
		consecutiveReconnectFailures++;
		// Still retries either way (a real outage does eventually clear on its own) — this only
		// changes what the status line says while it keeps trying, since silently spinning
		// "Reconnecting…" forever for a revoked-while-disconnected device (see
		// REVOKE_HINT_AFTER_FAILURES's doc) reads as "still working on it" rather than the
		// permanent "no" it likely is.
		setStatus(
			consecutiveReconnectFailures >= REVOKE_HINT_AFTER_FAILURES
				? 'Still trying to reconnect — if this device was revoked, re-pair with a fresh code instead of waiting.'
				: 'Reconnecting…',
			'status-warn',
		);
		stopHeartbeat();
		const delay = reconnectDelayMs;
		reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
		window.setTimeout(connect, delay + Math.random() * delay * 0.5);
	});
	ws.addEventListener('error', () => {
		if (ws) { ws.close(); }
	});
}

// ---- Boot -------------------------------------------------------------------------------------

/** Reads `/p/<roomId>#<code>` — the shape the pairing QR encodes, per the plan's Auth step 3. */
function parseLocation() {
	const match = /^\/p\/([^/]+)/.exec(location.pathname);
	const fromUrl = match ? decodeURIComponent(match[1]) : new URLSearchParams(location.search).get('room') || '';
	return {
		// A launch with no room of its own (see `loadLastRoom`'s doc — chiefly the installed
		// icon's fixed `start_url`) falls back to whichever room this browser paired to last,
		// so it can still find that pairing's saved device token in `boot()` below.
		room: fromUrl || loadLastRoom(),
		code: location.hash ? decodeURIComponent(location.hash.slice(1)) : '',
	};
}

async function boot() {
	const { room, code } = parseLocation();
	roomId = room;
	const stored = roomId ? loadDevice(roomId) : undefined;
	if (stored && stored.token) {
		deviceToken = stored.token;
		// A returning session's service worker may not have current auth (e.g. a token refresh
		// since the last visit, or a service-worker eviction that dropped its own IndexedDB
		// cache) — re-post every boot, not just the first pairing. `claim()` does the same for
		// the freshly-paired path just below. Not awaited — same reasoning as `claim()`'s own
		// call: `navigator.serviceWorker.ready` can hang indefinitely (no SW registered yet, or
		// registration still in flight), and blocking boot() on it held the whole app on a blank
		// screen for the same reason a first-time pairing did.
		void syncAuthToServiceWorker(roomId, deviceToken);
	} else if (roomId && code) {
		if (els.pairError) { els.pairError.textContent = ''; }
		try {
			deviceToken = await claim(roomId, code);
			history.replaceState(null, '', `/p/${encodeURIComponent(roomId)}`);
		} catch (err) {
			if (els.pairError) { els.pairError.textContent = err instanceof Error ? err.message : String(err); }
			return;
		}
	} else {
		if (els.pairScreen) { els.pairScreen.hidden = false; }
		if (els.app) { els.app.hidden = true; }
		return;
	}
	if (els.pairScreen) { els.pairScreen.hidden = true; }
	if (els.app) { els.app.hidden = false; }
	registerServiceWorker();
	connect();
}

// A backgrounded phone (screen lock, app-switch) can silently zombie the WebSocket: mobile
// browsers throttle/suspend JS timers while hidden, so the heartbeat pings that would
// normally surface a dead connection stop firing too, and the socket's own `close` event —
// the only thing that currently triggers a resync (see `connect()`'s `case 'welcome':`
// catch-up) — may never fire even once the OS has long since torn down the underlying
// connection. A `done`/`error` frame that arrived during that blackout is lost for good: no
// offline queue (see `RemoteSink`'s own doc), and `readyState` keeps reporting OPEN. The
// session it belonged to is then stuck showing streaming forever — Stop button stuck, every
// further send routed into `steer` against a run that already ended and gets silently
// rejected — until the tab is reloaded or a new chat is opened. Re-requesting `sync` the
// moment the tab is foregrounded again is a cheap, harmless no-op when nothing was missed,
// and self-heals exactly this desync when something was: `case 'sync':`
// (chatViewProvider.ts) answers with the store's authoritative per-session `streaming`.
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible' && ws && ws.readyState === WebSocket.OPEN) {
		sendApp({ type: 'sync' });
	}
});

if (els.sendBtn) { els.sendBtn.addEventListener('click', sendMessage); }
if (els.stopBtn) { els.stopBtn.addEventListener('click', stopRun); }
if (els.newSessionBtn) { els.newSessionBtn.addEventListener('click', createSession); }
if (els.enhanceBtn) { els.enhanceBtn.addEventListener('click', enhancePrompt); }
if (els.modeSelect) { els.modeSelect.addEventListener('change', () => setMode(els.modeSelect.value)); }
if (els.providerSelect) { els.providerSelect.addEventListener('change', () => setProvider(els.providerSelect.value)); }
if (els.modelSelect) { els.modelSelect.addEventListener('change', () => setModel(els.modelSelect.value)); }
if (els.attachImageBtn && els.attachImageInput) {
	els.attachImageBtn.addEventListener('click', () => els.attachImageInput.click());
	els.attachImageInput.addEventListener('change', () => {
		const file = els.attachImageInput.files && els.attachImageInput.files[0];
		els.attachImageInput.value = '';
		if (file) { void uploadImage(file); }
	});
}
if (els.attachActiveBtn) { els.attachActiveBtn.addEventListener('click', () => sendApp({ type: 'attachActive' })); }
if (els.pairForm) {
	els.pairForm.addEventListener('submit', async event => {
		event.preventDefault();
		if (!els.pairCode) { return; }
		const code = els.pairCode.value.trim();
		if (!roomId || !code) { return; }
		try {
			deviceToken = await claim(roomId, code);
			if (els.pairScreen) { els.pairScreen.hidden = true; }
			if (els.app) { els.app.hidden = false; }
			registerServiceWorker();
			connect();
		} catch (err) {
			if (els.pairError) { els.pairError.textContent = err instanceof Error ? err.message : String(err); }
		}
	});
}

// clearSession has no UI trigger yet (kept minimal per this phase's scope); closeSession is
// now wired from each tab's own close button in renderTabs() above.
void clearSession;

boot();
