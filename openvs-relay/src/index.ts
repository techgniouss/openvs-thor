// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// The Worker's `fetch` entry point. Kept thin on purpose (per the plan's "index.ts should be a
// thin router, room.ts should hold the actual DO logic" split): this file only decides *which*
// Durable Object a request belongs to and forwards it there verbatim, or falls through to the
// static PWA assets. Every route that needs SQLite, WebSocket upgrade handling, or pairing/token
// logic is implemented in `room.ts`, on the DO's own `fetch`.

import { WorkspaceRoom } from './room.ts';

/** Re-exported so wrangler.jsonc's `durable_objects.bindings[].class_name: "WorkspaceRoom"` resolves against this module. */
export { WorkspaceRoom };

/**
 * Worker bindings and secrets. The four `VAPID_*`/`RELAY_PEPPER` secrets are set via
 * `wrangler secret put <NAME>` at deploy time — never committed, never given a default here.
 * `RELAY_SIGNUP_KEY` is optional: when set, `/pair/claim` additionally requires it (see
 * `room.ts`'s `handlePairClaim`), letting an operator gate who may claim a pairing code beyond
 * "knows the 8-character code".
 */
export interface Env {
	readonly ROOMS: DurableObjectNamespace;
	readonly ASSETS: Fetcher;
	readonly RELAY_PEPPER: string;
	readonly VAPID_PUBLIC: string;
	readonly VAPID_PRIVATE: string;
	readonly VAPID_SUBJECT: string;
	readonly RELAY_SIGNUP_KEY?: string;
}

/** Paths this Worker addresses to a room's Durable Object rather than serving as a static asset. */
const ROOM_ROUTES: readonly string[] = ['/ws/host', '/ws/client', '/pair/claim', '/api/push/subscribe', '/api/pending', '/api/devices'];

/**
 * Maps a Cloudflare `request.cf.continent` code to the closest {@link DurableObjectLocationHint}.
 * Used only on the room's *first* creation — a Durable Object's location is fixed for its
 * lifetime, so a hint passed on every later request addressing the same id is a harmless no-op,
 * which is why this Worker can stay stateless and simply pass a hint through on every request
 * rather than tracking "have I created this room yet".
 */
function locationHintFor(continent: string | undefined): DurableObjectLocationHint | undefined {
	switch (continent) {
		case 'NA': return 'wnam';
		case 'SA': return 'sam';
		case 'EU': return 'weur';
		case 'AF': return 'afr';
		case 'AS': return 'apac';
		case 'OC': return 'oc';
		default: return undefined;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (ROOM_ROUTES.includes(url.pathname)) {
			const roomId = url.searchParams.get('room');
			if (!roomId) {
				return new Response('missing room id', { status: 400 });
			}
			// `request.cf` is typed as a union that includes `RequestInitCfProperties` (the
			// *outbound*-fetch shape, which has no `continent` field), so a direct `.continent`
			// access widens to `unknown` — this narrows to the inbound shape that actually has it.
			const cf = request.cf as IncomingRequestCfProperties | undefined;
			const locationHint = locationHintFor(cf?.continent);
			const id = env.ROOMS.idFromName(roomId);
			const stub = env.ROOMS.get(id, locationHint ? { locationHint } : undefined);
			return stub.fetch(request);
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
