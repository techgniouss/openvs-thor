/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { dpapiUnprotectCurrentUser } from './dpapi';

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJsStatic['Database']>;

/**
 * Reads decrypted cookies directly out of a live Chrome profile — Windows only, Chrome's
 * "v10" cookie encryption only (not the newer per-browser-install "App-Bound Encryption",
 * "v20", which cannot be unwrapped outside the browser process at all; `readMasterKey`
 * reports that case honestly rather than guessing).
 *
 * Ported from a companion Python project's `providers/web_cookie_providers/agent/
 * profile_cookies.py`. The credential is the profile's own live session, read fresh at call
 * time rather than harvested into a cache — Google rotates `__Secure-1PSIDTS` every few
 * hours and Chrome keeps up automatically; a cached copy does not, and goes stale within a
 * day even though the underlying session is still good.
 *
 * ⚠️ See `providers/webCookie/geminiWebProvider.ts`'s class doc for the actual risk this
 * capability exists to take on: replaying a real signed-in Google session's cookies against
 * `gemini.google.com`'s consumer chat UI is outside Google's terms of service.
 */

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

/** Lazily initializes sql.js once per process. The `.wasm` binary ships next to
 * `sql-wasm.js` in the installed package; pointing `locateFile` at that same directory
 * keeps this working regardless of the extension host's current working directory. */
function loadSqlJs(): Promise<SqlJsStatic> {
	if (!sqlJsPromise) {
		const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
		sqlJsPromise = initSqlJs({ locateFile: (file: string) => path.join(wasmDir, file) });
	}
	return sqlJsPromise;
}

export interface ChromeCookie {
	readonly name: string;
	readonly value: string;
	readonly domain: string;
	readonly path: string;
	readonly secure: boolean;
	readonly httpOnly: boolean;
}

/**
 * Reads Chrome's per-profile AES-256-GCM master key from `Local State` and unwraps it with
 * DPAPI. Returns `undefined` when the profile doesn't exist, isn't readable, or (most
 * commonly on a recently-updated Chrome) uses App-Bound Encryption — in every case the
 * caller's job is to fall back honestly, not to guess.
 */
export async function readMasterKey(profilePath: string): Promise<Buffer | undefined> {
	const localStatePath = path.join(profilePath, 'Local State');
	let raw: string;
	try {
		raw = await fs.promises.readFile(localStatePath, 'utf8');
	} catch {
		return undefined;
	}
	let data: { os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string } };
	try {
		data = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const osCrypt = data.os_crypt ?? {};
	if (osCrypt.app_bound_encrypted_key && !osCrypt.encrypted_key) {
		// App-Bound Encryption (Chrome's newer scheme): the key is additionally bound to the
		// browser executable and cannot be unwrapped this way. Reported honestly rather than
		// producing garbage plaintext from a wrong-shaped unwrap attempt.
		return undefined;
	}
	const encoded = osCrypt.encrypted_key;
	if (!encoded) {
		return undefined;
	}
	const wrapped = Buffer.from(encoded, 'base64');
	if (wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') {
		return undefined;
	}
	return dpapiUnprotectCurrentUser(wrapped.subarray(5));
}

/**
 * Drops Chrome's 32-byte domain-hash prefix when present. Recent Chrome prepends a SHA-256
 * of the cookie's domain to the plaintext before encrypting, to stop a value lifted from one
 * host's row being replayed under another — it is binary, so leaving it on produces a value
 * that cannot even be put in an HTTP header. Detected structurally (a non-ASCII 32-byte head
 * followed by an ASCII remainder) rather than assumed by Chrome version, since that is what
 * actually distinguishes the two shapes.
 */
export function stripDomainHashPrefix(plain: Buffer): Buffer {
	if (plain.length <= 32) {
		return plain;
	}
	const head = plain.subarray(0, 32);
	const tail = plain.subarray(32);
	if (isAscii(head)) {
		return plain; // printable head: no prefix, keep everything
	}
	if (isAscii(tail)) {
		return tail; // binary head + clean tail: prefix confirmed
	}
	return plain;
}

function isAscii(buf: Buffer): boolean {
	for (const byte of buf) {
		if (byte > 0x7f) {
			return false;
		}
	}
	return true;
}

/** utf-8 decode, then require every code point fit in a byte (latin-1-encodable) — a cookie
 * value has to survive being placed verbatim into an HTTP header. Returns '' rather than
 * throwing for anything that fails either check, matching the source project's "drop it
 * rather than poison the whole jar" rule for one bad cookie. */
function decodeForHeader(plain: Buffer): string {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
	} catch {
		return '';
	}
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0xff) {
			return '';
		}
	}
	return text;
}

/**
 * Decrypts one `encrypted_value` BLOB from Chrome's cookie database. Chrome v10/v11 values
 * are `"v10"/"v11" + nonce(12) + ciphertext + tag(16)`, AES-256-GCM under `key`. Returns ''
 * on any failure (wrong key, corrupt value, un-header-safe plaintext) rather than throwing —
 * one bad row must not fail the whole read.
 */
export function decryptCookieValue(encrypted: Buffer, key: Buffer): string {
	if (encrypted.length < 15 + 16) {
		return '';
	}
	const prefix = encrypted.subarray(0, 3).toString('latin1');
	if (prefix !== 'v10' && prefix !== 'v11') {
		return '';
	}
	const nonce = encrypted.subarray(3, 15);
	const rest = encrypted.subarray(15);
	const tag = rest.subarray(rest.length - 16);
	const ciphertext = rest.subarray(0, rest.length - 16);
	try {
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
		decipher.setAuthTag(tag);
		const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		return decodeForHeader(stripDomainHashPrefix(plain));
	} catch {
		return '';
	}
}

/**
 * Live cookies for `hostSuffixes` from `profilePath`'s Chrome profile, decrypted. Empty when
 * the profile or its master key is unreadable (App-Bound Encryption, a missing profile, a
 * profile owned by a different Windows user) — never throws, so a caller can treat "nothing
 * readable here" as an ordinary, expected outcome rather than a crash.
 *
 * Copies the `Cookies` database file first: Chrome holds an exclusive lock on it while
 * running, and reading live (whether or not a browser window is open) is the entire point.
 */
export async function readCookies(profilePath: string, hostSuffixes: readonly string[]): Promise<ChromeCookie[]> {
	const key = await readMasterKey(profilePath);
	if (!key) {
		return [];
	}
	const source = path.join(profilePath, 'Default', 'Network', 'Cookies');
	// In the OS temp directory, not beside the source: that wrote into the user's own Chrome
	// profile (leaving a stray file there if the host died before cleanup), and a fixed per-pid
	// name let two concurrent reads in one process overwrite and delete each other's copy.
	const tmp = path.join(os.tmpdir(), `openvs-cookies-${crypto.randomBytes(8).toString('hex')}.tmp`);
	let bytes: Buffer;
	try {
		await fs.promises.copyFile(source, tmp);
		bytes = await fs.promises.readFile(tmp);
	} catch {
		return [];
	} finally {
		fs.promises.unlink(tmp).catch(() => { /* best-effort cleanup */ });
	}

	const { Database: Db } = await loadSqlJs();
	let db: SqlDatabase;
	try {
		db = new Db(bytes);
	} catch {
		return [];
	}
	try {
		const result = db.exec(
			'SELECT name, value, encrypted_value, host_key, path, is_secure, is_httponly FROM cookies',
		);
		const rows = result[0];
		if (!rows) {
			return [];
		}
		const suffixes = hostSuffixes.map(s => s.toLowerCase());
		const out: ChromeCookie[] = [];
		for (const row of rows.values) {
			const [name, plainValue, encryptedValue, hostKey, cookiePath, isSecure, isHttpOnly] = row;
			const host = String(hostKey ?? '').toLowerCase().replace(/^\.+/, '');
			if (!suffixes.some(s => host === s || host.endsWith(`.${s}`))) {
				continue;
			}
			const value = typeof plainValue === 'string' && plainValue
				? plainValue
				: decryptCookieValue(Buffer.from(encryptedValue instanceof Uint8Array ? encryptedValue : []), key);
			if (!value) {
				continue;
			}
			out.push({
				name: String(name ?? ''),
				value,
				domain: String(hostKey ?? ''),
				path: String(cookiePath ?? ''),
				secure: !!isSecure,
				httpOnly: !!isHttpOnly,
			});
		}
		return out;
	} finally {
		db.close();
	}
}

/** Cookies (from {@link readCookies}) reduced to an HTTP `Cookie:` header. `names` filters to
 * a subset; empty means "send the whole jar", which several WAF-guarded upstreams require
 * (they reject a reconstructed subset that omits a cookie they check for but a caller would
 * not think to forward). Later duplicates win, matching how a browser resolves a repeated
 * name after a refresh. */
export function cookiesToHeader(cookies: readonly ChromeCookie[], names: readonly string[] = []): string {
	const wanted = new Set(names.filter(Boolean));
	const merged = new Map<string, string>();
	for (const cookie of cookies) {
		if (wanted.size && !wanted.has(cookie.name)) {
			continue;
		}
		merged.set(cookie.name, cookie.value);
	}
	return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** The default Chrome profile directory for the current OS user, or undefined on a platform
 * this module has no default location for. Windows-only for now — DPAPI is the only
 * decryption path implemented (see this file's class doc); macOS (Keychain) and Linux
 * (kwallet/gnome-keyring or a fixed key, depending on distro) would need their own unwrap
 * step this module does not implement, so pointing at their profile paths would only produce
 * a confusing "master key unreadable" failure instead of an honest "not supported" one. */
export function defaultChromeProfilePath(): string | undefined {
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA;
		return localAppData ? path.join(localAppData, 'Google', 'Chrome', 'User Data') : undefined;
	}
	return undefined;
}

/** Whether this platform's decryption path is implemented at all — checked before ever
 * attempting a read, so the error a user sees on macOS/Linux says "not supported on this
 * platform" rather than a confusing lower-level failure. */
export function isPlatformSupported(): boolean {
	return process.platform === 'win32';
}
