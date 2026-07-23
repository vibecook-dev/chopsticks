import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { paneSessionLaunchSource } from './pane-session.js';

function session(id: string, cwd: string | null, cols = 100, rows = 30): SessionSummary {
  return { id, handle: id, cwd, cols, rows, exited: false } as SessionSummary;
}

describe('Godview pane session launch source', () => {
  it('uses freshly queried cwd and dimensions for a split', () => {
    const selected = session('selected', '/before', 80, 24);
    const refreshed = session('selected', '/after', 140, 42);

    expect(paneSessionLaunchSource(selected, [refreshed], undefined, '/fallback')).toEqual({
      session: refreshed,
      cwd: '/after',
    });
  });

  it('falls back to app-owned cwd when terminal metadata has no path', () => {
    const selected = session('agent', null);
    expect(paneSessionLaunchSource(selected, [session('agent', null)], undefined, '/workspace/project')).toMatchObject({
      cwd: '/workspace/project',
    });
  });

  it('prefers the mounted agent current cwd over stale terminal metadata', () => {
    const selected = session('agent', '/launch-directory');
    const refreshed = session('agent', '/terminal-reported-directory');
    expect(paneSessionLaunchSource(selected, [refreshed], '/agent/current-directory', '/workspace')).toMatchObject({
      cwd: '/agent/current-directory',
    });
  });
});
