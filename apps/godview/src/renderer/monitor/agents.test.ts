import { describe, expect, it } from 'vitest';
import type { SessionActivity, SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentSessionInfo, AgentStateMessage } from '../../protocol.js';
import {
  assembleMonitorAgents,
  monitorAgentCounts,
  nextMonitorAgentForStatus,
  type MonitorAgentRecord,
} from './agents.js';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, exited: false, createdAtMs: 0, cwd: '/project/godview', ...overrides } as SessionSummary;
}

function state(overrides: Partial<AgentStateMessage['state']> = {}): AgentStateMessage {
  return {
    runtimeSessionId: 'runtime-1',
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

function agentRecord(
  runtimeSessionId: string,
  terminalId: string,
  overrides: Partial<AgentStateMessage['state']> = {},
  createdAtMs = 0,
): MonitorAgentRecord {
  return {
    info: {
      agent: 'codex',
      sessionId: `native-${runtimeSessionId}`,
      runtimeSessionId,
      workspace: { mode: 'direct', root: '/project/godview', sourcePath: '/project/godview' },
      session: session(terminalId, { createdAtMs }),
    } as AgentSessionInfo,
    state: state(overrides),
  };
}

describe('monitor agent assembly', () => {
  it('lists agents in launch order ahead of the terminals nothing has claimed', () => {
    const assembled = assembleMonitorAgents({
      agents: [agentRecord('runtime-b', 'terminal-b', {}, 20), agentRecord('runtime-a', 'terminal-a', {}, 10)],
      terminals: [{ session: session('terminal-c') }],
    });
    expect(assembled.map((agent) => agent.id)).toEqual(['terminal-a', 'terminal-b', 'terminal-c']);
    expect(assembled.map((agent) => Boolean(agent.agent))).toEqual([true, true, false]);
  });

  it('drops a terminal placeholder once an agent claims its session', () => {
    const assembled = assembleMonitorAgents({
      agents: [agentRecord('runtime-a', 'terminal-a')],
      terminals: [{ session: session('terminal-a') }],
    });
    expect(assembled).toHaveLength(1);
    // The same body, so a view's placement survives the promotion.
    expect(assembled[0]!.id).toBe('terminal-a');
    expect(assembled[0]!.agent?.kind).toBe('codex');
  });

  it('excludes exited sessions and sessions that reached a terminal lifecycle', () => {
    const exited = agentRecord('runtime-a', 'terminal-a');
    exited.info = { ...exited.info, session: session('terminal-a', { exited: true }) };
    const assembled = assembleMonitorAgents({
      agents: [exited, agentRecord('runtime-b', 'terminal-b', { lifecycle: 'failed' })],
      terminals: [],
    });
    expect(assembled).toEqual([]);
  });

  it('folds the shell-owned pane facts in, so no view looks them up itself', () => {
    const attachment = { primary: 'hsl(10 72% 48%)', mirrors: ['hsl(60 72% 48%)'] };
    const [agent] = assembleMonitorAgents({
      agents: [agentRecord('runtime-a', 'terminal-a')],
      terminals: [],
      attachments: new Map([['terminal-a', attachment]]),
      activeSessionId: 'terminal-a',
    });
    expect(agent).toMatchObject({ active: true, attachment });
  });

  it('refreshes a terminal placeholder from the live session summary', () => {
    const [terminal] = assembleMonitorAgents({
      agents: [],
      terminals: [{ session: session('terminal-a'), cwd: '/project/godview' }],
      sessions: new Map([
        ['terminal-a', session('terminal-a', { activity: { kind: 'foreground-job' } as SessionActivity })],
      ]),
    });
    expect(terminal).toMatchObject({ status: 'working', project: 'godview' });
    expect(terminal!.agent).toBeUndefined();
  });

  it('cycles and counts agent-backed sessions only', () => {
    const assembled = assembleMonitorAgents({
      agents: [
        agentRecord('runtime-a', 'terminal-a', { permissions: [{ requestId: 'approval-a' }] }, 10),
        agentRecord('runtime-b', 'terminal-b', { permissions: [{ requestId: 'approval-b' }] }, 20),
      ],
      terminals: [{ session: session('terminal-c') }],
    });
    expect(nextMonitorAgentForStatus(assembled, 'waiting', undefined)?.id).toBe('terminal-a');
    expect(nextMonitorAgentForStatus(assembled, 'waiting', 'terminal-a')?.id).toBe('terminal-b');
    expect(nextMonitorAgentForStatus(assembled, 'waiting', 'terminal-b')?.id).toBe('terminal-a');
    // The idle terminal is visible to views but is not an agent to navigate to.
    expect(nextMonitorAgentForStatus(assembled, 'idle', undefined)).toBeUndefined();
    expect(monitorAgentCounts(assembled)).toEqual({ idle: 0, working: 0, waiting: 2 });
  });
});
