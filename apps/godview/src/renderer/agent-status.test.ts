import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import { agentColor, bubbleRadius, classifyAgentStatus, liveAgentView, projectLabel } from './agent-status.js';

function state(overrides: Partial<AgentStateMessage['state']> = {}): AgentStateMessage {
  return {
    runtimeSessionId: 'session-1',
    observationLevel: 'structured',
    conversation: { items: [], responding: false },
    state: {
      lifecycle: 'ready',
      tools: [],
      permissions: [],
      subagents: [],
      tasks: [],
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

  it('excludes exited sessions and labels live sessions from their workspace', () => {
    expect(projectLabel(info)).toBe('godview');
    expect(liveAgentView(info, state())?.project).toBe('godview');
    expect(liveAgentView({ ...info, session: { ...info.session, exited: true } }, state())).toBeUndefined();
    expect(liveAgentView(info, state({ lifecycle: 'failed' }))).toBeUndefined();
  });

  it('assigns a stable per-session relationship color', () => {
    expect(agentColor('session-1')).toBe(agentColor('session-1'));
    expect(agentColor('session-1')).not.toBe(agentColor('session-2'));
  });
});
