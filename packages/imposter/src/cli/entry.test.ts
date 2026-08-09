/**
 * How `ai` is reached at all (draft/IMPOSTER.md §6).
 *
 * There is no install command here, and that is the design. Two bespoke ones
 * shipped and were deleted on 2026-08-08 — `ai link`, which reimplemented the
 * package manager, and `ai shims install`, which wrote vendor-named symlinks.
 * What is left is the `bin` field and, for anyone who wants a vendor name to
 * reach the imposter, one line of `ln -s`.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const AI = join(packageRoot, 'bin', 'ai.mjs');

const temporaries: string[] = [];
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('reaching `ai`', () => {
  it('is the package manager job, declared by `bin`', () => {
    // `pnpm add --global ./packages/imposter` from a checkout, or an ordinary
    // global install once published, both work off this field alone.
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    expect(manifest.bin).toEqual({ ai: './bin/ai.mjs', imposter: './bin/ai.mjs' });
    // A bin the manager symlinks has to be executable on the other side of it
    // — on POSIX. Windows has no execute bit at all (`mode & 0o111` is always
    // 0 there); npm and pnpm write `.cmd` shims instead, so there is nothing
    // equivalent to assert.
    if (process.platform !== 'win32') expect(lstatSync(AI).mode & 0o111).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('answers to a vendor name through a hand-made symlink', () => {
    // argv0 dispatch outlived its installer, and needs no command to reach:
    // one `ln -s` is the whole feature. `process.argv[1]` through a symlink is
    // the symlink path, which is what makes the persona resolvable from it.
    //
    // Note WHAT is linked: this file, not `$(command -v ai)`. A package
    // manager's global `ai` is a wrapper that resolves its payload relative to
    // itself, so linking the wrapper elsewhere breaks it (§6).
    const dir = mkdtempSync(join(tmpdir(), 'chopsticks-argv0-'));
    temporaries.push(dir);
    const link = join(dir, 'claude');
    symlinkSync(AI, link);
    expect(execFileSync(link, ['--version'], { encoding: 'utf8' }).trim()).toMatch(/Claude Code/);
  });
});
