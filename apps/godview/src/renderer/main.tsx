import {
  StrictMode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  GhostteaProvider,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
} from '@vibecook/ghosttea-react';
import {
  GhostteaWorkspace,
  TERMINAL_THEMES,
  type GhostteaWorkspaceContext,
} from '@vibecook/ghosttea-react/workspace';
import { AgentSwarm, useLiveAgentViews } from './AgentSwarm.js';
import type { AgentVisualStatus, LiveAgentView } from './agent-status.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles.css';

const terminalRuntime = createGhostteaTerminalRuntime({
  ports: waitForGhostteaRendererPorts(),
  clientBuild: 'godview',
  platform: {
    writeClipboard: (text) => window.desktop.writeClipboard(text),
    forceCanvasFallback: () => sessionStorage.getItem('ghosttea:force-canvas-fallback') === '1',
    setForceCanvasFallback: (enabled) => {
      if (enabled) sessionStorage.setItem('ghosttea:force-canvas-fallback', '1');
      else sessionStorage.removeItem('ghosttea:force-canvas-fallback');
    },
    reload: () => window.location.reload(),
  },
});

const WorkspaceReporterContext = createContext<(workspace: GhostteaWorkspaceContext) => void>(() => undefined);

function WorkspaceReporter({ workspace }: { workspace: GhostteaWorkspaceContext }) {
  const report = useContext(WorkspaceReporterContext);
  useEffect(() => report(workspace), [report, workspace]);
  return null;
}

function Godview() {
  const [active, setActive] = useState(document.visibilityState !== 'hidden');
  const [workspace, setWorkspace] = useState<GhostteaWorkspaceContext>();
  const [pendingFocus, setPendingFocus] = useState<string>();
  const agents = useLiveAgentViews();
  const cycleIndexes = useRef<Record<AgentVisualStatus, number>>({ idle: -1, working: -1, waiting: -1 });
  const platform = useMemo(
    () => ({
      platform: window.desktop.platform,
      defaultShell: window.desktop.defaultShell,
      readClipboard: window.desktop.readClipboard,
      showContextMenu: window.desktop.showContextMenu,
      toggleFullscreen: window.desktop.toggleFullscreen,
      closeWindow: window.desktop.closeWindow,
      newTab: window.desktop.newTab,
      selectTab: window.desktop.selectTab,
      closeTab: window.desktop.closeTab,
      onMenuAction: window.desktop.onMenuAction,
    }),
    [],
  );

  useEffect(() => {
    const updateVisibility = (): void => setActive(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (!workspace || !pendingFocus || !workspace.sessions.some((session) => session.id === pendingFocus)) return;
    workspace.activateSession(pendingFocus);
    setPendingFocus(undefined);
  }, [pendingFocus, workspace]);

  const selectAgent = useCallback(
    (agent: LiveAgentView): void => {
      if (!workspace) return;
      if (workspace.sessions.some((session) => session.id === agent.id)) {
        workspace.activateSession(agent.id);
        return;
      }
      workspace.addSession(agent.info.session);
      setPendingFocus(agent.id);
    },
    [workspace],
  );

  const selectNextStatus = useCallback(
    (status: AgentVisualStatus): void => {
      const matching = agents.filter((agent) => agent.status === status);
      if (matching.length === 0) return;
      const nextIndex = (cycleIndexes.current[status] + 1) % matching.length;
      cycleIndexes.current[status] = nextIndex;
      selectAgent(matching[nextIndex]!);
    },
    [agents, selectAgent],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      const status = ({ Digit1: 'waiting', Digit2: 'working', Digit3: 'idle' } as const)[
        event.code as 'Digit1' | 'Digit2' | 'Digit3'
      ];
      if (!status) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      selectNextStatus(status);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [selectNextStatus]);

  const activeAgent = agents.find((agent) => agent.id === workspace?.activeSession?.id);
  const counts = agents.reduce(
    (current, agent) => ({ ...current, [agent.status]: current[agent.status] + 1 }),
    { idle: 0, working: 0, waiting: 0 },
  );
  const shellStyle = {
    '--pane-link-color': activeAgent?.color ?? '#111111',
  } as CSSProperties;

  return (
    <div className={`godview-screen platform-${window.desktop.platform}`} style={shellStyle}>
      <div className="godview-scanlines" aria-hidden="true" />
      <div className="godview-vignette" aria-hidden="true" />
      <main className="godview-app">
        <header className="godview-header">
          <div className="godview-window-controls" aria-hidden="true">
            <i className="is-close" />
            <i className="is-minimize" />
            <i className="is-expand" />
          </div>
          <div className="godview-title">
            <span>GODVIEW</span>
            <small>AGENT TOPOLOGY</small>
          </div>
          <nav className="godview-status-controls" aria-label="Agent status shortcuts">
            <button type="button" onClick={() => selectNextStatus('waiting')}>
              WAIT {counts.waiting}<kbd>⌘1</kbd>
            </button>
            <button type="button" onClick={() => selectNextStatus('working')}>
              WORK {counts.working}<kbd>⌘2</kbd>
            </button>
            <button type="button" onClick={() => selectNextStatus('idle')}>
              IDLE {counts.idle}<kbd>⌘3</kbd>
            </button>
          </nav>
        </header>

        <AgentSwarm agents={agents} activeSessionId={workspace?.activeSession?.id} onSelect={selectAgent} />

        <section className="godview-terminal-deck" aria-label="Terminal panes">
          <div className="godview-terminal-label" style={{ backgroundColor: activeAgent?.color }}>
            {activeAgent ? `${activeAgent.project} · ${activeAgent.status}` : 'terminal'}
          </div>
          <WorkspaceReporterContext.Provider value={setWorkspace}>
            <GhostteaWorkspace
              platform={platform}
              storageKey={`godview:ghosttea-workspace:v2:${window.desktop.tabId}`}
              sidebar={WorkspaceReporter}
              theme={TERMINAL_THEMES.daylight}
              claimExistingSessions={window.desktop.claimExistingSessions}
              enableRemoteSessions={window.desktop.remoteSessionsEnabled}
              active={active}
              showTitlebar={false}
              onSessionsChange={window.desktop.updateTabSessions}
              onActiveSessionChange={(session) => window.desktop.updateActiveCwd(session?.cwd ?? undefined)}
              {...(window.desktop.initialCwd ? { initialCwd: window.desktop.initialCwd } : {})}
            />
          </WorkspaceReporterContext.Provider>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GhostteaProvider runtime={terminalRuntime}>
      <Godview />
    </GhostteaProvider>
  </StrictMode>,
);
