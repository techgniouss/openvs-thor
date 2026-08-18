// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Minimal service worker. Its only job of substance is the `push` handler, and per the plan it
// must never trust the push payload — Web Push here is deliberately payload-less (see
// ../src/push.ts's top-of-file doc), so there is nothing to trust anyway. On wake it always
// refetches real content from `/api/pending` and only then shows a notification.
'use strict';

const CACHE_NAME = 'openvs-relay-shell-v2';
const SHELL_ASSETS = [
	'/', '/index.html', '/app.js', '/transcript.js', '/cards.js', '/styles.css', '/manifest.webmanifest',
	'/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png', '/apple-touch-icon.png',
];

self.addEventListener('install', event => {
	event.waitUntil(
		caches.open(CACHE_NAME)
			.then(cache => cache.addAll(SHELL_ASSETS))
			.catch(() => { /* best-effort — an offline shell is a nice-to-have, not a requirement */ }),
	);
	self.skipWaiting();
});

self.addEventListener('activate', event => {
	event.waitUntil(
		caches.keys().then(names => Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))),
	);
	self.clients.claim();
});

// ---- Auth handoff (Phase 6b: web push triggers) -----------------------------------------------
//
// The device token/room id `/api/pending` needs for auth. `localStorage` is not reachable from a
// service worker, so `app.js` hands these over two ways once it has completed pairing (or on
// every boot, for a returning session): written directly to IndexedDB — which a service worker
// *can* read, and which survives this worker being evicted and restarted between pushes, unlike
// a value cached only in memory from a `message` event — and also `postMessage`d to an
// already-running worker for an immediate update, persisted below into the very same store. See
// `app.js`'s matching top-of-file doc; the constants and open/write helpers here are that file's
// hand duplicate (a classic, non-module service worker script can't `import` it).
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

/** Persists `{room, token}` sent via `postMessage` into the same store `readActiveAuth` reads — see this file's top doc. */
async function writeActiveAuth(room, token) {
	const db = await openAuthDb();
	await new Promise((resolve, reject) => {
		const tx = db.transaction(AUTH_STORE_NAME, 'readwrite');
		tx.objectStore(AUTH_STORE_NAME).put({ room, token }, AUTH_RECORD_KEY);
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(tx.error);
	});
}

/** The device token/room id `/api/pending` needs for auth, read back from IndexedDB. `undefined` if nothing has been written yet (or IndexedDB is unavailable) — the `push` handler below falls back to a generic notification in that case, same as before this was wired up. */
async function readActiveAuth() {
	try {
		const db = await openAuthDb();
		return await new Promise((resolve, reject) => {
			const req = db.transaction(AUTH_STORE_NAME, 'readonly').objectStore(AUTH_STORE_NAME).get(AUTH_RECORD_KEY);
			req.onsuccess = () => resolve(req.result || undefined);
			req.onerror = () => reject(req.error);
		});
	} catch {
		return undefined;
	}
}

self.addEventListener('message', event => {
	const data = event.data;
	if (data && data.type === 'auth' && typeof data.room === 'string' && typeof data.token === 'string') {
		event.waitUntil(writeActiveAuth(data.room, data.token).catch(() => { /* best-effort, see this file's top doc */ }));
	}
});

self.addEventListener('push', event => {
	event.waitUntil((async () => {
		// No payload is ever read from `event.data` here, by design — see this file's top doc.
		const auth = await readActiveAuth();
		let title = 'OpenVS';
		let body = 'You have an update.';
		let tag = 'openvs-pending';
		try {
			const headers = auth && auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
			const room = auth && auth.room ? `?room=${encodeURIComponent(auth.room)}` : '';
			const res = await fetch(`/api/pending${room}`, { headers });
			if (res.ok) {
				const data = await res.json();
				const first = Array.isArray(data.pending) ? data.pending[0] : undefined;
				if (first) {
					title = first.title || title;
					body = first.body || body;
					tag = first.tag || tag;
				}
			}
		} catch {
			// Offline or the fetch failed — still show a generic notification so the user knows
			// something happened rather than staying silent.
		}
		await self.registration.showNotification(title, { body, tag });
	})());
});

self.addEventListener('notificationclick', event => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: 'window' }).then(clients => {
			for (const client of clients) {
				if ('focus' in client) { return client.focus(); }
			}
			return self.clients.openWindow('/');
		}),
	);
});
