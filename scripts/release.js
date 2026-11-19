// Packs the universal app into release files for GitHub:
//
//   release/v<version>/Nothing-X-Mac-<version>-universal.dmg   drag-to-Applications disk image
//   release/v<version>/Nothing-X-Mac-<version>-universal.zip   zipped .app
//   release/v<version>/SHA256SUMS.txt                          checksums
//
// Run through `npm run release`, which builds the universal app first
// (npm run dist).

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { version } = require('../package.json');
const APP_NAME = 'Nothing X Mac';
const BASE = `Nothing-X-Mac-${version}-universal`;

const appPath = path.join(
  ROOT, 'src-tauri', 'target', 'universal-apple-darwin', 'release', 'bundle', 'macos', `${APP_NAME}.app`,
);
const outDir = path.join(ROOT, 'release', `v${version}`);

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  if (!fs.existsSync(appPath)) throw new Error(`Missing ${appPath}; run npm run release`);

  // Both architectures must be present in the app and the Bluetooth helper.
  for (const binary of [
    path.join(appPath, 'Contents', 'MacOS', APP_NAME),
    path.join(appPath, 'Contents', 'MacOS', 'nx-bridge'),
  ]) {
    const archs = execFileSync('lipo', ['-archs', binary]).toString().trim();
    if (!archs.includes('arm64') || !archs.includes('x86_64')) {
      throw new Error(`${path.basename(binary)} is not universal (${archs})`);
    }
  }

  // The signature must be intact after bundling.
  run('codesign', ['--verify', '--deep', '--strict', appPath]);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Zip: keeps the bundle's symlinks and signature intact.
  const zip = path.join(outDir, `${BASE}.zip`);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip]);

  // DMG: the app plus an Applications shortcut to drag it onto.
  const staging = fs.mkdtempSync(path.join(outDir, '.dmg-'));
  run('ditto', [appPath, path.join(staging, `${APP_NAME}.app`)]);
  fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
  const dmg = path.join(outDir, `${BASE}.dmg`);
  run('hdiutil', ['create', '-volname', APP_NAME, '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg]);
  fs.rmSync(staging, { recursive: true, force: true });

  const sums = [dmg, zip].map((f) => `${sha256(f)}  ${path.basename(f)}`).join('\n');
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sums}\n`);

  console.log(`\nRelease files in ${path.relative(ROOT, outDir)}:`);
  for (const f of fs.readdirSync(outDir)) {
    const { size } = fs.statSync(path.join(outDir, f));
    console.log(`  ${f}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  }
}

main();
