import { execFile } from 'node:child_process';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentGitState } from '@vibecook/chopsticks-core';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function fromGitPath(cwd: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** Resolve branch/head facts for any directory, including worktrees, unborn branches, and detached HEADs. */
export async function resolveGitState(cwd: string): Promise<AgentGitState | null> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;

  const [branch, headSha, gitDir, commonDir] = await Promise.all([
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(cwd, ['rev-parse', '--verify', 'HEAD']),
    git(cwd, ['rev-parse', '--absolute-git-dir']),
    git(cwd, ['rev-parse', '--git-common-dir']),
  ]);
  const absoluteGitDir = fromGitPath(cwd, gitDir);
  const absoluteCommonDir = fromGitPath(cwd, commonDir);
  const [canonicalGitDir, canonicalCommonDir] = await Promise.all([
    absoluteGitDir ? realpath(absoluteGitDir).catch(() => absoluteGitDir) : undefined,
    absoluteCommonDir ? realpath(absoluteCommonDir).catch(() => absoluteCommonDir) : undefined,
  ]);

  return {
    root,
    branch: branch ?? null,
    headSha: headSha ?? null,
    detached: branch === undefined && headSha !== undefined,
    ...(canonicalGitDir && canonicalCommonDir ? { worktree: canonicalGitDir !== canonicalCommonDir } : {}),
  };
}

export interface GitStateObserver {
  setCwd(cwd: string): void;
  refresh(): void;
  stop(): void;
}

export interface GitStateObserverOptions {
  cwd: string;
  onChange: (state: AgentGitState | null) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
}

const stableState = (state: AgentGitState | null): string => JSON.stringify(state);

/**
 * Watches Git's actual indirection paths and also polls as a correctness
 * fallback. Polling covers atomic ref replacement, packed refs, and network
 * filesystems where fs.watch can miss a transition.
 */
export function createGitStateObserver(options: GitStateObserverOptions): GitStateObserver {
  let cwd = resolve(options.cwd);
  let generation = 0;
  let stopped = false;
  let running = false;
  let queued = false;
  let last: string | undefined;
  let watchers: FSWatcher[] = [];

  const clearWatchers = (): void => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const schedule = (): void => {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    void refreshNow();
  };

  const watchPath = (path: string | undefined): void => {
    if (!path) return;
    const target = existsSync(path) ? path : dirname(path);
    if (!existsSync(target)) return;
    try {
      const watcher = watch(target, { persistent: false }, schedule);
      watcher.on('error', () => undefined);
      watchers.push(watcher);
    } catch {
      // The poller remains the correctness fallback.
    }
  };

  const rebuildWatchers = async (observedCwd: string, observedGeneration: number): Promise<void> => {
    const [headPath, packedRefs, branchRef] = await Promise.all([
      git(observedCwd, ['rev-parse', '--git-path', 'HEAD']),
      git(observedCwd, ['rev-parse', '--git-path', 'packed-refs']),
      git(observedCwd, ['symbolic-ref', '--quiet', 'HEAD']).then((ref) =>
        ref ? git(observedCwd, ['rev-parse', '--git-path', ref]) : undefined,
      ),
    ]);
    if (stopped || generation !== observedGeneration) return;
    clearWatchers();
    watchPath(fromGitPath(observedCwd, headPath));
    watchPath(fromGitPath(observedCwd, packedRefs));
    watchPath(fromGitPath(observedCwd, branchRef));
  };

  async function refreshNow(): Promise<void> {
    running = true;
    const observedGeneration = generation;
    const observedCwd = cwd;
    try {
      const state = await resolveGitState(observedCwd);
      if (stopped || generation !== observedGeneration) return;
      const serialized = stableState(state);
      if (serialized !== last) {
        last = serialized;
        options.onChange(state);
      }
      await rebuildWatchers(observedCwd, observedGeneration);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
      if (queued && !stopped) {
        queued = false;
        schedule();
      }
    }
  }

  const poller = setInterval(schedule, options.pollIntervalMs ?? 2_000);
  poller.unref?.();
  schedule();

  return {
    setCwd(nextCwd) {
      const normalized = resolve(nextCwd);
      if (normalized === cwd) return;
      cwd = normalized;
      generation += 1;
      last = undefined;
      clearWatchers();
      schedule();
    },
    refresh: schedule,
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      clearInterval(poller);
      clearWatchers();
    },
  };
}
