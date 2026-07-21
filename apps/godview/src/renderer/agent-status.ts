import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';

export type AgentVisualStatus = 'idle' | 'working' | 'waiting';

export interface LiveAgentView {
  id: string;
  info: AgentSessionInfo;
  state?: AgentStateMessage;
  status: AgentVisualStatus;
  project: string;
  provider: string;
  branch?: string;
  detail: string;
  color: string;
}

const terminalLifecycles = new Set(['exited', 'failed']);

export function classifyAgentStatus(message?: AgentStateMessage): AgentVisualStatus | undefined {
  if (!message) return 'working';
  const { state } = message;
  if (terminalLifecycles.has(state.lifecycle)) return undefined;
  if (state.permissions.length > 0) return 'waiting';
  if (
    state.lifecycle !== 'ready' ||
    state.activeTurn ||
    state.activeReasoning ||
    state.tools.length > 0 ||
    state.tasks.length > 0
  ) {
    return 'working';
  }
  return 'idle';
}

export function projectLabel(info: AgentSessionInfo): string {
  const path = info.workspace.sourcePath || info.workspace.root || info.session.cwd || '';
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || info.agent;
}

export function providerLabel(agent: AgentSessionInfo['agent']): string {
  switch (agent) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'grok':
      return 'Grok';
    case 'acp':
      return 'ACP';
  }
}

export function agentDetail(message: AgentStateMessage | undefined, status: AgentVisualStatus): string {
  if (!message) return 'starting';
  if (status === 'waiting') {
    const permission = message.state.permissions[0];
    return permission?.tool ? `permission · ${permission.tool}` : 'permission required';
  }
  const tool = message.state.tools[0];
  if (tool) return tool.presentation?.title ?? tool.tool ?? 'using tool';
  if (message.state.activeReasoning) return 'thinking';
  if (message.state.activeTurn) return 'responding';
  return status;
}

export function agentColor(id: string): string {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${Math.abs(hash) % 360} 62% 44%)`;
}

export function liveAgentView(
  info: AgentSessionInfo,
  state?: AgentStateMessage,
): LiveAgentView | undefined {
  if (info.session.exited) return undefined;
  const status = classifyAgentStatus(state);
  if (!status) return undefined;
  return {
    id: info.runtimeSessionId,
    info,
    state,
    status,
    project: projectLabel(info),
    provider: providerLabel(info.agent),
    branch: info.workspace.branch,
    detail: agentDetail(state, status),
    color: agentColor(info.runtimeSessionId),
  };
}

export function bubbleRadius(status: AgentVisualStatus): number {
  switch (status) {
    case 'idle':
      return 40;
    case 'working':
      return 50;
    case 'waiting':
      return 70;
  }
}
