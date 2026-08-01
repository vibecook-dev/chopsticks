import { describe, expect, it } from 'vitest';
import { readRestoreManifest, restorePaneFor, restorePromptDetail, summarizeRestore } from './restore-plan.js';

const agentPane = {
  sessionId: 't2',
  kind: 'agent',
  agent: 'claude',
  nativeSessionId: 'native-1',
  cwd: '/repo',
  workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
};

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    updatedAtMs: 5,
    windows: [
      {
        slotId: 'godview-tab-0',
        groupId: 'g',
        panes: [{ sessionId: 't1', kind: 'terminal', cwd: '/repo/api' }, agentPane],
      },
    ],
    ...overrides,
  };
}

describe('readRestoreManifest', () => {
  it('reads back a manifest this build wrote', () => {
    const parsed = readRestoreManifest(manifest());
    expect(parsed?.windows).toHaveLength(1);
    expect(parsed?.windows[0]!.panes).toHaveLength(2);
  });

  it('declines anything it cannot honor rather than starting a partial restore', () => {
    expect(readRestoreManifest(undefined)).toBeUndefined();
    expect(readRestoreManifest('nonsense')).toBeUndefined();
    expect(readRestoreManifest({})).toBeUndefined();
    // A newer writer may carry fields this build does not understand.
    expect(readRestoreManifest(manifest({ version: 2 }))).toBeUndefined();
    expect(readRestoreManifest(manifest({ windows: 'no' }))).toBeUndefined();
    expect(readRestoreManifest(manifest({ windows: [] }))).toBeUndefined();
  });

  it('drops malformed windows and panes without losing the rest', () => {
    const parsed = readRestoreManifest(
      manifest({
        windows: [
          { slotId: 'godview-tab-0', groupId: 'g', panes: [{ sessionId: 't1', kind: 'terminal' }, { kind: 'nope' }] },
          { groupId: 'g', panes: [{ sessionId: 'x', kind: 'terminal' }] },
          { slotId: 'godview-tab-1', groupId: 'g', panes: [] },
        ],
      }),
    );
    expect(parsed?.windows).toHaveLength(1);
    expect(parsed?.windows[0]!.panes).toEqual([{ sessionId: 't1', kind: 'terminal' }]);
  });

  it('keeps an agent pane whose resume key is missing, as a terminal in the same place', () => {
    const parsed = readRestoreManifest(
      manifest({
        windows: [
          {
            slotId: 'godview-tab-0',
            groupId: 'g',
            panes: [{ sessionId: 't2', kind: 'agent', agent: 'claude', cwd: '/repo' }],
          },
        ],
      }),
    );
    expect(parsed?.windows[0]!.panes[0]).toEqual({ sessionId: 't2', kind: 'terminal', cwd: '/repo' });
  });
});

describe('summarizeRestore', () => {
  it('counts what the prompt has to describe', () => {
    const parsed = readRestoreManifest(manifest())!;
    expect(summarizeRestore(parsed)).toEqual({
      windows: 1,
      agents: 1,
      terminals: 1,
      entries: [{ agent: 'claude', cwd: '/repo' }],
    });
  });
});

describe('restorePromptDetail', () => {
  it('counts in singular and plural, and says what resume actually restores', () => {
    const detail = restorePromptDetail({
      windows: 1,
      agents: 1,
      terminals: 2,
      entries: [{ agent: 'claude', cwd: '/repo' }],
    });
    expect(detail).toContain('1 window · 1 agent · 2 terminals');
    expect(detail).toContain('claude   /repo');
    expect(detail).toContain('picking up where the conversation left off');
  });

  it('omits a kind that is not coming back', () => {
    const detail = restorePromptDetail({ windows: 2, agents: 0, terminals: 3, entries: [] });
    expect(detail).toContain('2 windows · 3 terminals');
    expect(detail).not.toContain('agent');
  });

  it('truncates a long list rather than filling the dialog', () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({ agent: 'claude', cwd: `/repo/${index}` }));
    const detail = restorePromptDetail({ windows: 1, agents: 11, terminals: 0, entries }, 8);
    expect(detail).toContain('…and 3 more');
    expect(detail).not.toContain('/repo/8');
  });
});

describe('restorePaneFor', () => {
  it('finds a pane by the dead session id Ghosttea hands back', () => {
    const parsed = readRestoreManifest(manifest())!;
    expect(restorePaneFor(parsed, 't2')).toMatchObject({ kind: 'agent', nativeSessionId: 'native-1' });
    expect(restorePaneFor(parsed, 't1')).toMatchObject({ kind: 'terminal', cwd: '/repo/api' });
    expect(restorePaneFor(parsed, 'unknown')).toBeUndefined();
  });
});
