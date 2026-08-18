// OpenVS Relay — Cloudflare Worker + Durable Object + PWA
//
// Regenerates the PWA's PNG icon set from the real desktop app icon
// (resources/linux/code.png, the 1024x1024 master others' .ico/.icns are also built from) instead
// of hand-drawing separate PWA art. Run from anywhere with `node openvs-relay/scripts/gen-pwa-icons.js`
// (needs openvs-relay's own node_modules — `npm install` in openvs-relay/ first if missing).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'resources', 'linux', 'code.png');
const OUT = path.join(__dirname, '..', 'pwa');
const BG = '#111318'; // matches manifest.webmanifest's background_color/theme_color

async function main() {
	// "any"-purpose icons: transparent background, logo fills the frame.
	for (const size of [192, 512]) {
		await sharp(SRC)
			.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png().toFile(path.join(OUT, `icon-${size}.png`));
	}

	// Maskable 512: opaque background fill + logo confined to the ~80% safe zone, so OS masks
	// (circle, squircle, ...) never crop into the mark. See https://web.dev/articles/maskable-icon.
	const maskLogo = await sharp(SRC)
		.resize(410, 410, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.toBuffer();
	await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
		.composite([{ input: maskLogo, gravity: 'center' }])
		.png().toFile(path.join(OUT, 'icon-512-maskable.png'));

	// apple-touch-icon: iOS ignores manifest.webmanifest entirely and applies its own rounding, so
	// ship a flat opaque square (no transparency, no radius) at the size iOS actually asks for.
	const appleLogo = await sharp(SRC)
		.resize(153, 153, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.toBuffer();
	await sharp({ create: { width: 180, height: 180, channels: 4, background: BG } })
		.composite([{ input: appleLogo, gravity: 'center' }])
		.flatten({ background: BG })
		.png().toFile(path.join(OUT, 'apple-touch-icon.png'));

	console.log('Wrote icon-192.png, icon-512.png, icon-512-maskable.png, apple-touch-icon.png to', OUT);
}

main().catch(err => { console.error(err); process.exit(1); });
