import type { SessionActivity } from '@vibecook/ghosttea-protocol';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import { folderName } from './folder-name.js';

/**
 * What a session is doing, derived only from reduced runtime state — never from
 * terminal text (DESIGN ADR-003/-005). How a status is then drawn is each
 * monitor view's own business.
 */
export type AgentVisualStatus = 'idle' | 'working' | 'waiting';

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

export function classifyTerminalStatus(
  activity: Pick<SessionActivity, 'kind'> | undefined,
): Exclude<AgentVisualStatus, 'waiting'> {
  return activity?.kind === 'foreground-job' ? 'working' : 'idle';
}

export function projectLabel(info: AgentSessionInfo, currentCwd?: string): string {
  const path = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || '';
  return folderName(path, info.agent);
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
