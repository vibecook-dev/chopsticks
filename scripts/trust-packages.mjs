import { spawnSync } from 'node:child_process';

import { publicPackages } from './public-packages.mjs';

/**
 * npm is a .cmd shim on Windows, which Node refuses to execute without a shell
 * (bare name → ENOENT, explicit .cmd → EINVAL, since the CVE-2024-27980
 * hardening). Passing argv alongside `shell: true` concatenates it unescaped
 * and drops anything after a space in a path, so build one quoted line
 * instead. POSIX keeps the plain shell-free argv.
 */
function runNpm(args, options) {
  if (process.platform !== 'win32') return spawnSync('npm', args, options);
  const line = ['npm', ...args.map((arg) => (/[\s"]/.test(arg) ? `"${arg}"` : arg))].join(' ');
  return spawnSync(line, { ...options, shell: true });
}

const versionResult = runNpm(['--version'], { encoding: 'utf8' });

if (versionResult.status !== 0) {
  throw new Error(`could not determine the npm version: ${versionResult.error?.message ?? versionResult.stderr}`);
}

const [major, minor] = versionResult.stdout.trim().split('.').map(Number);

if (major < 11 || (major === 11 && minor < 15)) {
  throw new Error('npm 11.15 or newer is required for npm trust');
}

for (const [, packageName] of publicPackages) {
  const result = runNpm(
    [
      'trust',
      'github',
      packageName,
      '--file',
      'release.yml',
      '--repo',
      'jamesyong-42/chopsticks',
      '--allow-publish',
      '--yes',
    ],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
}
