/*---------------------------------------------------------------------------------------------
 *  Copyright (c) OpenVS. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';

/**
 * Windows DPAPI (`CryptUnprotectData`) via a `powershell.exe` one-liner — the zero-dependency
 * way to reach it from Node, which has no built-in binding and for which adding a native
 * addon (node-gyp, a C++ toolchain, prebuilt binaries per Electron ABI) would be a much
 * heavier cost than one `child_process` call. Chrome wraps its cookie-encryption master key
 * with DPAPI bound to the signed-in Windows user — this unwraps exactly that one small blob
 * (tens of bytes), once, not anything per-cookie (see `chromeCookies.ts`, which does the
 * per-cookie AES-256-GCM decryption with Node's built-in `crypto` instead).
 */

const POWERSHELL_TIMEOUT_MS = 15_000;

function runPowerShell(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error(`powershell.exe failed: ${(stderr || err.message).trim()}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

/**
 * Unwraps `blob` with `CryptUnprotectData` under `CURRENT_USER` scope — the same scope Chrome
 * wraps its master key with. Returns `undefined` on any non-Windows platform or failure
 * (a missing/renamed profile, a blob from a different user, PowerShell unavailable) rather
 * than throwing, so callers can fall back honestly instead of crashing the provider.
 *
 * The blob is base64-encoded into the PowerShell command line. Safe to do so — the base64
 * alphabet (`A-Za-z0-9+/=`) contains no characters PowerShell's single-quoted string or
 * command-line parsing treats specially, and the input here is always locally-derived bytes
 * (the small DPAPI-wrapped key from Chrome's own `Local State`), never anything remote.
 */
export async function dpapiUnprotectCurrentUser(blob: Buffer): Promise<Buffer | undefined> {
	if (process.platform !== 'win32') {
		return undefined;
	}
	const script = [
		'Add-Type -AssemblyName System.Security',
		`$bytes = [Convert]::FromBase64String('${blob.toString('base64')}')`,
		'$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
		'[Convert]::ToBase64String($plain)',
	].join('; ');
	try {
		const stdout = await runPowerShell(script);
		const trimmed = stdout.trim();
		return trimmed ? Buffer.from(trimmed, 'base64') : undefined;
	} catch {
		return undefined;
	}
}
