// Builds the icons in src-tauri/icons from web/assets/logo.svg:
//
//   icon.icns       app icon: the white logo on a dark macOS-style rounded
//                   square with a soft shadow
//   icon.png        128 px copy of the app icon (Tauri's default window icon)
//   icon-1024.png   1024 px copy (README)
//   tray.png        menu bar icon: the bare logo as a template image, which
//                   macOS tints for light and dark menu bars
//
//   npm run build:icon
//
// Each size is drawn separately (so small sizes stay crisp), saved as PNG into
// an .iconset folder, and packed with macOS's iconutil.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { loadLogo, rasterizeLogo } = require('./lib/logo-raster');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'src-tauri', 'icons');
const OUT = path.join(ICONS, 'icon.icns');

// Menu bar icon. The tray always shows its image 18 pt tall, so the 14 pt logo
// is centred on an 18 pt canvas; drawn at 2x for Retina menu bars.
const TRAY = { canvasPt: 18, logoPt: 14, scale: 2 };

// Layout on the 1024 px macOS icon grid.
const GRID = 1024;
const TILE = 824; // rounded square, centred
const RADIUS = 185;
const LOGO_WIDTH = 0.56 * TILE;
const SHADOW = { offsetY: 12, blur: 28, opacity: 0.35 };
const TOP = [0x26, 0x26, 0x28]; // background gradient, top to bottom
const BOTTOM = [0x08, 0x08, 0x09];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Signed distance to a rounded rectangle centred at (cx, cy); < 0 inside.
function roundedRectDistance(x, y, cx, cy, half, radius) {
  const qx = Math.abs(x - cx) - (half - radius);
  const qy = Math.abs(y - cy) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function renderIcon(size, logo) {
  const s = size / GRID;
  const centre = size / 2;
  const half = (TILE / 2) * s;
  const radius = RADIUS * s;
  const rgba = Buffer.alloc(size * size * 4);

  // Logo, rasterized at its final size and centred on the tile.
  const logoW = Math.round(LOGO_WIDTH * s);
  const logoH = Math.round(logoW / logo.aspect);
  const logoX = Math.round(centre - logoW / 2);
  const logoY = Math.round(centre - logoH / 2);
  const logoCoverage = logoW > 0 && logoH > 0 ? rasterizeLogo(logo, logoW, logoH) : null;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // Tile coverage (anti-aliased edge) and colour.
      const d = roundedRectDistance(px, py, centre, centre, half, radius);
      const tile = clamp01(0.5 - d);
      const t = clamp01((py - (centre - half)) / (2 * half));
      let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
      let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
      let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;

      // White logo on top of the tile.
      const lx = x - logoX, ly = y - logoY;
      if (logoCoverage && lx >= 0 && ly >= 0 && lx < logoW && ly < logoH) {
        const c = Math.min(1, logoCoverage[ly * logoW + lx]);
        r += (255 - r) * c; g += (255 - g) * c; b += (255 - b) * c;
      }

      // Soft drop shadow below the tile.
      const ds = roundedRectDistance(px, py - SHADOW.offsetY * s, centre, centre, half, radius);
      const shadow = SHADOW.opacity * clamp01(1 - Math.max(ds, 0) / (SHADOW.blur * s)) ** 2;

      // Composite tile over shadow (shadow is black, so only alpha adds up).
      const alpha = tile + shadow * (1 - tile);
      const i = (y * size + x) * 4;
      if (alpha <= 0) continue;
      rgba[i] = Math.round((r * tile) / alpha);
      rgba[i + 1] = Math.round((g * tile) / alpha);
      rgba[i + 2] = Math.round((b * tile) / alpha);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

// Black logo with its coverage as alpha, centred vertically on the canvas.
function renderTray(logo) {
  const height = TRAY.canvasPt * TRAY.scale;
  const logoH = TRAY.logoPt * TRAY.scale;
  const width = Math.ceil(logoH * logo.aspect);
  const top = Math.round((height - logoH) / 2);
  const coverage = rasterizeLogo(logo, width, logoH);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < logoH; y++) {
    for (let x = 0; x < width; x++) {
      rgba[((y + top) * width + x) * 4 + 3] = Math.round(Math.min(coverage[y * width + x], 1) * 255);
    }
  }
  return { rgba, width, height };
}

// ---- minimal PNG encoder (RGBA, 8-bit) ---------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- iconset ---------------------------------------------------------------

const ICONSET = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

function main() {
  const logo = loadLogo();
  if (!logo) throw new Error('web/assets/logo.svg has no path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxm-icon-'));
  const iconset = path.join(dir, 'icon.iconset');
  fs.mkdirSync(iconset);
  const rendered = new Map();
  for (const [name, size] of ICONSET) {
    if (!rendered.has(size)) rendered.set(size, encodePng(renderIcon(size, logo), size, size));
    fs.writeFileSync(path.join(iconset, name), rendered.get(size));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', OUT], { stdio: 'inherit' });
  fs.writeFileSync(path.join(ICONS, 'icon-1024.png'), rendered.get(1024));
  fs.writeFileSync(path.join(ICONS, 'icon.png'), rendered.get(128));
  fs.rmSync(dir, { recursive: true, force: true });

  const tray = renderTray(logo);
  fs.writeFileSync(path.join(ICONS, 'tray.png'), encodePng(tray.rgba, tray.width, tray.height));

  console.log(`Built ${path.relative(ROOT, ICONS)}: icon.icns, icon.png, icon-1024.png, tray.png`);
}

main();
