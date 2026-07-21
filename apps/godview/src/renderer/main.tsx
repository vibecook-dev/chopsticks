import {
  StrictMode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import {
  GhostteaProvider,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
} from '@vibecook/ghosttea-react';
import {
  GhostteaWorkspace,
  TERMINAL_THEMES,
  type GhostteaWorkspaceContext,
  type GhostteaWorkspacePaneDecoration,
} from '@vibecook/ghosttea-react/workspace';
import { AgentSwarm, useLiveAgentViews } from './AgentSwarm.js';
import type { AgentVisualStatus, LiveAgentView } from './agent-status.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles.css';

type GodviewTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'godview:color-theme:v1';

function initialTheme(): GodviewTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

const bootTheme = initialTheme();
document.documentElement.dataset.theme = bootTheme;

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
  const [theme, setTheme] = useState<GodviewTheme>(bootTheme);
  const [workspace, setWorkspace] = useState<GhostteaWorkspaceContext>();
  const [pendingFocus, setPendingFocus] = useState<string>();
  const [paneColors, setPaneColors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const paneColorRegistry = useRef(new Map<string, string>());
  const nextPaneHue = useRef(Math.random() * 360);
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
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // A disabled storage partition should not prevent theme switching.
    }
    window.desktop.setTheme(theme);
  }, [theme]);

  useEffect(() => window.desktop.onThemeChanged(setTheme), []);

  useEffect(() => {
    const next = new Map<string, string>();
    for (const session of workspace?.sessions ?? []) {
      let color = paneColorRegistry.current.get(session.id);
      if (!color) {
        color = `hsl(${Math.round(nextPaneHue.current)} 72% 48%)`;
        nextPaneHue.current = (nextPaneHue.current + 137.508) % 360;
        paneColorRegistry.current.set(session.id, color);
      }
      next.set(session.id, color);
    }
    setPaneColors((current) => {
      if (current.size === next.size && [...next].every(([id, color]) => current.get(id) === color)) return current;
      return next;
    });
  }, [workspace?.sessions]);

  useEffect(() => {
    if (!workspace || !pendingFocus || !workspace.sessions.some((session) => session.id === pendingFocus)) return;
    workspace.activateSession(pendingFocus);
    setPendingFocus(undefined);
  }, [pendingFocus, workspace]);

  const selectAgent = useCallback(
    (agent: LiveAgentView): void => {
      if (!workspace) return;
      const sessionId = agent.info.session.id;
      if (workspace.sessions.some((session) => session.id === sessionId)) {
        workspace.activateSession(sessionId);
        return;
      }
      workspace.addSession(agent.info.session);
      setPendingFocus(sessionId);
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

  const agentsBySession = useMemo(
    () => new Map(agents.map((agent) => [agent.info.session.id, agent] as const)),
    [agents],
  );
  const decoratePane = useCallback(
    (session: SessionSummary): GhostteaWorkspacePaneDecoration => {
      const agent = agentsBySession.get(session.id);
      const executable = session.executable.split(/[\\/]/).pop();
      const title = session.title?.trim();
      const label = agent
        ? `${agent.project} · ${agent.status}`
        : (title || executable || 'terminal');
      const color = paneColors.get(session.id);
      return { label, ...(color ? { color } : {}) };
    },
    [agentsBySession, paneColors],
  );
  const counts = agents.reduce(
    (current, agent) => ({ ...current, [agent.status]: current[agent.status] + 1 }),
    { idle: 0, working: 0, waiting: 0 },
  );
  return (
    <div className={`godview-screen theme-${theme} platform-${window.desktop.platform}`}>
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
          <div className="godview-header-actions">
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
            <button
              className="godview-theme-switch"
              type="button"
              role="switch"
              aria-checked={theme === 'dark'}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
            >
              <span aria-hidden="true">☼</span>
              <span className="godview-theme-switch-track" aria-hidden="true">
                <i />
              </span>
              <span aria-hidden="true">◐</span>
            </button>
          </div>
        </header>

        <AgentSwarm
          agents={agents}
          paneColors={paneColors}
          activeSessionId={workspace?.activeSession?.id}
          onSelect={selectAgent}
        />

        <section className="godview-terminal-deck" aria-label="Terminal panes">
          <WorkspaceReporterContext.Provider value={setWorkspace}>
            <GhostteaWorkspace
              platform={platform}
              storageKey={`godview:ghosttea-workspace:v2:${window.desktop.tabId}`}
              sidebar={WorkspaceReporter}
              theme={theme === 'dark' ? TERMINAL_THEMES.midnight : TERMINAL_THEMES.daylight}
              decoratePane={decoratePane}
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
