import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { paneBadgeLabel, paneSessionLaunchSource } from './pane-session.js';

function session(id: string, cwd: string | null, cols = 100, rows = 30): SessionSummary {
  return { id, handle: id, cwd, cols, rows, exited: false } as SessionSummary;
}

describe('Godview pane session launch source', () => {
  it('uses freshly queried cwd and dimensions for a split', () => {
    const selected = session('selected', '/before', 80, 24);
    const refreshed = session('selected', '/after', 140, 42);

    expect(paneSessionLaunchSource(selected, [refreshed], { fallback: '/fallback' })).toEqual({
      session: refreshed,
      cwd: '/after',
    });
  });

  it('falls back to app-owned cwd when terminal metadata has no path', () => {
    const selected = session('agent', null);
    expect(
      paneSessionLaunchSource(selected, [session('agent', null)], { fallback: '/workspace/project' }),
    ).toMatchObject({ cwd: '/workspace/project' });
  });

  it('prefers agent and process cwd over stale terminal metadata', () => {
    const selected = session('agent', '/launch-directory');
    const refreshed = session('agent', '/terminal-reported-directory');
    expect(
      paneSessionLaunchSource(selected, [refreshed], {
        agent: '/agent/current-directory',
        process: '/shell/current-directory',
        fallback: '/workspace',
      }),
    ).toMatchObject({ cwd: '/agent/current-directory' });
    expect(
      paneSessionLaunchSource(selected, [refreshed], {
        process: '/shell/current-directory',
        fallback: '/workspace',
      }),
    ).toMatchObject({ cwd: '/shell/current-directory' });
  });
});

describe('Godview pane badge label', () => {
  it('shows only the current folder and never the terminal title or executable', () => {
    const terminal = {
      ...session('terminal', '/Users/james/Projects/chopsticks/'),
      title: 'james@Jamess-MacBook-Pro-9:/Users/james/Projects/chopsticks',
      executable: '/bin/zsh',
    };
    expect(paneBadgeLabel(terminal)).toBe('chopsticks');
  });

  it('matches the agent-circle project and supports Windows paths', () => {
    expect(paneBadgeLabel(session('agent', '/stale/path'), 'godview')).toBe('godview');
    expect(paneBadgeLabel(session('windows', 'C:\\Users\\james\\project'))).toBe('project');
  });

  it('uses a known fallback cwd or a neutral terminal label', () => {
    expect(paneBadgeLabel(session('fallback', null), undefined, '/workspace/project')).toBe('project');
    expect(paneBadgeLabel(session('unknown', null))).toBe('terminal');
  });
});
