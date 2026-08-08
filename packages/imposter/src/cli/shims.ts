/**
 * `ai shims install` (draft/IMPOSTER.md §6).
 *
 * Writes one entry per vendor name into a directory. Prepend that directory to
 * PATH and **product apps need no changes at all**: the adapter's normal launch
 * recipe finds `claude`, its detection probes are answered from the ASM, and a
 * session spawns against the imposter.
 *
 * On POSIX an entry is a plain symlink, so selection happens through argv0 —
 * the mechanism apps actually depend on, exercised rather than bypassed
 * (`process.argv[1]` through a symlink is the symlink path, probed 2026-08-08).
 * Windows cannot rely on symlinks without developer mode, so it gets a `.cmd`
 * wrapper that passes `--<vendor>` explicitly. The asymmetry is real and worth
 * knowing about: only the POSIX path proves argv0 dispatch.
 */

import { chmodSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shimNameMap } from '../persona/load.ts';

export interface ShimEntry {
  name: string;
  vendor: string;
  path: string;
}

export interface ShimInstallOptions {
  dir?: string;
  /** Absolute path to `bin/ai.mjs`; defaults to this package's own. */
  target?: string;
  /** Replace entries that already exist and do not already point at the target. */
  force?: boolean;
  names?: ReadonlyMap<string, string>;
}

export interface ShimInstallResult {
  dir: string;
  target: string;
  written: ShimEntry[];
  /** Entries already pointing at the target — installing twice is not an error. */
  unchanged: ShimEntry[];
  conflicts: Array<{ name: string; path: string; reason: string }>;
}

/** Beside the control socket, so everything the imposter owns lives in one place. */
export function defaultShimDirectory(): string {
  return join(homedir(), '.chopsticks', 'shims');
}

export function imposterBinPath(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin', 'ai.mjs');
}

function windowsWrapper(target: string, vendor: string): string {
  return ['@echo off', `node "${target}" --${vendor} %*`, ''].join('\r\n');
}

export function installShims(options: ShimInstallOptions = {}): ShimInstallResult {
  const dir = resolve(options.dir ?? defaultShimDirectory());
  const target = resolve(options.target ?? imposterBinPath());
  const names = options.names ?? shimNameMap();
  const result: ShimInstallResult = { dir, target, written: [], unchanged: [], conflicts: [] };

  mkdirSync(dir, { recursive: true, mode: 0o755 });
  // The published package gets the bit from npm, but a repo checkout runs the
  // file straight from src — a shim to a non-executable target is a confusing
  // ENOENT-shaped failure at spawn time.
  chmodSync(target, 0o755);

  for (const [name, vendor] of [...names].sort(([left], [right]) => left.localeCompare(right))) {
    const windows = process.platform === 'win32';
    const path = join(dir, windows ? `${name}.cmd` : name);
    const entry: ShimEntry = { name, vendor, path };

    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(path);
    } catch {
      existing = undefined;
    }
    if (existing) {
      const alreadyOurs = windows ? false : existing.isSymbolicLink() && readlinkSync(path) === target;
      if (alreadyOurs) {
        result.unchanged.push(entry);
        continue;
      }
      if (!options.force) {
        result.conflicts.push({ name, path, reason: 'already exists; pass --force to replace it' });
        continue;
      }
      rmSync(path, { force: true });
    }

    if (windows) {
      writeFileSync(path, windowsWrapper(target, vendor));
    } else {
      symlinkSync(target, path);
    }
    result.written.push(entry);
  }
  return result;
}

export function listShims(names: ReadonlyMap<string, string> = shimNameMap()): ShimEntry[] {
  const dir = defaultShimDirectory();
  return [...names]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, vendor]) => ({ name, vendor, path: join(dir, process.platform === 'win32' ? `${name}.cmd` : name) }));
}

/** `ai shims <subcommand>`; returns the process exit code. */
export function runShimsCommand(argv: readonly string[], write = process.stdout.write.bind(process.stdout)): number {
  const subcommand = argv[0];
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;

  if (subcommand === 'list') {
    for (const entry of listShims()) write(`${entry.name.padEnd(12)} ${entry.vendor}\n`);
    return 0;
  }
  if (subcommand !== 'install') {
    process.stderr.write('usage: ai shims install [--dir <directory>] [--force]\n       ai shims list\n');
    return 2;
  }
  if (dirIndex >= 0 && !dir) {
    process.stderr.write('ai shims install: --dir needs a directory\n');
    return 2;
  }

  const result = installShims({ ...(dir ? { dir } : {}), force: argv.includes('--force') });
  for (const entry of result.written) write(`installed ${entry.path} -> ${entry.vendor}\n`);
  for (const entry of result.unchanged) write(`unchanged ${entry.path}\n`);
  for (const conflict of result.conflicts) process.stderr.write(`skipped ${conflict.path}: ${conflict.reason}\n`);
  if (result.written.length > 0 || result.unchanged.length > 0) {
    write(`\nPrepend it to PATH so apps find these first:\n  export PATH="${result.dir}:$PATH"\n`);
  }
  return result.conflicts.length > 0 ? 1 : 0;
}
