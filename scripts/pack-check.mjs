import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicPackages } from './public-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = mkdtempSync(join(tmpdir(), 'chopsticks-packs-'));

/**
 * pnpm is a .cmd shim on Windows, which Node refuses to execute without a
 * shell (bare name → ENOENT, explicit .cmd → EINVAL, since the CVE-2024-27980
 * hardening). Passing argv alongside `shell: true` concatenates it unescaped
 * and drops anything after a space in a path, so build one quoted line
 * instead. POSIX keeps the plain shell-free argv.
 */
function packCommand(args) {
  if (process.platform !== 'win32') return spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  const line = ['pnpm', ...args.map((arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg))].join(' ');
  return spawnSync(line, { cwd: root, stdio: 'inherit', shell: true });
}

try {
  for (const [directory] of publicPackages) {
    const result = packCommand(['--dir', directory, 'pack', '--pack-destination', destination]);

    if (result.status !== 0) {
      throw new Error(`Failed to pack ${directory}`);
    }
  }

  const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz'));

  if (tarballs.length !== publicPackages.length) {
    throw new Error(`Expected ${publicPackages.length} tarballs, found ${tarballs.length}`);
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
