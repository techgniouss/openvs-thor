// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// DO SQLite schema for `WorkspaceRoom`. Every statement is `CREATE TABLE IF NOT EXISTS`, so
// re-running the migration list on an already-migrated DO (e.g. after a redeploy) is a no-op
// rather than an error. Keep new tables/columns as new entries appended to {@link MIGRATIONS}
// rather than editing an existing statement in place — SQLite's `ALTER TABLE` support is
// limited, and an appended `ALTER TABLE ... ADD COLUMN` statement is the safe way to evolve a
// table that may already have rows in it on a deployed Worker.

/**
 * Registered devices (both the single host and any number of paired clients) for this room.
 * `tokenHash` is the HMAC of the device's bearer token, never the token itself — see
 * `tokens.ts`. `pubkeyJwk` is the client's non-extractable ECDSA P-256 public key, used to
 * verify the signed-nonce challenge on `/ws/client` connect (Auth step 5 in the plan).
 */
const CREATE_DEVICE_TABLE = `
CREATE TABLE IF NOT EXISTS device (
	id TEXT PRIMARY KEY,
	name TEXT,
	tokenHash TEXT,
	pubkeyJwk TEXT,
	createdAt INTEGER,
	lastSeenAt INTEGER,
	revokedAt INTEGER
)`;

/** Outstanding pairing codes. `codeHash` is the HMAC of the code — the code itself is never stored. */
const CREATE_PAIRING_TABLE = `
CREATE TABLE IF NOT EXISTS pairing (
	codeHash TEXT PRIMARY KEY,
	expiresAt INTEGER,
	usedAt INTEGER
)`;

/**
 * Web Push subscriptions, one row per device. `p256dh`/`auth` are kept even though the relay
 * sends payload-less pushes (see `push.ts`) — some push services validate that the keys are
 * present on the subscription even when no encrypted payload is sent.
 */
const CREATE_PUSH_TABLE = `
CREATE TABLE IF NOT EXISTS push (
	deviceId TEXT,
	endpoint TEXT,
	p256dh TEXT,
	auth TEXT,
	createdAt INTEGER,
	failureCount INTEGER DEFAULT 0
)`;

/** Small key/value store for room-level bookkeeping (room secret hash, locationHint, etc). */
const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
	k TEXT PRIMARY KEY,
	v TEXT
)`;

/**
 * The most recent Web Push event(s) raised for this room, per Phase 6b's "store what was pushed"
 * fix — see `room.ts`'s `raisePush`/`handlePending`. Deliberately not a per-device queue: the
 * relay never learns which client dismissed what, so every device asking `/api/pending` is
 * handed the same latest row(s); `raisePush` prunes this table down to a handful of rows on every
 * insert, since a real client only ever wants "what's the latest thing that happened", not a
 * backlog.
 */
const CREATE_PENDING_TABLE = `
CREATE TABLE IF NOT EXISTS pending (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT,
	body TEXT,
	tag TEXT,
	sessionId TEXT,
	createdAt INTEGER
)`;

/**
 * Every migration statement, applied in order by {@link applyMigrations}. Appended to, never
 * edited in place — see this file's top-of-file doc.
 */
export const MIGRATIONS: readonly string[] = [
	CREATE_DEVICE_TABLE,
	CREATE_PAIRING_TABLE,
	CREATE_PUSH_TABLE,
	CREATE_META_TABLE,
	CREATE_PENDING_TABLE,
];

/**
 * Runs every statement in {@link MIGRATIONS} against a Durable Object's SQLite storage. Callers
 * (see `room.ts`'s constructor) are expected to wrap this in `state.blockConcurrencyWhile` so no
 * request is handled against a not-yet-migrated database.
 */
export function applyMigrations(sql: SqlStorage): void {
	for (const statement of MIGRATIONS) {
		sql.exec(statement);
	}
}
