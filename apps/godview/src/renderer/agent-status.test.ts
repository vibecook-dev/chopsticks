import { describe, expect, it } from 'vitest';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import {
  agentColor,
  agentDetail,
  classifyAgentStatus,
  classifyTerminalStatus,
  projectLabel,
  providerLabel,
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

describe('Godview agent status', () => {
  it('maps ready, active, and permission states to the three statuses', () => {
    expect(classifyAgentStatus(state())).toBe('idle');
    expect(classifyAgentStatus(state({ lifecycle: 'running', activeTurn: { startedAt: 'now' } }))).toBe('working');
    expect(classifyAgentStatus(state({ permissions: [{ requestId: 'approval' }] }))).toBe('waiting');
  });

  it('drops sessions that reached a terminal lifecycle', () => {
    expect(classifyAgentStatus(state({ lifecycle: 'failed' }))).toBeUndefined();
    expect(classifyAgentStatus(state({ lifecycle: 'exited' }))).toBeUndefined();
  });

  it('uses foreground activity for unassigned terminals and keeps unknown activity on the idle fallback', () => {
    expect(classifyTerminalStatus({ kind: 'shell-idle' })).toBe('idle');
    expect(classifyTerminalStatus({ kind: 'foreground-job' })).toBe('working');
    expect(classifyTerminalStatus({ kind: 'unknown' })).toBe('idle');
    expect(classifyTerminalStatus(undefined)).toBe('idle');
  });

  it('labels a session from its workspace and its provider from its kind', () => {
    expect(projectLabel(info)).toBe('godview');
    expect(projectLabel(info, '/project/godview/packages/app')).toBe('app');
    expect(providerLabel('codex')).toBe('Codex');
  });

  it('describes what an agent is doing without reading the terminal', () => {
    expect(agentDetail(undefined, 'working')).toBe('starting');
    expect(agentDetail(state({ permissions: [{ requestId: 'a', tool: 'Bash' }] }), 'waiting')).toBe(
      'permission · Bash',
    );
    expect(agentDetail(state({ tools: [{ toolCallId: 't', tool: 'Read', state: 'running' }] }), 'working')).toBe(
      'Read',
    );
    expect(agentDetail(state({ activeReasoning: { startedAt: 'now' } }), 'working')).toBe('thinking');
  });

  it('assigns a stable per-session relationship color', () => {
    expect(agentColor('session-1')).toBe(agentColor('session-1'));
    expect(agentColor('session-1')).not.toBe(agentColor('session-2'));
  });
});
