/**
 * Shim installation, verified by actually running an installed shim.
 *
 * The assertion that matters is the last one: a symlink named `claude`,
 * executed directly, answers the vendor's own `--version` from the ASM. That is
 * the whole mechanism apps depend on — PATH-prepend and the adapter's normal
 * launch recipe finds it (draft/IMPOSTER.md §6).
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultBinDirectory,
  defaultShimDirectory,
  imposterBinPath,
  installSelf,
  installShims,
  listShims,
  runLinkCommand,
  runShimsCommand,
} from './shims.ts';

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'chopsticks-shims-'));
  temporaries.push(path);
  return path;
}

const posix = process.platform !== 'win32';

describe('ai shims install', () => {
  it('writes one entry per persona shim name, pointing at bin/ai.mjs', () => {
    const dir = temporaryDirectory();
    const result = installShims({ dir });
    expect(result.written.map((entry) => entry.name)).toContain('claude');
    expect(result.conflicts).toEqual([]);
    expect(result.target).toBe(imposterBinPath());
    if (posix) expect(readlinkSync(join(dir, 'claude'))).toBe(imposterBinPath());
  });

  it('is idempotent: a second install reports unchanged rather than failing', () => {
    const dir = temporaryDirectory();
    installShims({ dir });
    const again = installShims({ dir });
    expect(again.written).toEqual([]);
    expect(again.unchanged.map((entry) => entry.name)).toContain('claude');
    expect(again.conflicts).toEqual([]);
  });

  it('refuses to clobber something it did not write, unless forced', () => {
    const dir = temporaryDirectory();
    const occupied = join(dir, posix ? 'claude' : 'claude.cmd');
    writeFileSync(occupied, 'the real thing');
    // One occupied name must not block the others: the conflict is per-entry.
    const blocked = installShims({ dir });
    expect(blocked.written.map((entry) => entry.name)).not.toContain('claude');
    expect(blocked.conflicts.map((conflict) => conflict.name)).toEqual(['claude']);

    const forced = installShims({ dir, force: true });
    expect(forced.written.map((entry) => entry.name)).toContain('claude');
    expect(forced.conflicts).toEqual([]);
  });

  it('leaves the target executable, so the shim is not a confusing ENOENT', () => {
    installShims({ dir: temporaryDirectory() });
    expect(lstatSync(imposterBinPath()).mode & 0o111).toBeGreaterThan(0);
  });

  it.skipIf(!posix)('runs: an installed `claude` answers the vendor version through argv0', () => {
    const dir = temporaryDirectory();
    installShims({ dir });
    const output = execFileSync(join(dir, 'claude'), ['--version'], { encoding: 'utf8' });
    expect(output.trim()).toMatch(/Claude Code/);
  });

  it('lists the entries it would install without touching the filesystem', () => {
    const entries = listShims();
    expect(entries.map((entry) => entry.name)).toContain('claude');
    expect(entries.every((entry) => entry.path.startsWith(defaultShimDirectory()))).toBe(true);
  });

  it('reports usage for an unknown subcommand instead of installing something', () => {
    const lines: string[] = [];
    expect(
      runShimsCommand(['wat'], ((chunk: string) => {
        lines.push(chunk);
        return true;
      }) as typeof process.stdout.write),
    ).toBe(2);
    expect(lines).toEqual([]);
  });
});

describe('ai link', () => {
  it('installs only the tool own names, so nothing on PATH is shadowed', () => {
    const dir = temporaryDirectory();
    const result = installSelf({ dir });
    expect(result.written.map((entry) => entry.name)).toEqual(['ai', 'imposter']);
    // The decisive property: no vendor name here, ever. A `claude` in this
    // directory would silently replace the user's real Claude Code.
    expect(result.written.every((entry) => entry.vendor === undefined)).toBe(true);
    expect(defaultBinDirectory()).not.toBe(defaultShimDirectory());
  });

  it.skipIf(!posix)('runs: a linked `ai` selects a persona from its flag', () => {
    const dir = temporaryDirectory();
    installSelf({ dir });
    const output = execFileSync(join(dir, 'ai'), ['--claude', '--version'], { encoding: 'utf8' });
    expect(output.trim()).toMatch(/Claude Code/);
  });

  it.skipIf(!posix)('refuses to run without a persona, rather than guessing one', () => {
    const dir = temporaryDirectory();
    installSelf({ dir });
    // argv0 is `ai`, which is not a persona, and no flag was given.
    expect(() =>
      execFileSync(join(dir, 'ai'), ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH! } }),
    ).toThrow(/no persona selected|Command failed/);
  });

  it('tells the user how to reach it, and says the directory is safe to keep', () => {
    const lines: string[] = [];
    const code = runLinkCommand(['--dir', temporaryDirectory()], ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stdout.write);
    expect(code).toBe(0);
    const output = lines.join('');
    expect(output).toContain('export PATH=');
    expect(output).toContain('ai --claude');
    expect(output).toMatch(/shadows no real agent/);
  });
});
