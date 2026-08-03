import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentSessionInfo, AgentStateMessage } from '../../protocol.js';
import {
  agentColor,
  agentDetail,
  classifyAgentStatus,
  classifyTerminalStatus,
  projectLabel,
  providerLabel,
  type AgentVisualStatus,
} from '../agent-status.js';
import { folderName } from '../folder-name.js';
import type { PaneAttachment } from '../pane-attachments.js';
import type { MonitorAgent } from './types.js';

export interface MonitorAgentRecord {
  info: AgentSessionInfo;
  state?: AgentStateMessage;
}

/** A terminal the user opened that no agent has claimed. */
export interface MonitorTerminalRecord {
  session: SessionSummary;
  cwd?: string;
  spawnHint?: { x: number; y: number };
}

export interface AssembleMonitorAgentsInput {
  agents: readonly MonitorAgentRecord[];
  terminals: readonly MonitorTerminalRecord[];
  /** Live summaries, so a terminal placeholder reflects current activity rather than launch state. */
  sessions?: ReadonlyMap<string, SessionSummary>;
  attachments?: ReadonlyMap<string, PaneAttachment>;
  activeSessionId?: string;
}

/** Undefined for a session that has stopped being worth showing at all. */
export function monitorAgentFromSession(record: MonitorAgentRecord): MonitorAgent | undefined {
  const { info, state } = record;
  if (info.session.exited) return undefined;
  const status = classifyAgentStatus(state);
  if (!status) return undefined;
  const environment = state?.state.environment;
  const currentCwd = environment?.currentCwd?.value;
  const model = environment?.model?.value;
  const git = environment?.git?.value;
  const branch = environment?.git ? (git?.branch ?? undefined) : info.workspace.branch;
  const cwd = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || undefined;
  const contextWindow = state?.state.contextWindow;
  return {
    id: info.session.id,
    session: info.session,
    status,
    project: projectLabel(info, currentCwd),
    detail: agentDetail(state, status),
    color: agentColor(info.runtimeSessionId),
    active: false,
    ...(cwd ? { cwd } : {}),
    agent: {
      kind: info.agent,
      provider: providerLabel(info.agent),
      ...(model ? { model: model.displayName || model.id } : {}),
      ...(branch ? { branch } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      info,
      ...(state ? { state } : {}),
    },
  };
}

export function monitorAgentFromTerminal(record: MonitorTerminalRecord): MonitorAgent {
  const { session, cwd, spawnHint } = record;
  const path = cwd ?? session.cwd ?? undefined;
  return {
    id: session.id,
    session,
    status: classifyTerminalStatus(session.activity),
    project: folderName(path, 'terminal'),
    detail: path || 'Unassigned terminal',
    color: agentColor(session.id),
    active: false,
    ...(path ? { cwd: path } : {}),
    ...(spawnHint ? { spawnHint } : {}),
  };
}

/**
 * The one projection every view consumes: agents first in launch order, then
 * the terminals no agent has claimed, each decorated with the pane facts the
 * shell owns. Pure, so the seam is testable without a renderer.
 */
export function assembleMonitorAgents(input: AssembleMonitorAgentsInput): readonly MonitorAgent[] {
  const agents = input.agents
    .map(monitorAgentFromSession)
    .filter((agent): agent is MonitorAgent => agent !== undefined)
    .sort((left, right) => left.session.createdAtMs - right.session.createdAtMs);
  const claimed = new Set(agents.map((agent) => agent.session.id));
  const terminals = input.terminals
    .filter((terminal) => !claimed.has(terminal.session.id))
    .map((terminal) =>
      monitorAgentFromTerminal({ ...terminal, session: input.sessions?.get(terminal.session.id) ?? terminal.session }),
    );

  return [...agents, ...terminals].map((agent) => {
    const attachment = input.attachments?.get(agent.session.id);
    return {
      ...agent,
      active: input.activeSessionId === agent.session.id,
      ...(attachment ? { attachment } : {}),
    };
  });
}

/** Agent-backed only: the status shortcuts navigate agents, not bare terminals. */
export function nextMonitorAgentForStatus(
  agents: readonly MonitorAgent[],
  status: AgentVisualStatus,
  currentSessionId: string | undefined,
): MonitorAgent | undefined {
  const matching = agents.filter((agent) => agent.agent && agent.status === status);
  if (matching.length === 0) return undefined;
  const currentIndex = matching.findIndex((agent) => agent.session.id === currentSessionId);
  return matching[(currentIndex + 1) % matching.length];
}

export function monitorAgentCounts(agents: readonly MonitorAgent[]): Record<AgentVisualStatus, number> {
  const counts: Record<AgentVisualStatus, number> = { idle: 0, working: 0, waiting: 0 };
  for (const agent of agents) {
    if (agent.agent) counts[agent.status] += 1;
  }
  return counts;
}
