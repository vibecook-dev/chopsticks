import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createGitStateObserver, resolveGitState } from './git-observer.js';

const execFileAsync = promisify(execFile);

async function run(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function repo(commit = true): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'chopsticks-git-observer-'));
  await run(cwd, 'init', '-b', 'main');
  if (commit) {
    await writeFile(join(cwd, 'README.md'), 'hello\n');
    await run(cwd, 'add', '.');
    await run(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial');
  }
  return cwd;
}

describe('resolveGitState', () => {
  it('resolves nested cwd, branch, head, detached state, and non-repositories', async () => {
    const cwd = await repo();
    const nested = join(cwd, 'nested');
    await mkdir(nested);
    const onBranch = await resolveGitState(nested);
    expect(onBranch).toMatchObject({ root: await realpath(cwd), branch: 'main', detached: false, worktree: false });
    expect(onBranch?.headSha).toMatch(/^[0-9a-f]{40,64}$/);

    await run(cwd, 'checkout', '--detach');
    expect(await resolveGitState(cwd)).toMatchObject({ root: await realpath(cwd), branch: null, detached: true });

    const outside = await mkdtemp(join(tmpdir(), 'chopsticks-not-git-'));
    expect(await resolveGitState(outside)).toBeNull();
  });

  it('represents an unborn branch without incorrectly calling it detached', async () => {
    const cwd = await repo(false);
    expect(await resolveGitState(cwd)).toMatchObject({
      root: await realpath(cwd),
      branch: 'main',
      headSha: null,
      detached: false,
    });
  });

  it('identifies linked worktrees while resolving their own root and branch', async () => {
    const main = await repo();
    const worktrees = await mkdtemp(join(tmpdir(), 'chopsticks-git-worktrees-'));
    const linked = join(worktrees, 'linked');
    await run(main, 'worktree', 'add', '-b', 'feature/linked', linked);

    expect(await resolveGitState(linked)).toMatchObject({
      root: await realpath(linked),
      branch: 'feature/linked',
      detached: false,
      worktree: true,
    });
  });
});

describe('createGitStateObserver', () => {
  it('observes branch changes and can rebind to another cwd', async () => {
    const first = await repo();
    const second = await repo();
    await run(second, 'checkout', '-b', 'feature');
    const values: Array<string | null> = [];
    let wake: (() => void) | undefined;
    const changed = (): Promise<void> => new Promise((resolve) => (wake = resolve));
    const observer = createGitStateObserver({
      cwd: first,
      // Keep fallback polling out of the test: the branch transition below
      // must be delivered by the Git ref/HEAD watchers.
      pollIntervalMs: 60_000,
      onChange: (state) => {
        values.push(state?.branch ?? null);
        wake?.();
        wake = undefined;
      },
    });
    try {
      await changed();
      expect(values.at(-1)).toBe('main');
      const watched = changed();
      await run(first, 'checkout', '-b', 'watched');
      await watched;
      expect(values.at(-1)).toBe('watched');

      const rebound = changed();
      observer.setCwd(second);
      await rebound;
      expect(values.at(-1)).toBe('feature');
    } finally {
      observer.stop();
    }
  });
});
