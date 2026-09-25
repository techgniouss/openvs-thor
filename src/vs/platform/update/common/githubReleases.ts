/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUpdate } from './update.js';

/**
 * Updates from a repository's GitHub Releases, used when product.json's `updateUrl` is a
 * `https://github.com/<owner>/<repo>` address rather than a Microsoft-style update server.
 *
 * The update server protocol answers "is there anything newer than commit X" itself; here
 * the client reads the latest published release and decides. A release is an update when its
 * tag (`v1.2.3` or `1.2.3`) is a higher version than the running build and it carries the
 * installer asset for this install type. That second condition matters: the release workflow
 * attaches installers only once the build finishes, so for the hour or so after publishing, the
 * latest release exists without them and must read as "nothing yet", not as an error.
 */

export interface IGitHubReleaseAsset {
	readonly name: string;
	readonly browser_download_url: string;
	/** `sha256:<hex>`, present on assets uploaded since mid-2025. */
	readonly digest?: string | null;
	/** `open` while the upload is still in progress, `uploaded` once it is complete. */
	readonly state?: string;
}

export interface IGitHubRelease {
	readonly tag_name: string;
	readonly html_url: string;
	readonly name?: string | null;
	/** The release description, as GitHub-flavored markdown. */
	readonly body?: string | null;
	readonly draft?: boolean;
	readonly prerelease?: boolean;
	readonly published_at?: string | null;
	readonly assets: readonly IGitHubReleaseAsset[];
}

const GITHUB_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/**
 * Returns `owner/repo` when `updateUrl` names a GitHub repository, otherwise `undefined`.
 */
export function parseGitHubReleasesRepo(updateUrl: string | undefined): string | undefined {
	const match = updateUrl ? GITHUB_REPO_URL.exec(updateUrl) : null;
	return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * The API endpoint for a repository's latest release. GitHub excludes drafts and
 * prereleases from it, so publishing a prerelease never offers it as an update.
 */
export function gitHubLatestReleaseUrl(repo: string): string {
	return `https://api.github.com/repos/${repo}/releases/latest`;
}

/**
 * The API endpoint for the release a given product version was built from. The release
 * workflow only accepts `v`-prefixed version tags, which is what makes this exact.
 */
export function gitHubReleaseByVersionUrl(repo: string, version: string): string {
	return `https://api.github.com/repos/${repo}/releases/tags/v${encodeURIComponent(version)}`;
}

/**
 * Markdown for the Release Notes editor: the release's own title and description. The editor
 * requires a leading `# ` heading, and a release published without a description still gets
 * one, plus `emptyBody` in place of the notes.
 */
export function gitHubReleaseNotesMarkdown(release: IGitHubRelease, version: string, emptyBody: string): string {
	const title = release.name?.trim() || version;
	const body = release.body?.trim();
	return `# ${title}\n\n${body || emptyBody}\n`;
}

/**
 * Parses `v1.2.3` / `1.2.3` / `1.2.3-dev` into its numeric parts, or `undefined` when the
 * string is not a version at all (a tag like `nightly` must never be read as an update).
 */
function parseVersion(value: string): number[] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Strips the tag's leading `v`, returning the product version a release was built as.
 */
export function releaseVersion(release: IGitHubRelease): string | undefined {
	const parts = parseVersion(release.tag_name);
	return parts ? parts.join('.') : undefined;
}

/**
 * `true` when `candidate` is a strictly higher version than `current`. Unparseable input on
 * either side answers `false`: offering an update we cannot order is how an install ends up
 * reinstalling the same build every hour.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const a = parseVersion(candidate);
	const b = parseVersion(current);
	if (!a || !b) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return a[i] > b[i];
		}
	}
	return false;
}

/**
 * Maps the latest release to an update, or `undefined` when there is nothing to install.
 *
 * @param currentVersion the running version, or the version of an update already downloaded
 *   (the overwrite check asks whether something newer than *that* has appeared since).
 * @param assetName the installer's file name for a given version, or `undefined` for installs
 *   that cannot update themselves (a zip), which are pointed at the release page instead.
 */
export function releaseToUpdate(release: IGitHubRelease, currentVersion: string, assetName: ((version: string) => string) | undefined): IUpdate | undefined {
	if (release.draft || release.prerelease) {
		return undefined;
	}

	const version = releaseVersion(release);
	if (!version || !isNewerVersion(version, currentVersion)) {
		return undefined;
	}

	const timestamp = release.published_at ? Date.parse(release.published_at) : NaN;
	const update: IUpdate = {
		version,
		productVersion: version,
		timestamp: isNaN(timestamp) ? undefined : timestamp,
		url: release.html_url,
	};

	if (!assetName) {
		return update;
	}

	const name = assetName(version);
	// An asset is listed as soon as its upload starts; downloading it before then gets a
	// partial file, which only a digest (absent while uploading) would have caught.
	const asset = release.assets.find(a => a.name === name && (a.state === undefined || a.state === 'uploaded'));
	if (!asset) {
		return undefined;
	}

	const digest = asset.digest && /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
	return {
		...update,
		url: asset.browser_download_url,
		sha256hash: digest ? digest[1].toLowerCase() : undefined,
	};
}
