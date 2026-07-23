import { useCallback, useEffect, useRef, useState } from 'react';
import type { GhostteaWorkspaceContext } from '@vibecook/ghosttea-react/workspace';
import type { AgentConversationSnapshot } from '@vibecook/chopsticks-runtime';
import type {
  AgentKind,
  AgentSessionInfo,
  AgentStateMessage,
  CreateAgentSessionOptions,
  WorkspaceFinalEvent,
} from '../protocol.js';
import { AgentPanel, type WorkspacePanelData } from './AgentPanel.js';

interface AgentSidebarProps {
  workspace: GhostteaWorkspaceContext;
}

type SpawnMode = 'default' | 'exclusive' | 'worktree';

const EMPTY_CONVERSATION: AgentConversationSnapshot = { items: [], responding: false };
const CONVERSATION_REFRESH_MS = 100;

interface ConversationLoader {
  sessionId?: string;
  generation: number;
  desiredRevision: number;
  loadedRevision: number;
  running: boolean;
  lastRequestAt: number;
}

/**
 * Pulls only the conversation currently visible in the sidebar. The loader is
 * single-flight and folds any events received while a request is running into
 * one follow-up snapshot.
 */
function useActiveConversation(
  sessionId: string | undefined,
  revision: number | undefined,
): AgentConversationSnapshot {
  const [loadedConversation, setLoadedConversation] = useState<{
    sessionId?: string;
    snapshot: AgentConversationSnapshot;
  }>({ snapshot: EMPTY_CONVERSATION });
  const loaderRef = useRef<ConversationLoader>({
    generation: 0,
    desiredRevision: -1,
    loadedRevision: -2,
    running: false,
    lastRequestAt: 0,
  });

  useEffect(() => {
    let loader = loaderRef.current;
    if (loader.sessionId !== sessionId) {
      loader.generation += 1;
      loader = {
        sessionId,
        generation: loader.generation,
        desiredRevision: revision ?? 0,
        loadedRevision: -1,
        running: false,
        lastRequestAt: 0,
      };
      loaderRef.current = loader;
      setLoadedConversation({ sessionId, snapshot: EMPTY_CONVERSATION });
    } else {
      loader.desiredRevision = Math.max(loader.desiredRevision, revision ?? 0);
    }

    if (!sessionId || loader.running || loader.loadedRevision >= loader.desiredRevision) return;
    loader.running = true;
    const generation = loader.generation;

    void (async () => {
      while (
        loaderRef.current === loader &&
        loader.generation === generation &&
        loader.loadedRevision < loader.desiredRevision
      ) {
        const waitMs = Math.max(0, CONVERSATION_REFRESH_MS - (Date.now() - loader.lastRequestAt));
        if (waitMs) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
        if (loaderRef.current !== loader || loader.generation !== generation) return;

        const requestedRevision = loader.desiredRevision;
        loader.lastRequestAt = Date.now();
        let snapshot: AgentConversationSnapshot | undefined;
        try {
          snapshot = await window.chopsticks.agentConversation(sessionId);
        } catch {
          // A renderer reload or session exit can race an invoke. A later state
          // revision will retry; the sidebar remains usable with an empty view.
        }
        if (loaderRef.current !== loader || loader.generation !== generation) return;
        loader.loadedRevision = requestedRevision;
        if (snapshot) setLoadedConversation({ sessionId, snapshot });
      }
      if (loaderRef.current === loader && loader.generation === generation) loader.running = false;
    })();
  }, [revision, sessionId]);

  useEffect(
    () => () => {
      loaderRef.current.generation += 1;
    },
    [],
  );

  return loadedConversation.sessionId === sessionId ? loadedConversation.snapshot : EMPTY_CONVERSATION;
}

export function AgentSidebar({ workspace }: AgentSidebarProps) {
  const [agentKind, setAgentKind] = useState<AgentKind>('claude');
  const [agents, setAgents] = useState(() => new Map<string, AgentSessionInfo>());
  const stateRecordsRef = useRef(new Map<string, AgentStateMessage>());
  const statePublishFrameRef = useRef<number | undefined>(undefined);
  const [states, setStates] = useState(stateRecordsRef.current);
  const [workspaces, setWorkspaces] = useState(() => new Map<string, WorkspacePanelData>());
  const [spawning, setSpawning] = useState<SpawnMode>();
  const [error, setError] = useState<string>();

  const rememberAgent = useCallback((info: AgentSessionInfo, note?: string): void => {
    setAgents((current) => new Map(current).set(info.runtimeSessionId, info));
    setWorkspaces((current) =>
      new Map(current).set(info.runtimeSessionId, {
        info: info.workspace,
        ...(note ? { note } : {}),
      }),
    );
  }, []);

  const publishStates = useCallback((): void => {
    if (statePublishFrameRef.current !== undefined) return;
    statePublishFrameRef.current = window.requestAnimationFrame(() => {
      statePublishFrameRef.current = undefined;
      setStates(new Map(stateRecordsRef.current));
    });
  }, []);

  const spawnAgent = useCallback(
    async (
      mode: SpawnMode,
      resume?: { nativeSessionId: string; previous: WorkspacePanelData },
      selectedAgent: AgentKind = agentKind,
    ): Promise<void> => {
      if (spawning) return;
      setSpawning(mode);
      setError(undefined);
      try {
        const workspaceOptions: CreateAgentSessionOptions['workspace'] = resume
          ? resume.previous.info.mode === 'worktree'
            ? {
                mode: 'worktree',
                path: resume.previous.info.sourcePath,
                resumeBranch: resume.previous.info.branch,
                resumeRoot: resume.previous.final?.retained ? resume.previous.info.root : undefined,
              }
            : {
                mode: resume.previous.info.mode === 'exclusive' ? 'exclusive' : 'direct',
                path: resume.previous.info.root,
              }
          : mode === 'default'
            ? undefined
            : { mode };
        const result = await window.chopsticks.createAgentSession({
          agent: selectedAgent,
          ...(workspaceOptions ? { workspace: workspaceOptions } : {}),
          ...(resume ? { resume: resume.nativeSessionId } : {}),
        });
        if ('error' in result) {
          setError(result.error.message);
          return;
        }
        rememberAgent(result, resume ? 'resumed agent session' : undefined);
        workspace.addSession(result.session);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSpawning(undefined);
      }
    },
    [agentKind, rememberAgent, spawning, workspace],
  );

  const resumeAgent = useCallback(
    (runtimeSessionId: string): void => {
      const agent = agents.get(runtimeSessionId);
      const previous = workspaces.get(runtimeSessionId);
      if (!agent || !previous) return;
      setAgentKind(agent.agent);
      void spawnAgent(
        previous.info.mode === 'worktree' ? 'worktree' : previous.info.mode === 'exclusive' ? 'exclusive' : 'default',
        { nativeSessionId: agent.sessionId, previous },
        agent.agent,
      );
    },
    [agents, spawnAgent, workspaces],
  );

  useEffect(() => {
    let alive = true;
    const unsubscribeSession = window.chopsticks.onAgentSession((info) => rememberAgent(info));
    const unsubscribeRemoved = window.chopsticks.onAgentRemoved((runtimeSessionId) => {
      setAgents((current) => {
        const next = new Map(current);
        next.delete(runtimeSessionId);
        return next;
      });
      if (stateRecordsRef.current.delete(runtimeSessionId)) publishStates();
      setWorkspaces((current) => {
        const next = new Map(current);
        next.delete(runtimeSessionId);
        return next;
      });
    });
    const unsubscribeState = window.chopsticks.onAgentState((message) => {
      stateRecordsRef.current.set(message.runtimeSessionId, message);
      publishStates();
    });
    const unsubscribeFinal = window.chopsticks.onWorkspaceFinal((final: WorkspaceFinalEvent) => {
      setWorkspaces((current) => {
        const existing = current.get(final.runtimeSessionId);
        if (!existing) return current;
        return new Map(current).set(final.runtimeSessionId, {
          ...existing,
          final,
          diff: final.metadata.finalDiff,
        });
      });
    });
    void window.chopsticks.listAgentSessions().then((snapshots) => {
      if (!alive) return;
      const nextAgents = new Map<string, AgentSessionInfo>();
      const nextStates = new Map<string, AgentStateMessage>();
      const nextWorkspaces = new Map<string, WorkspacePanelData>();
      for (const snapshot of snapshots) {
        nextAgents.set(snapshot.info.runtimeSessionId, snapshot.info);
        if (snapshot.state) nextStates.set(snapshot.info.runtimeSessionId, snapshot.state);
        nextWorkspaces.set(snapshot.info.runtimeSessionId, {
          info: snapshot.info.workspace,
          final: snapshot.final,
          diff: snapshot.final?.metadata.finalDiff,
        });
      }
      setAgents(nextAgents);
      stateRecordsRef.current = new Map([...nextStates, ...stateRecordsRef.current]);
      publishStates();
      setWorkspaces((current) => new Map([...nextWorkspaces, ...current]));
    });
    return () => {
      alive = false;
      if (statePublishFrameRef.current !== undefined) {
        window.cancelAnimationFrame(statePublishFrameRef.current);
        statePublishFrameRef.current = undefined;
      }
      unsubscribeSession();
      unsubscribeRemoved();
      unsubscribeState();
      unsubscribeFinal();
    };
  }, [publishStates, rememberAgent]);

  const activeId = workspace.activeSession?.id;
  const activeAgent = activeId ? agents.get(activeId) : undefined;
  const activeWorkspace = activeId ? workspaces.get(activeId) : undefined;
  const activeMessage = activeId ? states.get(activeId) : undefined;
  const activeConversation = useActiveConversation(activeId && activeAgent ? activeId : undefined, activeMessage?.state.lastSequence);

  useEffect(() => {
    if (!activeId || !activeAgent || activeWorkspace?.final) return;
    let alive = true;
    const refresh = (): void => {
      void window.chopsticks.workspaceDiff(activeId).then((diff) => {
        if (!alive || !diff) return;
        setWorkspaces((current) => {
          const existing = current.get(activeId);
          return existing ? new Map(current).set(activeId, { ...existing, diff }) : current;
        });
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeAgent, activeId, activeWorkspace?.final]);

  return (
    <div className="agent-sidebar">
      <div className="agent-launcher">
        <div className="agent-launcher-row">
          <label htmlFor="agent-kind">Agent</label>
          <select id="agent-kind" value={agentKind} onChange={(event) => setAgentKind(event.target.value as AgentKind)}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="grok">Grok</option>
          </select>
        </div>
        <div className="agent-launch-actions">
          <button type="button" disabled={Boolean(spawning)} onClick={() => void spawnAgent('default')}>
            {spawning === 'default' ? 'Starting…' : 'Default'}
          </button>
          <button type="button" disabled={Boolean(spawning)} onClick={() => void spawnAgent('exclusive')}>
            {spawning === 'exclusive' ? 'Starting…' : 'Exclusive'}
          </button>
          <button type="button" disabled={Boolean(spawning)} onClick={() => void spawnAgent('worktree')}>
            {spawning === 'worktree' ? 'Starting…' : 'Worktree'}
          </button>
        </div>
        {error ? <div className="agent-launch-error">{error}</div> : null}
      </div>
      {activeId && activeAgent ? (
        <AgentPanel
          runtimeSessionId={activeId}
          agentKind={activeAgent.agent}
          message={activeMessage}
          conversation={activeConversation}
          workspace={activeWorkspace}
          exited={activeAgent.session.exited || Boolean(activeWorkspace?.final)}
          canResume={Boolean(activeWorkspace?.final)}
          onSubmit={(runtimeSessionId, text) => window.chopsticks.submitPrompt({ runtimeSessionId, text })}
          onResume={resumeAgent}
        />
      ) : (
        <div className="agent-empty">
          <span>
            {agents.size
              ? 'Focus an agent pane to observe and control it.'
              : 'Start an agent in an isolated workspace.'}
          </span>
          {agents.size ? (
            <div className="agent-session-list">
              {[...agents.values()].map((agent) => {
                const paneOpen = workspace.sessions.some((session) => session.id === agent.runtimeSessionId);
                const resumable = Boolean(workspaces.get(agent.runtimeSessionId)?.final);
                return (
                  <button
                    key={agent.runtimeSessionId}
                    type="button"
                    disabled={!paneOpen && !resumable}
                    onClick={() =>
                      paneOpen ? workspace.activateSession(agent.runtimeSessionId) : resumeAgent(agent.runtimeSessionId)
                    }
                  >
                    {agent.agent} · {agent.workspace.mode}
                    {!paneOpen && resumable ? ' · resume' : ''}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
