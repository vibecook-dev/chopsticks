import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { packageManagerInvocation } from './package-manager.mjs';

test('resolves Windows-style npm and pnpm JavaScript entry points without a shell', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chopsticks-package-manager-'));
  try {
    const node = join(directory, 'bin', 'node.exe');
    const npm = join(directory, 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const pnpm = join(directory, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    mkdirSync(join(npm, '..'), { recursive: true });
    mkdirSync(join(pnpm, '..'), { recursive: true });
    writeFileSync(npm, '');
    writeFileSync(pnpm, '');

    assert.deepEqual(packageManagerInvocation('npm', {}, node), { command: node, prefixArgs: [npm] });
    assert.deepEqual(packageManagerInvocation('pnpm', {}, node), { command: node, prefixArgs: [pnpm] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('supports an explicit CLI entry override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chopsticks-package-manager-'));
  try {
    const cli = join(directory, 'pnpm.mjs');
    writeFileSync(cli, '');
    assert.deepEqual(packageManagerInvocation('pnpm', { CHOPSTICKS_PNPM_CLI: cli }, '/node'), {
      command: '/node',
      prefixArgs: [cli],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not mistake the pnpm lifecycle CLI for npm', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chopsticks-package-manager-'));
  try {
    const node = join(directory, 'bin', 'node');
    const npm = join(directory, 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const pnpm = join(directory, 'pnpm.cjs');
    mkdirSync(join(npm, '..'), { recursive: true });
    writeFileSync(npm, '');
    writeFileSync(pnpm, '');

    assert.deepEqual(packageManagerInvocation('npm', { npm_execpath: pnpm }, node), {
      command: node,
      prefixArgs: [npm],
    });
    assert.deepEqual(packageManagerInvocation('pnpm', { npm_execpath: pnpm }, node), {
      command: node,
      prefixArgs: [pnpm],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('finds pnpm where pnpm/action-setup puts it, with no npm_execpath', () => {
  // The exact layout CI uses, and the one that broke the pack-check step:
  // PNPM_HOME points at `node_modules/.bin`, one level BELOW the package, so
  // the CLI is only reachable by looking UP from it.
  const directory = mkdtempSync(join(tmpdir(), 'chopsticks-package-manager-'));
  try {
    const home = join(directory, 'setup-pnpm', 'node_modules', '.bin');
    const cli = join(directory, 'setup-pnpm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(cli, '..'), { recursive: true });
    writeFileSync(cli, '');

    // A bare node directory, so nothing "conventional" can satisfy this.
    const node = join(directory, 'node');
    writeFileSync(node, '');
    assert.deepEqual(packageManagerInvocation('pnpm', { PNPM_HOME: home }, node), {
      command: node,
      prefixArgs: [cli],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('still reports a missing CLI rather than guessing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chopsticks-package-manager-'));
  try {
    const node = join(directory, 'node');
    writeFileSync(node, '');
    assert.throws(() => packageManagerInvocation('pnpm', { PNPM_HOME: directory }, node), /could not locate/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
