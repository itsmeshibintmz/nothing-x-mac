// Builds the icons in src-tauri/icons from web/assets/logo.svg:
//
//   icon.icns       app icon: the white logo on a dark macOS-style rounded
//                   square with a soft shadow
//   icon.png        128 px copy of the app icon (Tauri's default window icon)
//   icon-1024.png   1024 px copy (README)
//   icon.ico        Windows app icon: the same tile, filling more of the square
//   tray.png        menu bar icon: the bare logo as a template image, which
//                   macOS tints for light and dark menu bars
//   tray-windows-light.png / tray-windows-dark.png
//                   Windows tray icon: white logo for a dark taskbar, dark
//                   logo for a light one (Windows doesn't tint tray icons)
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

// Layouts on a 1024 px grid: a centred rounded square (tile) with the logo on it.
const GRID = 1024;
const LOGO_SHARE = 0.56; // logo width as a share of the tile
// macOS icons leave a margin for the system's drop shadow.
const MAC_LAYOUT = { tile: 824, radius: 185, shadow: { offsetY: 12, blur: 28, opacity: 0.35 } };
// Windows icons fill the square and have no shadow of their own.
const WINDOWS_LAYOUT = { tile: 976, radius: 210, shadow: null };
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Windows tray icon: the logo fitted into a square, drawn at 2x (16 pt tray slot).
const WINDOWS_TRAY = { size: 32, logoBox: 28 };
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

function renderIcon(size, logo, layout = MAC_LAYOUT) {
  const s = size / GRID;
  const centre = size / 2;
  const half = (layout.tile / 2) * s;
  const radius = layout.radius * s;
  const rgba = Buffer.alloc(size * size * 4);

  // Logo, rasterized at its final size and centred on the tile.
  const logoW = Math.round(LOGO_SHARE * layout.tile * s);
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
      let shadow = 0;
      if (layout.shadow) {
        const { offsetY, blur, opacity } = layout.shadow;
        const ds = roundedRectDistance(px, py - offsetY * s, centre, centre, half, radius);
        shadow = opacity * clamp01(1 - Math.max(ds, 0) / (blur * s)) ** 2;
      }

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

// The logo in one flat colour, fitted into a square canvas and centred.
function renderWindowsTray(logo, [r, g, b]) {
  const { size, logoBox } = WINDOWS_TRAY;
  const logoW = logo.aspect >= 1 ? logoBox : Math.round(logoBox * logo.aspect);
  const logoH = logo.aspect >= 1 ? Math.round(logoBox / logo.aspect) : logoBox;
  const left = Math.round((size - logoW) / 2);
  const top = Math.round((size - logoH) / 2);
  const coverage = rasterizeLogo(logo, logoW, logoH);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < logoH; y++) {
    for (let x = 0; x < logoW; x++) {
      const i = ((y + top) * size + (x + left)) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b;
      rgba[i + 3] = Math.round(Math.min(coverage[y * logoW + x], 1) * 255);
    }
  }
  return encodePng(rgba, size, size);
}

// ---- .ico container ----------------------------------------------------------

// One icon image as a 32-bit bitmap, the format every Windows tool accepts for
// sizes below 256: header, BGRA rows bottom-up, then an (empty) 1-bit mask.
function encodeIcoBitmap(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour rows + mask rows
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  // Mask rows are padded to 32 bits; all zero because alpha does the job.
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

// images: [{ size, data }] where data is a bitmap (above) or, for 256 px, a PNG.
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = header.length + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // 0 means 256
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
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

  const ico = ICO_SIZES.map((size) => {
    const rgba = renderIcon(size, logo, WINDOWS_LAYOUT);
    return { size, data: size === 256 ? encodePng(rgba, size, size) : encodeIcoBitmap(rgba, size) };
  });
  fs.writeFileSync(path.join(ICONS, 'icon.ico'), encodeIco(ico));
  fs.writeFileSync(path.join(ICONS, 'tray-windows-light.png'), renderWindowsTray(logo, [255, 255, 255]));
  fs.writeFileSync(path.join(ICONS, 'tray-windows-dark.png'), renderWindowsTray(logo, [0, 0, 0]));

  console.log(`Built ${path.relative(ROOT, ICONS)}: icon.icns, icon.ico, icon.png, icon-1024.png and tray icons`);
}

main();
