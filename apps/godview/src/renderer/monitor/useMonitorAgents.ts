import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import type { AgentSessionInfo, AgentStateMessage } from '../../protocol.js';
import type { PaneAttachment } from '../pane-attachments.js';
import { assembleMonitorAgents, type MonitorAgentRecord, type MonitorTerminalRecord } from './agents.js';
import type { MonitorActions, MonitorAgent } from './types.js';

export interface UseMonitorAgentsOptions {
  workspace?: GhostteaWorkspaceContext;
  attachments: ReadonlyMap<string, PaneAttachment>;
  /** Terminal-runtime exits, so a placeholder for a closed terminal stops being shown. */
  onSessionExited(listener: (sessionId: string) => void): () => void;
}

export interface MonitorAgentsResult {
  agents: readonly MonitorAgent[];
  actions: MonitorActions;
}

/**
 * The single subscription to everything a monitor view renders.
 *
 * It lives beside the view contract rather than inside any one view, so a
 * second view is a consumer of this hook and never a consumer of the swarm.
 */
export function useMonitorAgents({
  workspace,
  attachments,
  onSessionExited,
}: UseMonitorAgentsOptions): MonitorAgentsResult {
  const [records, setRecords] = useState(() => new Map<string, MonitorAgentRecord>());
  const [terminals, setTerminals] = useState<readonly MonitorTerminalRecord[]>([]);

  useEffect(() => {
    let alive = true;
    let publishFrame: number | undefined;
    const current = new Map<string, MonitorAgentRecord>();
    const removed = new Set<string>();
    const publish = (): void => {
      if (publishFrame !== undefined) return;
      publishFrame = window.requestAnimationFrame(() => {
        publishFrame = undefined;
        if (alive) setRecords(new Map(current));
      });
    };
    const remember = (info: AgentSessionInfo): void => {
      removed.delete(info.runtimeSessionId);
      current.set(info.runtimeSessionId, { ...current.get(info.runtimeSessionId), info });
      publish();
    };
    const forget = (runtimeSessionId: string): void => {
      removed.add(runtimeSessionId);
      if (current.delete(runtimeSessionId)) publish();
    };
    const updateState = (state: AgentStateMessage): void => {
      const existing = current.get(state.runtimeSessionId);
      if (!existing) return;
      current.set(state.runtimeSessionId, { ...existing, state });
      publish();
    };

    const unsubscribeSession = window.chopsticks.onAgentSession(remember);
    const unsubscribeState = window.chopsticks.onAgentState(updateState);
    const unsubscribeRemoved = window.chopsticks.onAgentRemoved(forget);
    const unsubscribeFinal = window.chopsticks.onWorkspaceFinal((event) => forget(event.runtimeSessionId));

    void window.chopsticks.listAgentSessions().then((snapshots) => {
      if (!alive) return;
      const next = new Map<string, MonitorAgentRecord>();
      for (const snapshot of snapshots) {
        const id = snapshot.info.runtimeSessionId;
        if (removed.has(id) || snapshot.final || snapshot.info.session.exited) continue;
        const live = current.get(id);
        next.set(id, {
          info: live?.info ?? snapshot.info,
          state: live?.state ?? snapshot.state,
        });
      }
      for (const [id, record] of current) {
        if (!next.has(id) && !removed.has(id)) next.set(id, record);
      }
      current.clear();
      for (const [id, record] of next) current.set(id, record);
      publish();
    });

    return () => {
      alive = false;
      if (publishFrame !== undefined) window.cancelAnimationFrame(publishFrame);
      unsubscribeSession();
      unsubscribeState();
      unsubscribeRemoved();
      unsubscribeFinal();
    };
  }, []);

  const claimedSessionIds = useMemo(
    () => new Set([...records.values()].map((record) => record.info.session.id)),
    [records],
  );

  useEffect(() => {
    if (claimedSessionIds.size === 0) return;
    setTerminals((current) => {
      const next = current.filter((terminal) => !claimedSessionIds.has(terminal.session.id));
      return next.length === current.length ? current : next;
    });
  }, [claimedSessionIds]);

  useEffect(
    () =>
      onSessionExited((sessionId) => {
        setTerminals((current) => {
          const next = current.filter((terminal) => terminal.session.id !== sessionId);
          return next.length === current.length ? current : next;
        });
      }),
    [onSessionExited],
  );

  const sessions = useMemo(
    () => new Map((workspace?.sessions ?? []).map((session) => [session.id, session] as const)),
    [workspace?.sessions],
  );

  const agents = useMemo(
    () =>
      assembleMonitorAgents({
        agents: [...records.values()],
        terminals,
        sessions,
        attachments,
        ...(workspace?.activeSession ? { activeSessionId: workspace.activeSession.id } : {}),
      }),
    [attachments, records, sessions, terminals, workspace?.activeSession],
  );

  const select = useCallback(
    (agent: MonitorAgent): void => {
      workspace?.mountSession(agent.session);
    },
    [workspace],
  );

  const createAt = useCallback(
    async (position?: { x: number; y: number }): Promise<void> => {
      if (!workspace?.activeSession) return;
      const sourceCwd = workspace.activeSession.cwd;
      const session = await workspace.createSessionInActivePane();
      if (!session) return;
      const cwd = session.cwd ?? sourceCwd;
      setTerminals((current) => [
        ...current.filter((terminal) => terminal.session.id !== session.id),
        { session, ...(cwd ? { cwd } : {}), ...(position ? { spawnHint: position } : {}) },
      ]);
    },
    [workspace],
  );

  const actions = useMemo<MonitorActions>(() => ({ select, createAt }), [createAt, select]);

  return { agents, actions };
}
