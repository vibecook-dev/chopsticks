import { describe, expect, it } from 'vitest';
import { unknownSessionActivity, type SessionSummary } from '@vibecook/ghosttea-protocol';
import { buildRestoreManifest, type RestoreAgentInput } from './restore-manifest.js';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    handle: id,
    executable: '/bin/zsh',
    cols: 100,
    rows: 30,
    exited: false,
    readWrite: true,
    title: null,
    cwd: '/repo',
    bellCount: 0,
    pid: 1,
    createdAtMs: 1,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
    ownerId: null,
    persistence: 'terminate-with-app',
    activity: unknownSessionActivity(),
    ...overrides,
  };
}

function agent(sessionId: string, overrides: Partial<RestoreAgentInput['info']> = {}): RestoreAgentInput {
  return {
    info: {
      agent: 'claude',
      sessionId: `native-${sessionId}`,
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      ...overrides,
    },
    session: { exited: false },
  };
}

describe('buildRestoreManifest', () => {
  it('describes agent panes by resume key and terminals by cwd, in pane order', () => {
    const manifest = buildRestoreManifest({
      windows: [{ id: 'godview-tab-0', groupId: 'g', activeCwd: '/repo', sessionIds: ['t1', 't2'] }],
      agents: new Map([['t2', agent('t2')]]),
      sessions: [session('t1', { cwd: '/repo/api' }), session('t2')],
      updatedAtMs: 42,
    });

    expect(manifest).toEqual({
      version: 1,
      updatedAtMs: 42,
      windows: [
        {
          slotId: 'godview-tab-0',
          groupId: 'g',
          activeCwd: '/repo',
          panes: [
            { kind: 'terminal', cwd: '/repo/api' },
            {
              kind: 'agent',
              agent: 'claude',
              nativeSessionId: 'native-t2',
              cwd: '/repo',
              workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
            },
          ],
        },
      ],
    });
  });

  it('records a worktree agent by its branch and root so it can be rebound', () => {
    const manifest = buildRestoreManifest({
      windows: [{ id: 'godview-tab-0', groupId: 'g', activeCwd: undefined, sessionIds: ['t1'] }],
      agents: new Map([
        [
          't1',
          agent('t1', {
            workspace: { mode: 'worktree', root: '/wt/feature', sourcePath: '/repo', branch: 'chopsticks/feature' },
          }),
        ],
      ]),
      sessions: [session('t1')],
      updatedAtMs: 1,
    });

    expect(manifest.windows[0]!.panes[0]).toMatchObject({
      kind: 'agent',
      cwd: '/repo',
      workspace: { mode: 'worktree', root: '/wt/feature', branch: 'chopsticks/feature' },
    });
  });

  it('drops panes with nothing to come back to, and windows left empty', () => {
    const manifest = buildRestoreManifest({
      windows: [
        { id: 'godview-tab-0', groupId: 'g', activeCwd: undefined, sessionIds: ['gone', 'exited', 'live'] },
        { id: 'godview-tab-1', groupId: 'g', activeCwd: undefined, sessionIds: ['gone'] },
      ],
      agents: new Map(),
      sessions: [session('exited', { exited: true }), session('live')],
      updatedAtMs: 1,
    });

    expect(manifest.windows).toHaveLength(1);
    expect(manifest.windows[0]!.slotId).toBe('godview-tab-0');
    expect(manifest.windows[0]!.panes).toEqual([{ kind: 'terminal', cwd: '/repo' }]);
  });

  it('falls back to a terminal when the agent behind a pane has exited', () => {
    const exitedAgent: RestoreAgentInput = { ...agent('t1'), session: { exited: true } };
    const manifest = buildRestoreManifest({
      windows: [{ id: 'godview-tab-0', groupId: 'g', activeCwd: undefined, sessionIds: ['t1'] }],
      agents: new Map([['t1', exitedAgent]]),
      sessions: [session('t1', { cwd: '/repo/web' })],
      updatedAtMs: 1,
    });

    expect(manifest.windows[0]!.panes).toEqual([{ kind: 'terminal', cwd: '/repo/web' }]);
  });

  it('persists no launch arguments or environment', () => {
    const manifest = buildRestoreManifest({
      windows: [{ id: 'godview-tab-0', groupId: 'g', activeCwd: undefined, sessionIds: ['t1'] }],
      agents: new Map([['t1', agent('t1')]]),
      sessions: [session('t1')],
      updatedAtMs: 1,
    });

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(/args|argv|env|token/i);
  });
});
