import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import {
  agentBubbleVisualState,
  agentColor,
  bubbleRadius,
  classifyAgentStatus,
  classifyTerminalStatus,
  liveAgentView,
  nextAgentForStatus,
  projectLabel,
} from './agent-status.js';

function state(overrides: Partial<AgentStateMessage['state']> = {}): AgentStateMessage {
  return {
    runtimeSessionId: 'session-1',
    observationLevel: 'structured',
    state: {
      lifecycle: 'ready',
      tools: [],
      permissions: [],
      subagents: [],
      tasks: [],
      environment: {},
      counters: { toolsCompleted: 0, toolsFailed: 0, unknownEvents: 0 },
      lastSequence: 0,
      diagnostics: [],
      ...overrides,
    },
  };
}

const info = {
  agent: 'codex',
  sessionId: 'native-1',
  runtimeSessionId: 'session-1',
  workspace: { mode: 'direct', root: '/project/godview', sourcePath: '/project/godview' },
  session: { exited: false },
} as AgentSessionInfo;

describe('Godview agent presentation', () => {
  it('maps ready, active, and permission states to the three bubble sizes', () => {
    expect(classifyAgentStatus(state())).toBe('idle');
    expect(classifyAgentStatus(state({ lifecycle: 'running', activeTurn: { startedAt: 'now' } }))).toBe('working');
    expect(classifyAgentStatus(state({ permissions: [{ requestId: 'approval' }] }))).toBe('waiting');
    expect(bubbleRadius('idle')).toBeLessThan(bubbleRadius('working'));
    expect(bubbleRadius('working')).toBeLessThan(bubbleRadius('waiting'));
  });

  it('uses foreground activity for unassigned terminals and keeps unknown activity on the idle fallback', () => {
    expect(classifyTerminalStatus({ kind: 'shell-idle' })).toBe('idle');
    expect(classifyTerminalStatus({ kind: 'foreground-job' })).toBe('working');
    expect(classifyTerminalStatus({ kind: 'unknown' })).toBe('idle');
    expect(classifyTerminalStatus(undefined)).toBe('idle');
  });

  it('presents idle agents with the working treatment and ignites agents that are actually working', () => {
    expect(agentBubbleVisualState('idle')).toBe('working');
    expect(agentBubbleVisualState('working')).toBe('ignited');
    expect(agentBubbleVisualState('waiting')).toBe('waiting');
  });

  it('excludes exited sessions and labels live sessions from their workspace', () => {
    expect(projectLabel(info)).toBe('godview');
    expect(liveAgentView(info, state())?.id).toBe(info.session.id);
    expect(liveAgentView(info, state())?.project).toBe('godview');
    expect(liveAgentView({ ...info, session: { ...info.session, exited: true } }, state())).toBeUndefined();
    expect(liveAgentView(info, state({ lifecycle: 'failed' }))).toBeUndefined();
  });

  it('prefers live cwd, Git branch, and model-card state over launch workspace metadata', () => {
    const live = liveAgentView(
      info,
      state({
        environment: {
          currentCwd: {
            value: '/project/godview/packages/app',
            updatedAt: 'now',
            source: 'native-protocol',
            confidence: 'authoritative',
          },
          model: {
            value: { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Codex' },
            updatedAt: 'now',
            source: 'native-protocol',
            confidence: 'authoritative',
          },
          git: {
            value: { root: '/project/godview', branch: 'feature/live', headSha: 'abc', detached: false },
            updatedAt: 'now',
            source: 'runtime',
            confidence: 'derived',
          },
        },
      }),
    );
    expect(live).toMatchObject({ project: 'app', branch: 'feature/live', model: 'GPT-5.6-Codex' });
  });

  it('assigns a stable per-session relationship color', () => {
    expect(agentColor('session-1')).toBe(agentColor('session-1'));
    expect(agentColor('session-1')).not.toBe(agentColor('session-2'));
  });

  it('cycles a status relative to the session mounted in the active pane', () => {
    const first = liveAgentView(
      { ...info, runtimeSessionId: 'runtime-a', session: { ...info.session, id: 'terminal-a' } },
      state({ permissions: [{ requestId: 'approval-a' }] }),
    )!;
    const second = liveAgentView(
      { ...info, runtimeSessionId: 'runtime-b', session: { ...info.session, id: 'terminal-b' } },
      state({ permissions: [{ requestId: 'approval-b' }] }),
    )!;
    expect(nextAgentForStatus([first, second], 'waiting', undefined)).toBe(first);
    expect(nextAgentForStatus([first, second], 'waiting', first.info.session.id)).toBe(second);
    expect(nextAgentForStatus([first, second], 'waiting', second.info.session.id)).toBe(first);
    expect(nextAgentForStatus([first, second], 'working', first.info.session.id)).toBeUndefined();
  });
});
