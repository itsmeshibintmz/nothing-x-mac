// Build the Tauri app icon, macOS appearance catalog and template tray icon.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'src-tauri', 'icons');
const SOURCE = path.join(ICONS, 'icon-source.png');
const COMPOSER = path.join(ICONS, 'AppIcon.icon');
const ASSETS = path.join(ROOT, 'build', 'app-icon-assets');
const SLOTS = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

function resize(input, output, size) {
  execFileSync('sips', [
    '-s', 'format', 'png', '-z', String(size), String(size),
    input, '--out', output,
  ], { stdio: 'ignore' });
}

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nxm-icon-'));
  try {
    const compiled = path.join(temp, 'compiled');
    const iconset = path.join(temp, 'icon.iconset');
    fs.mkdirSync(compiled);
    fs.mkdirSync(iconset);
    execFileSync('xcrun', [
      'actool', COMPOSER, '--compile', compiled, '--app-icon', 'AppIcon',
      '--include-all-app-icons', '--enable-on-demand-resources', 'NO',
      '--development-region', 'en', '--target-device', 'mac',
      '--minimum-deployment-target', '13.0', '--platform', 'macosx',
      '--output-partial-info-plist', path.join(temp, 'partial-info.plist'),
    ], { stdio: 'inherit' });
    for (const [name, size] of SLOTS) resize(SOURCE, path.join(iconset, name), size);
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ICONS, 'icon.icns')], { stdio: 'inherit' });
    resize(SOURCE, path.join(ICONS, 'icon.png'), 128);
    fs.copyFileSync(SOURCE, path.join(ICONS, 'icon-1024.png'));
    execFileSync('swift', [
      path.join(__dirname, 'build-tray-icon.swift'),
      path.join(ROOT, 'web', 'assets', 'earbud-x.png'),
      path.join(ICONS, 'tray.png'),
    ], { stdio: 'inherit' });
    fs.mkdirSync(ASSETS, { recursive: true });
    fs.copyFileSync(path.join(compiled, 'Assets.car'), path.join(ASSETS, 'Assets.car'));
    console.log('Built Tauri app, menu bar and macOS appearance icons');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main();
