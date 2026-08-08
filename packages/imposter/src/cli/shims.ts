/**
 * Getting `ai` onto PATH, two ways (draft/IMPOSTER.md §6).
 *
 * `ai link` writes `ai` and `imposter` into `~/.chopsticks/bin`. That directory
 * shadows nothing, so it is safe to leave on PATH permanently: `claude` still
 * runs Claude Code, `codex` still runs Codex, and the imposter is reached by
 * asking for it — `ai --claude`, `ai --codex`.
 *
 * `ai shims install` writes VENDOR names (`claude`, `codex`, …) into
 * `~/.chopsticks/shims`, which does shadow the real binaries wherever it is
 * prepended. That is the whole point of it — a product app's normal launch
 * recipe finds `claude`, its detection probes are answered from the ASM, and a
 * session spawns against the imposter with no app changes at all — but it is a
 * deliberate, temporary act, and the two directories are kept apart so it can
 * never happen by accident.
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
  /** The persona this name selects. Absent for `ai`/`imposter`, which select none. */
  vendor?: string;
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

/** The tool's own names. Neither selects a persona: `ai --claude` does that. */
export const SELF_NAMES = ['ai', 'imposter'] as const;

/** Safe to keep on PATH forever — nothing here shares a name with a real agent. */
export function defaultBinDirectory(): string {
  return join(homedir(), '.chopsticks', 'bin');
}

/** Vendor names. Shadows the real binaries wherever it is prepended. */
export function defaultShimDirectory(): string {
  return join(homedir(), '.chopsticks', 'shims');
}

export function imposterBinPath(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin', 'ai.mjs');
}

function windowsWrapper(target: string, vendor?: string): string {
  return ['@echo off', `node "${target}"${vendor ? ` --${vendor}` : ''} %*`, ''].join('\r\n');
}

function installEntries(
  entries: ReadonlyArray<{ name: string; vendor?: string }>,
  options: ShimInstallOptions,
  defaultDir: string,
): ShimInstallResult {
  const dir = resolve(options.dir ?? defaultDir);
  const target = resolve(options.target ?? imposterBinPath());
  const result: ShimInstallResult = { dir, target, written: [], unchanged: [], conflicts: [] };

  mkdirSync(dir, { recursive: true, mode: 0o755 });
  // The published package gets the bit from npm, but a repo checkout runs the
  // file straight from src — a shim to a non-executable target is a confusing
  // ENOENT-shaped failure at spawn time.
  chmodSync(target, 0o755);

  for (const { name, vendor } of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const windows = process.platform === 'win32';
    const path = join(dir, windows ? `${name}.cmd` : name);
    const entry: ShimEntry = { name, ...(vendor === undefined ? {} : { vendor }), path };

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

    if (windows) writeFileSync(path, windowsWrapper(target, vendor));
    else symlinkSync(target, path);
    result.written.push(entry);
  }
  return result;
}

/** Vendor-named entries, from the personas that ship. */
export function installShims(options: ShimInstallOptions = {}): ShimInstallResult {
  const names = options.names ?? shimNameMap();
  return installEntries(
    [...names].map(([name, vendor]) => ({ name, vendor })),
    options,
    defaultShimDirectory(),
  );
}

/** `ai` and `imposter` themselves. */
export function installSelf(options: ShimInstallOptions = {}): ShimInstallResult {
  return installEntries(
    SELF_NAMES.map((name) => ({ name })),
    options,
    defaultBinDirectory(),
  );
}

export function listShims(names: ReadonlyMap<string, string> = shimNameMap()): ShimEntry[] {
  const dir = defaultShimDirectory();
  return [...names]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, vendor]) => ({ name, vendor, path: join(dir, process.platform === 'win32' ? `${name}.cmd` : name) }));
}

function report(result: ShimInstallResult, write: (text: string) => void, hint: string): number {
  for (const entry of result.written) write(`installed ${entry.path}${entry.vendor ? ` -> ${entry.vendor}` : ''}\n`);
  for (const entry of result.unchanged) write(`unchanged ${entry.path}\n`);
  for (const conflict of result.conflicts) process.stderr.write(`skipped ${conflict.path}: ${conflict.reason}\n`);
  if (result.written.length > 0 || result.unchanged.length > 0) write(`\n${hint.replace('{DIR}', result.dir)}`);
  return result.conflicts.length > 0 ? 1 : 0;
}

/** `ai link`; returns the process exit code. */
export function runLinkCommand(argv: readonly string[], write = process.stdout.write.bind(process.stdout)): number {
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
  if (dirIndex >= 0 && !dir) {
    process.stderr.write('ai link: --dir needs a directory\n');
    return 2;
  }
  const result = installSelf({ ...(dir ? { dir } : {}), force: argv.includes('--force') });
  return report(
    result,
    write,
    'Add it to PATH — it shadows no real agent, so this is safe to keep:\n' +
      '  export PATH="{DIR}:$PATH"\n\nThen: ai --claude · ai --codex\n',
  );
}

/** `ai shims <subcommand>`; returns the process exit code. */
export function runShimsCommand(argv: readonly string[], write = process.stdout.write.bind(process.stdout)): number {
  const subcommand = argv[0];
  const dirIndex = argv.indexOf('--dir');
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;

  if (subcommand === 'list') {
    for (const entry of listShims()) write(`${entry.name.padEnd(12)} ${entry.vendor ?? ''}\n`);
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
  return report(
    result,
    write,
    'These SHADOW the real agents. Prepend it only while you want that:\n  export PATH="{DIR}:$PATH"\n',
  );
}
