/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileStore, LocalRelay } from './relayServer';
import { checkTunnelDns, findCloudflared, installCloudflared, quickTunnelConfig, Tunnel } from './tunnel';

/** SecretStorage key of the local relay's HMAC pepper — generated once, reused forever, or every paired device stops verifying. */
const PEPPER_KEY = 'openvsChat.remote.localPepper';
/** SecretStorage key of a named tunnel's connector token (see `openvsChat.remoteSetTunnel`). */
export const TUNNEL_TOKEN_KEY = 'openvsChat.remote.tunnelToken';
/** The port a named tunnel's dashboard route should point at when `openvsChat.remote.localPort` is unset. */
const NAMED_TUNNEL_DEFAULT_PORT = 8787;
/** Restart delays after cloudflared dies unexpectedly — a flaky network shouldn't need a reload. */
const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** `openvsChat.remote.relayMode`. */
export type RelayMode = 'local' | 'hosted';

/**
 * Resolves `openvsChat.remote.relayMode`: `auto` (the default) is `hosted` for anyone who
 * already set a relay URL — their deployment keeps working exactly as before — and `local`
 * for everyone else, so turning remote on needs nothing but the toggle.
 */
export function getRelayMode(): RelayMode {
	const cfg = vscode.workspace.getConfiguration('openvsChat');
	const mode = cfg.get<string>('remote.relayMode') ?? 'auto';
	if (mode === 'local' || mode === 'hosted') {
		return mode;
	}
	return cfg.get<string>('remote.relayUrl')?.trim() ? 'hosted' : 'local';
}

/** Where this extension installs its own `cloudflared` when the machine has none. */
function installDir(context: vscode.ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, 'cloudflared');
}

/** The phone app's files: shipped in the extension as `relay-pwa/`; a source checkout also has the original. */
function pwaDir(context: vscode.ExtensionContext): string {
	const candidates = [
		path.join(context.extensionPath, 'relay-pwa'),
		path.join(context.extensionPath, '..', '..', 'openvs-relay', 'pwa'),
	];
	return candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
}

/**
 * Returns a usable `cloudflared`, installing Cloudflare's official build into this extension's
 * storage when the machine has none. `askFirst` is for starts the user didn't just ask for (a
 * window opening with remote already on): those ask before downloading anything; turning remote
 * on is itself the go-ahead.
 */
export async function ensureCloudflared(context: vscode.ExtensionContext, askFirst: boolean): Promise<string | undefined> {
	const configured = vscode.workspace.getConfiguration('openvsChat').get<string>('remote.cloudflaredPath');
	const found = findCloudflared(configured, installDir(context));
	if (found) {
		return found;
	}
	if (askFirst) {
		const choice = await vscode.window.showInformationMessage(
			'OpenVS Remote reaches your phone through Cloudflare Tunnel (cloudflared), which isn\'t installed yet. Install it now? It\'s downloaded from Cloudflare\'s official GitHub releases.',
			'Install', 'Not Now');
		if (choice !== 'Install') {
			return undefined;
		}
	}
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'OpenVS Remote: installing Cloudflare Tunnel (cloudflared)…',
		cancellable: true,
	}, async (_progress, token) => {
		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());
		try {
			return await installCloudflared(installDir(context), fetch, process.platform, process.arch, controller.signal);
		} catch (err) {
			if (!controller.signal.aborted) {
				void vscode.window.showErrorMessage(`OpenVS Remote couldn't install cloudflared: ${err instanceof Error ? err.message : String(err)}`);
			}
			return undefined;
		}
	});
}

/**
 * Local hosting: runs the relay inside this extension and publishes it through Cloudflare
 * Tunnel. `RemoteService` connects the host socket straight to {@link localUrl} (no round trip
 * through Cloudflare) and hands phones {@link publicUrl} for pairing.
 */
export class LocalHosting implements vscode.Disposable {
	private relay?: LocalRelay;
	private tunnel?: Tunnel;
	private current?: Promise<string>;
	private lastUrl?: string;
	private tunnelError?: string;
	private restartAttempt = 0;
	private restartTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private warnedDns = false;
	/** Whether this network's DNS was seen refusing the quick tunnel's address — see {@link checkDns}. */
	dnsBlocked = false;
	/** Whether the tunnel is a quick one (a trycloudflare.com address) rather than the user's own named tunnel. */
	quickTunnel = true;
	/** globalState key of the last public address this room was reachable at. */
	private urlKey = '';

	/** `http://127.0.0.1:<port>` once {@link start} resolves. */
	localUrl = '';

	constructor(private readonly context: vscode.ExtensionContext, private readonly onUrlChanged: (url: string) => void) { }

	/** Starts the relay for one room, then the tunnel in the background. Resolves as soon as the relay itself listens. */
	async start(roomId: string, hostToken: string, askBeforeInstall: boolean): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('openvsChat');
		const hostname = cfg.get<string>('remote.tunnelHostname')?.trim() || undefined;
		const token = hostname ? await this.context.secrets.get(TUNNEL_TOKEN_KEY) : undefined;
		this.quickTunnel = !token;
		const configuredPort = cfg.get<number>('remote.localPort') ?? 0;
		const relay = new LocalRelay({
			pwaDir: pwaDir(this.context),
			pepper: await this.pepper(),
			store: fileStore(path.join(this.context.globalStorageUri.fsPath, 'local-relay.json')),
			port: configuredPort > 0 ? configuredPort : (token ? NAMED_TUNNEL_DEFAULT_PORT : 0),
		});
		relay.registerRoom(roomId, hostToken);
		this.urlKey = `openvsChat.remote.lastPublicUrl.${roomId}`;
		const port = await relay.start();
		this.relay = relay;
		this.localUrl = `http://127.0.0.1:${port}`;
		this.current = this.startTunnel(askBeforeInstall, token, hostname);
		// Settled here so an unwatched failure never surfaces as an unhandled rejection; callers
		// that care (pairing) await `publicUrl()` and see the real error.
		this.current.catch(() => { /* reported via status() and publicUrl() */ });
	}

	/** The public address, once the tunnel is up. Rejects with the reason it isn't. */
	publicUrl(): Promise<string> {
		return this.current ?? Promise.reject(new Error('Local hosting is not running.'));
	}

	/** One line for "Remote: Show Connection Status". */
	status(): string {
		if (!this.relay) {
			return 'local relay stopped';
		}
		if (this.tunnelError) {
			return `local relay on ${this.localUrl}, but the tunnel is down: ${this.tunnelError}`;
		}
		return this.lastUrl ? `local relay on ${this.localUrl}, reachable at ${this.lastUrl}` : `local relay on ${this.localUrl}, tunnel starting…`;
	}

	dispose(): void {
		this.disposed = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
		}
		this.tunnel?.stop();
		this.tunnel = undefined;
		void this.relay?.stop();
		this.relay = undefined;
	}

	private async pepper(): Promise<string> {
		const existing = await this.context.secrets.get(PEPPER_KEY);
		if (existing) {
			return existing;
		}
		const pepper = randomBytes(32).toString('base64url');
		await this.context.secrets.store(PEPPER_KEY, pepper);
		return pepper;
	}

	private async startTunnel(askBeforeInstall: boolean, token: string | undefined, hostname: string | undefined): Promise<string> {
		const binary = await ensureCloudflared(this.context, askBeforeInstall);
		if (!binary) {
			this.tunnelError = 'Cloudflare Tunnel (cloudflared) is not installed';
			throw new Error('OpenVS Remote needs Cloudflare Tunnel (cloudflared) to reach your phone. Run "OpenVS Thor: Remote: Install Cloudflare Tunnel", or set "openvsChat.remote.cloudflaredPath".');
		}
		if (this.disposed) {
			throw new Error('Local hosting stopped.');
		}
		const { tunnel, url } = Tunnel.start({
			binary,
			localUrl: this.localUrl,
			token,
			hostname,
			configFile: token ? undefined : quickTunnelConfig(this.context.globalStorageUri.fsPath),
		}, (code, log) => this.onTunnelExit(code, log, askBeforeInstall, token, hostname));
		this.tunnel = tunnel;
		try {
			const publicUrl = await url;
			if (!token) {
				await this.checkDns(publicUrl);
			}
			this.tunnelError = undefined;
			this.restartAttempt = 0;
			// Compared against the last address this room was published at in *any* session: a
			// quick tunnel gets a new address on every start (a VS Code restart, an idle
			// disconnect), and a phone paired at the old one can't follow it.
			const previous = this.context.globalState.get<string>(this.urlKey);
			if (previous && previous !== publicUrl) {
				this.onUrlChanged(publicUrl);
			}
			this.lastUrl = publicUrl;
			void this.context.globalState.update(this.urlKey, publicUrl);
			return publicUrl;
		} catch (err) {
			this.tunnelError = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	/**
	 * Holds a fresh quick-tunnel address back until it resolves, and warns — once per session —
	 * when this network's DNS won't resolve trycloudflare.com at all, since a phone on the same
	 * network or carrier fails the same way and nothing on the phone would say why.
	 */
	private async checkDns(publicUrl: string): Promise<void> {
		const { published, blockedLocally } = await checkTunnelDns(publicUrl);
		this.dnsBlocked = published && blockedLocally;
		if (!this.dnsBlocked || this.warnedDns) {
			return;
		}
		this.warnedDns = true;
		// Not awaited: the tunnel is ready either way, and pairing must not wait on a click.
		void vscode.window.showWarningMessage(
			'Your network’s DNS won’t resolve Cloudflare quick-tunnel addresses (*.trycloudflare.com) — some ISPs block them. A phone on this Wi-Fi or the same carrier won’t reach OpenVS Remote until its Private DNS is set to one.one.one.one (Android: Settings → Network → Private DNS), or you switch to your own Cloudflare tunnel, whose address isn’t blocked.',
			'Use My Cloudflare Tunnel').then(choice => {
			if (choice) {
				void vscode.commands.executeCommand('openvsChat.remoteSetTunnel');
			}
		});
	}

	/** cloudflared died on its own (network change, sleep/resume): bring it back with backoff. */
	private onTunnelExit(code: number | null, log: string, askBeforeInstall: boolean, token: string | undefined, hostname: string | undefined): void {
		if (this.disposed) {
			return;
		}
		console.warn(`OpenVS local relay: cloudflared exited (code ${code}); restarting.\n${log}`);
		this.tunnelError = `cloudflared exited (code ${code}), restarting`;
		const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)];
		this.restartAttempt++;
		this.restartTimer = setTimeout(() => {
			if (this.disposed) {
				return;
			}
			this.current = this.startTunnel(askBeforeInstall, token, hostname);
			this.current.catch(() => { /* reported via status() */ });
		}, delay);
	}
}
