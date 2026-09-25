/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import * as dns from 'dns';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Cloudflare Tunnel (`cloudflared`) for local hosting: finds the binary, installs it when it's
 * missing, and runs the tunnel that gives `relayServer.ts` a public HTTPS address a phone can
 * reach. `vscode`-free — process spawning and downloading are injected — so
 * `scripts/test-local-tunnel.mjs` can drive it against a fake `cloudflared`.
 *
 * Two kinds of tunnel:
 *  - **Quick** (the default): `cloudflared tunnel --url …` needs no Cloudflare account and prints
 *    a random `https://<words>.trycloudflare.com` address. That address changes every time the
 *    tunnel restarts — and a phone keeps its pairing per address — so a restart means pairing
 *    again.
 *  - **Named**: a tunnel created in the user's own Cloudflare dashboard, run with its connector
 *    token. Its hostname never changes, so a phone pairs once.
 */

/** Where installers put `cloudflared` when it isn't on PATH (the official MSI / winget, Homebrew). */
function wellKnownPaths(platform: NodeJS.Platform): string[] {
	if (platform === 'win32') {
		return [
			path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
			path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
			path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
		];
	}
	if (platform === 'darwin') {
		return ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
	}
	return ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
}

/** The file name `cloudflared` has on `platform`. */
export function binaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/**
 * Finds a usable `cloudflared`: the configured path, then one this extension installed into its
 * own storage, then every directory on PATH, then where installers put it. `undefined` when
 * there is none.
 */
export function findCloudflared(configured: string | undefined, installDir: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | undefined {
	const candidates: string[] = [];
	if (configured?.trim()) {
		candidates.push(configured.trim());
	}
	candidates.push(path.join(installDir, binaryName(platform)));
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (dir) {
			candidates.push(path.join(dir, binaryName(platform)));
		}
	}
	candidates.push(...wellKnownPaths(platform));
	return candidates.find(candidate => exists(candidate));
}

/** The official release asset for this platform, or `undefined` where none is published. */
export function releaseAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
	if (platform === 'win32') {
		// No native Windows ARM build is published; the amd64 one runs under emulation.
		return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
	}
	if (platform === 'darwin') {
		return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
	}
	if (platform === 'linux') {
		return { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm', ia32: 'cloudflared-linux-386' }[arch];
	}
	return undefined;
}

/** Cloudflare's own release channel — the only place a binary is ever fetched from. */
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

/**
 * Downloads the official `cloudflared` release for this machine into `installDir` and returns
 * its path. Written to a temp name and renamed into place, so an interrupted download never
 * leaves a truncated binary that {@link findCloudflared} would then pick up.
 */
export async function installCloudflared(
	installDir: string,
	fetchImpl: typeof fetch = fetch,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	signal?: AbortSignal,
): Promise<string> {
	const asset = releaseAsset(platform, arch);
	if (!asset) {
		throw new Error(`Cloudflare doesn't publish cloudflared for ${platform}/${arch}. Install it yourself and set "openvsChat.remote.cloudflaredPath".`);
	}
	const response = await fetchImpl(RELEASE_BASE + asset, { signal, redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`Downloading cloudflared failed: HTTP ${response.status}.`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	// A real cloudflared is tens of MB; anything tiny is an error page, not a binary.
	if (bytes.length < 1024 * 1024) {
		throw new Error('Downloading cloudflared failed: the file received is not a cloudflared binary.');
	}
	fs.mkdirSync(installDir, { recursive: true });
	const target = path.join(installDir, binaryName(platform));
	if (asset.endsWith('.tgz')) {
		const archive = path.join(installDir, `${asset}.part`);
		fs.writeFileSync(archive, bytes);
		try {
			await new Promise<void>((resolve, reject) => {
				execFile('tar', ['-xzf', archive, '-C', installDir], err => err ? reject(err) : resolve());
			});
		} finally {
			fs.rmSync(archive, { force: true });
		}
	} else {
		const temp = `${target}.part`;
		fs.writeFileSync(temp, bytes);
		fs.renameSync(temp, target);
	}
	if (platform !== 'win32') {
		fs.chmodSync(target, 0o755);
	}
	return target;
}

/** Spawns a child process — injected so tests can stand in a fake `cloudflared`. */
export type Spawner = (command: string, args: string[]) => ChildProcess;

const defaultSpawner: Spawner = (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/** How long a tunnel may take to report its address before starting it counts as failed. */
const TUNNEL_READY_TIMEOUT_MS = 45_000;

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** What cloudflared logs once a connector is up — the named tunnel's "ready" signal. */
const CONNECTED = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;

export interface TunnelOptions {
	readonly binary: string;
	/** The local relay's address, e.g. `http://127.0.0.1:52011`. */
	readonly localUrl: string;
	/** A named tunnel's connector token; a quick tunnel when absent. */
	readonly token?: string;
	/** The named tunnel's public hostname (required with `token`). */
	readonly hostname?: string;
	/** An empty config file for the quick tunnel — see {@link Tunnel.start}. */
	readonly configFile?: string;
	readonly spawner?: Spawner;
	readonly readyTimeoutMs?: number;
}

/** One running `cloudflared`. */
export class Tunnel {
	private child?: ChildProcess;
	private stopped = false;
	/** The last lines cloudflared logged — quoted back when it fails, since its own words say why. */
	private readonly tail: string[] = [];

	private constructor(private readonly options: TunnelOptions) { }

	/**
	 * Starts the tunnel; resolves with its public `https://` address once it can take traffic.
	 * `onExit` reports an exit that {@link stop} didn't ask for.
	 */
	static start(options: TunnelOptions, onExit: (code: number | null, log: string) => void): { tunnel: Tunnel; url: Promise<string> } {
		const tunnel = new Tunnel(options);
		return { tunnel, url: tunnel.run(onExit) };
	}

	private run(onExit: (code: number | null, log: string) => void): Promise<string> {
		const { binary, localUrl, token, hostname } = this.options;
		const args = token
			? ['tunnel', '--no-autoupdate', 'run', '--token', token]
			// `--config` pointed at an empty file: a quick tunnel refuses to start while
			// ~/.cloudflared/config.yml exists, which any machine that ever ran a named tunnel has.
			: ['tunnel', '--no-autoupdate', ...(this.options.configFile ? ['--config', this.options.configFile] : []), '--url', localUrl];
		const child = (this.options.spawner ?? defaultSpawner)(binary, args);
		this.child = child;
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const settle = (fn: () => void) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					fn();
				}
			};
			const timer = setTimeout(() => settle(() => {
				this.stop();
				reject(new Error(`Cloudflare Tunnel didn't come up within ${Math.round((this.options.readyTimeoutMs ?? TUNNEL_READY_TIMEOUT_MS) / 1000)}s.${this.logHint()}`));
			}), this.options.readyTimeoutMs ?? TUNNEL_READY_TIMEOUT_MS);
			let quickUrl: string | undefined;
			let connected = false;
			const onLine = (line: string) => {
				this.tail.push(line);
				if (this.tail.length > 20) {
					this.tail.shift();
				}
				if (token) {
					if (CONNECTED.test(line) && hostname) {
						settle(() => resolve(`https://${hostname.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`));
					}
					return;
				}
				// cloudflared prints the address *before* its connection to Cloudflare registers;
				// handed out that early, the first request (the phone opening the QR link) fails.
				const match = QUICK_URL.exec(line);
				if (match) {
					quickUrl = match[0];
				}
				if (CONNECTED.test(line)) {
					connected = true;
				}
				if (quickUrl && connected) {
					const ready = quickUrl;
					settle(() => resolve(ready));
				}
			};
			// cloudflared logs everything — the address included — to stderr.
			for (const stream of [child.stdout, child.stderr]) {
				let partial = '';
				stream?.setEncoding('utf8');
				stream?.on('data', (chunk: string) => {
					const lines = (partial + chunk).split(/\r?\n/);
					partial = lines.pop() ?? '';
					lines.forEach(onLine);
				});
			}
			child.on('error', err => settle(() => reject(new Error(`Couldn't start cloudflared: ${err.message}`))));
			child.on('exit', code => {
				settle(() => reject(new Error(`cloudflared exited (code ${code}) before the tunnel was up.${this.logHint()}`)));
				if (!this.stopped) {
					onExit(code, this.tail.join('\n'));
				}
			});
		});
	}

	private logHint(): string {
		const last = this.tail.filter(line => /ERR|error|failed/i.test(line)).slice(-2).join(' / ');
		return last ? ` cloudflared said: ${last}` : '';
	}

	/** Stops the tunnel. Idempotent. */
	stop(): void {
		this.stopped = true;
		const child = this.child;
		this.child = undefined;
		if (!child || child.exitCode !== null) {
			return;
		}
		if (process.platform === 'win32' && child.pid) {
			execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone is fine */ });
		} else {
			child.kill();
		}
	}
}

/** Public resolvers used to tell "not published yet" apart from "this network blocks it". */
const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];

/** Resolves `host` through public DNS (not this machine's resolver) — true once it has an address. */
function resolvesPublicly(host: string): Promise<boolean> {
	const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
	resolver.setServers(PUBLIC_DNS);
	return new Promise(resolve => resolver.resolve4(host, (err, addresses) => resolve(!err && addresses.length > 0)));
}

/** Resolves `host` the way every other program on this machine would. */
function resolvesLocally(host: string): Promise<boolean> {
	return new Promise(resolve => dns.lookup(host, err => resolve(!err)));
}

/** How long a fresh quick-tunnel hostname may take to appear in public DNS. */
const DNS_WAIT_MS = 30_000;

/**
 * Waits until a new tunnel hostname is actually published — a trycloudflare name registers
 * about ten seconds after cloudflared reports it, and a QR code handed out before that opens to
 * "site can't be reached". Then reports whether *this* machine's resolver can see it too: some
 * ISPs' DNS refuses trycloudflare.com names outright (seen on Reliance Jio), which a phone on
 * the same network or carrier will hit as well.
 */
export async function checkTunnelDns(
	url: string,
	publicLookup: (host: string) => Promise<boolean> = resolvesPublicly,
	localLookup: (host: string) => Promise<boolean> = resolvesLocally,
	waitMs: number = DNS_WAIT_MS,
): Promise<{ published: boolean; blockedLocally: boolean }> {
	const host = new URL(url).hostname;
	const deadline = Date.now() + waitMs;
	let published = false;
	while (!published && Date.now() < deadline) {
		published = await publicLookup(host);
		if (!published) {
			await new Promise(r => setTimeout(r, 1500));
		}
	}
	if (!published) {
		return { published, blockedLocally: false };
	}
	// Local resolvers can lag public ones by a few seconds too; give them the same grace.
	for (let i = 0; i < 4; i++) {
		if (await localLookup(host)) {
			return { published, blockedLocally: false };
		}
		await new Promise(r => setTimeout(r, 1500));
	}
	return { published, blockedLocally: true };
}

/** A scratch directory for the quick tunnel's empty config file. */
export function quickTunnelConfig(dir: string = os.tmpdir()): string {
	const file = path.join(dir, 'openvs-quick-tunnel.yml');
	if (!fs.existsSync(file)) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, '# OpenVS quick tunnel: intentionally empty, see tunnel.ts\n');
	}
	return file;
}
