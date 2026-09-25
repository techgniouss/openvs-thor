/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { gitHubReleaseByVersionUrl, gitHubReleaseNotesMarkdown, IGitHubRelease, isNewerVersion, parseGitHubReleasesRepo, releaseToUpdate } from '../../common/githubReleases.js';

suite('GitHub Releases update feed', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const userAsset = (version: string) => `OpenVSUserSetup-x64-${version}.exe`;

	function release(overrides: Partial<IGitHubRelease> = {}): IGitHubRelease {
		return {
			tag_name: 'v1.128.0',
			html_url: 'https://github.com/o/r/releases/tag/v1.128.0',
			published_at: '2026-09-01T00:00:00Z',
			assets: [
				{ name: 'OpenVSSetup-x64-1.128.0.exe', browser_download_url: 'https://github.com/o/r/releases/download/v1.128.0/OpenVSSetup-x64-1.128.0.exe', digest: null },
				{ name: 'OpenVSUserSetup-x64-1.128.0.exe', browser_download_url: 'https://github.com/o/r/releases/download/v1.128.0/OpenVSUserSetup-x64-1.128.0.exe', digest: 'sha256:' + 'AB'.repeat(32) },
			],
			...overrides,
		};
	}

	test('parseGitHubReleasesRepo', () => {
		assert.deepStrictEqual([
			'https://github.com/techgniouss/openvs-thor',
			'https://github.com/techgniouss/openvs-thor/',
			'https://github.com/techgniouss/openvs-thor.git',
			'https://update.code.visualstudio.com',
			'https://github.com/techgniouss',
			'https://github.com/o/r/releases',
			'http://github.com/o/r',
			undefined,
		].map(parseGitHubReleasesRepo), [
			'techgniouss/openvs-thor',
			'techgniouss/openvs-thor',
			'techgniouss/openvs-thor',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('isNewerVersion', () => {
		assert.deepStrictEqual([
			isNewerVersion('1.128.0', '1.127.0'),
			isNewerVersion('v1.127.1', '1.127.0'),
			isNewerVersion('2.0.0', '1.999.999'),
			isNewerVersion('1.127.0', '1.127.0'),
			isNewerVersion('1.126.9', '1.127.0'),
			isNewerVersion('1.10.0', '1.9.0'), // numeric, not lexical
			isNewerVersion('1.128.0', '1.127.0-dev'),
			isNewerVersion('nightly', '1.127.0'),
			isNewerVersion('1.128.0', 'unknown'),
		], [true, true, true, false, false, true, true, false, false]);
	});

	test('newer release with the installer maps to an update, with its checksum', () => {
		assert.deepStrictEqual(releaseToUpdate(release(), '1.127.0', userAsset), {
			version: '1.128.0',
			productVersion: '1.128.0',
			timestamp: Date.parse('2026-09-01T00:00:00Z'),
			url: 'https://github.com/o/r/releases/download/v1.128.0/OpenVSUserSetup-x64-1.128.0.exe',
			sha256hash: 'ab'.repeat(32),
		});
	});

	test('asset without a digest downloads unverified rather than not at all', () => {
		const update = releaseToUpdate(release(), '1.127.0', v => `OpenVSSetup-x64-${v}.exe`);
		assert.deepStrictEqual([update?.url, update?.sha256hash], ['https://github.com/o/r/releases/download/v1.128.0/OpenVSSetup-x64-1.128.0.exe', undefined]);
	});

	test('no update: same or older version, not yet built, prerelease, non-version tag', () => {
		assert.deepStrictEqual([
			releaseToUpdate(release(), '1.128.0', userAsset),
			releaseToUpdate(release(), '1.129.0', userAsset),
			releaseToUpdate(release({ assets: [] }), '1.127.0', userAsset),
			releaseToUpdate(release({ prerelease: true }), '1.127.0', userAsset),
			releaseToUpdate(release({ tag_name: 'latest' }), '1.127.0', userAsset),
			// An installer from a different version must not be taken for this one.
			releaseToUpdate(release({ tag_name: 'v1.129.0' }), '1.127.0', userAsset),
			// Listed while its upload is still in progress.
			releaseToUpdate(release({ assets: [{ name: 'OpenVSUserSetup-x64-1.128.0.exe', browser_download_url: 'https://x/y.exe', state: 'open' }] }), '1.127.0', userAsset),
		], [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('release notes come from the version\'s own v-tagged release', () => {
		assert.deepStrictEqual([
			gitHubReleaseByVersionUrl('o/r', '1.128.0'),
			gitHubReleaseNotesMarkdown(release({ name: 'OpenVS 1.128', body: '## Fixes\r\n- one\n' }), '1.128.0', 'none'),
			gitHubReleaseNotesMarkdown(release({ name: '  ', body: null }), '1.128.0', 'No notes.'),
		], [
			'https://api.github.com/repos/o/r/releases/tags/v1.128.0',
			'# OpenVS 1.128\n\n## Fixes\r\n- one\n',
			'# 1.128.0\n\nNo notes.\n',
		]);
	});

	test('zip installs are pointed at the release page', () => {
		assert.deepStrictEqual(releaseToUpdate(release({ assets: [] }), '1.127.0', undefined)?.url, 'https://github.com/o/r/releases/tag/v1.128.0');
	});
});
