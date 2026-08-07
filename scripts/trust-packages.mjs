import { publicPackages } from './public-packages.mjs';
import { spawnPackageManager } from './package-manager.mjs';

const versionResult = spawnPackageManager('npm', ['--version'], { encoding: 'utf8' });

if (versionResult.status !== 0) {
  throw new Error(`could not determine the npm version: ${versionResult.error?.message ?? versionResult.stderr}`);
}

const [major, minor] = versionResult.stdout.trim().split('.').map(Number);

if (!Number.isInteger(major) || !Number.isInteger(minor)) {
  throw new Error(`could not parse the npm version: ${versionResult.stdout.trim()}`);
}

if (major < 11 || (major === 11 && minor < 15)) {
  throw new Error('npm 11.15 or newer is required for npm trust');
}

for (const [, packageName] of publicPackages) {
  const result = spawnPackageManager(
    'npm',
    [
      'trust',
      'github',
      packageName,
      '--file',
      'release.yml',
      '--repo',
      'vibecook-dev/chopsticks',
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
