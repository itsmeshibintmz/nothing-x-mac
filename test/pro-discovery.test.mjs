import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('macOS discovery retries an incomplete peripheral after cooldown or reconnect', { skip: process.platform !== 'darwin' }, t => {
  const temp = mkdtempSync(join(tmpdir(), 'nx-discovery-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../native/mac/ProDiscovery.swift', import.meta.url));
  const checks = fileURLToPath(new URL('pro-discovery.swift', import.meta.url));
  const binary = join(temp, 'check');
  execFileSync('swiftc', ['-module-cache-path', join(temp, 'modules'), source, checks, '-o', binary]);
  execFileSync(binary);
});
