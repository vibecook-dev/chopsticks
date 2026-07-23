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
import { AgentSwarm, useLiveAgentViews, type AgentBubbleView, type UnassignedAgentView } from './AgentSwarm.js';
import { TweakPanel } from './TweakPanel.js';
import { agentColor, nextAgentForStatus, type AgentVisualStatus } from './agent-status.js';
import { folderName } from './folder-name.js';
import { buildPaneAttachments } from './pane-attachments.js';
import { paneBadgeLabel, paneSessionLaunchSource } from './pane-session.js';
import {
  DEFAULT_SWARM_PARAMETERS,
  normalizeSwarmParameters,
  type SwarmParameterKey,
  type SwarmParameters,
} from './swarm-parameters.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles.css';

type GodviewTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'godview:color-theme:v1';
const PARAMETERS_STORAGE_KEY = 'godview:swarm-parameters:v1';

function initialTheme(): GodviewTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function initialParameters(): SwarmParameters {
  try {
    const saved = localStorage.getItem(PARAMETERS_STORAGE_KEY);
    return normalizeSwarmParameters(saved ? JSON.parse(saved) : undefined);
  } catch {
    return { ...DEFAULT_SWARM_PARAMETERS };
  }
}

const bootTheme = initialTheme();
document.documentElement.dataset.theme = bootTheme;

const terminalRuntime = createGhostteaTerminalRuntime({
  ports: waitForGhostteaRendererPorts(),
  clientBuild: 'godview',
  // Godview windows are viewports, not PTY owners. Agent sessions remain live
  // while bubbles and panes attach, detach, or mirror them.
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
  const [parameters, setParameters] = useState<SwarmParameters>(initialParameters);
  const [tweakPanelOpen, setTweakPanelOpen] = useState(false);
  const [workspace, setWorkspace] = useState<GhostteaWorkspaceContext>();
  const [paneColors, setPaneColors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [unassignedAgents, setUnassignedAgents] = useState<readonly UnassignedAgentView[]>([]);
  const paneColorRegistry = useRef(new Map<string, string>());
  const nextPaneHue = useRef(Math.random() * 360);
  const agents = useLiveAgentViews();
  const platform = useMemo(
    () => ({
      platform: window.desktop.platform,
      defaultShell: window.desktop.defaultShell,
      readClipboard: window.desktop.readClipboard,
      setCanCopy: window.desktop.setTerminalCanCopy,
      showContextMenu: window.desktop.showContextMenu,
      toggleFullscreen: window.desktop.toggleFullscreen,
      closeWindow: window.desktop.closeWindow,
      newWindow: window.desktop.newWindow,
      quit: window.desktop.quit,
      closeAllWindows: window.desktop.closeAllWindows,
      openConfig: window.desktop.openConfig,
      reloadConfig: window.desktop.reloadConfig,
      newTab: window.desktop.newTab,
      // Godview reserves ⌘1/2/3 for status navigation. Ghosttea still owns
      // every other table-driven tab binding, including the "last" target.
      selectTab: (target: 'previous' | 'next' | 'last' | number) => {
        if (typeof target === 'number' && target >= 1 && target <= 3) return;
        window.desktop.selectTab(target);
      },
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
    try {
      localStorage.setItem(PARAMETERS_STORAGE_KEY, JSON.stringify(parameters));
    } catch {
      // Keep live controls usable when persistence is unavailable.
    }
  }, [parameters]);

  useEffect(() => {
    if (!tweakPanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTweakPanelOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [tweakPanelOpen]);

  useEffect(() => {
    const next = new Map<string, string>();
    for (const pane of workspace?.panes ?? []) {
      let color = paneColorRegistry.current.get(pane.id);
      if (!color) {
        color = `hsl(${Math.round(nextPaneHue.current)} 72% 48%)`;
        nextPaneHue.current = (nextPaneHue.current + 137.508) % 360;
        paneColorRegistry.current.set(pane.id, color);
      }
      next.set(pane.id, color);
    }
    for (const paneId of paneColorRegistry.current.keys()) {
      if (!next.has(paneId)) paneColorRegistry.current.delete(paneId);
    }
    setPaneColors((current) => {
      if (current.size === next.size && [...next].every(([id, color]) => current.get(id) === color)) return current;
      return next;
    });
  }, [workspace?.panes]);

  const selectBubble = useCallback(
    (bubble: AgentBubbleView): void => {
      if (!workspace) return;
      workspace.mountSession('info' in bubble ? bubble.info.session : bubble.session);
    },
    [workspace],
  );

  const createUnassignedAgent = useCallback(
    async (spawnPosition: { x: number; y: number }): Promise<void> => {
      if (!workspace?.activeSession) return;
      const sourceCwd = workspace.activeSession.cwd;
      const session = await workspace.createSessionInActivePane();
      if (!session) return;
      const cwd = session.cwd ?? sourceCwd;
      const placeholder: UnassignedAgentView = {
        id: session.id,
        session,
        ...(cwd ? { cwd } : {}),
        status: 'idle',
        project: folderName(cwd, 'terminal'),
        provider: '',
        detail: cwd || 'Unassigned terminal',
        color: agentColor(session.id),
        spawnPosition,
      };
      setUnassignedAgents((current) => [...current.filter((agent) => agent.id !== session.id), placeholder]);
    },
    [workspace],
  );

  const selectNextStatus = useCallback(
    (status: AgentVisualStatus): void => {
      if (!workspace) return;
      const next = nextAgentForStatus(agents, status, workspace.activeSession?.id);
      if (next) workspace.mountSession(next.info.session);
    },
    [agents, workspace],
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
  const agentBubbles = useMemo<readonly AgentBubbleView[]>(() => {
    return [...agents, ...unassignedAgents.filter((agent) => !agentsBySession.has(agent.session.id))];
  }, [agents, agentsBySession, unassignedAgents]);
  const paneAttachments = useMemo(
    () => buildPaneAttachments(workspace?.panes ?? [], paneColors, workspace?.activePaneId),
    [paneColors, workspace?.activePaneId, workspace?.panes],
  );
  const createSplitSession = useCallback(
    async (selectedSession: SessionSummary): Promise<SessionSummary> => {
      const refreshedSessions = await terminalRuntime.listSessions();
      const agent = agentsBySession.get(selectedSession.id);
      const unassigned = unassignedAgents.find((candidate) => candidate.session.id === selectedSession.id);
      const agentCwd = agent?.state?.state.environment.currentCwd?.value;
      const refreshedSession =
        refreshedSessions.find((candidate) => candidate.id === selectedSession.id) ?? selectedSession;
      const processCwd =
        !agentCwd && refreshedSession.pid ? await window.desktop.resolveProcessCwd(refreshedSession.pid) : undefined;
      const fallbackCwd =
        agent?.info.workspace.sourcePath || agent?.info.workspace.root || unassigned?.cwd || undefined;
      const source = paneSessionLaunchSource(selectedSession, refreshedSessions, {
        agent: agentCwd,
        process: processCwd,
        fallback: fallbackCwd,
      });
      return terminalRuntime.createSession({
        executable: platform.defaultShell,
        args: [],
        ...(source.cwd ? { cwd: source.cwd } : {}),
        environment: { mode: 'inherit' },
        cols: source.session.cols,
        rows: source.session.rows,
        persistence: 'terminate-with-app',
      });
    },
    [agentsBySession, platform.defaultShell, unassignedAgents],
  );
  const decoratePane = useCallback(
    (session: SessionSummary, paneId: string): GhostteaWorkspacePaneDecoration => {
      const agent = agentsBySession.get(session.id);
      const unassigned = unassignedAgents.find((candidate) => candidate.session.id === session.id);
      const label = paneBadgeLabel(session, agent?.project, unassigned?.cwd);
      const color = paneColors.get(paneId);
      return { label, ...(color ? { color } : {}) };
    },
    [agentsBySession, paneColors, unassignedAgents],
  );
  const counts = agents.reduce((current, agent) => ({ ...current, [agent.status]: current[agent.status] + 1 }), {
    idle: 0,
    working: 0,
    waiting: 0,
  });
  const screenStyle = {
    '--scanline-density': `${parameters.scanlineDensity}px`,
    '--scanline-opacity': parameters.scanlineOpacity,
    '--vignette-opacity': parameters.vignetteOpacity,
  } as CSSProperties;
  const updateParameter = useCallback((key: SwarmParameterKey, value: number): void => {
    setParameters((current) => normalizeSwarmParameters({ ...current, [key]: value }));
  }, []);

  return (
    <div className={`godview-screen theme-${theme} platform-${window.desktop.platform}`} style={screenStyle}>
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
                WAIT {counts.waiting}
                <kbd>⌘1</kbd>
              </button>
              <button type="button" onClick={() => selectNextStatus('working')}>
                WORK {counts.working}
                <kbd>⌘2</kbd>
              </button>
              <button type="button" onClick={() => selectNextStatus('idle')}>
                IDLE {counts.idle}
                <kbd>⌘3</kbd>
              </button>
            </nav>
            <button
              className={`godview-tweak-toggle${tweakPanelOpen ? ' is-open' : ''}`}
              type="button"
              aria-controls="godview-tweak-panel"
              aria-expanded={tweakPanelOpen}
              onClick={() => setTweakPanelOpen((current) => !current)}
            >
              TUNE
            </button>
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

        <TweakPanel
          open={tweakPanelOpen}
          theme={theme}
          parameters={parameters}
          onClose={() => setTweakPanelOpen(false)}
          onThemeChange={setTheme}
          onParameterChange={updateParameter}
          onReset={() => {
            setTheme('light');
            setParameters({ ...DEFAULT_SWARM_PARAMETERS });
          }}
        />

        <AgentSwarm
          agents={agentBubbles}
          paneAttachments={paneAttachments}
          parameters={parameters}
          activeSessionId={workspace?.activeSession?.id}
          onSelect={selectBubble}
          onCreateAt={createUnassignedAgent}
        />

        <section className="godview-terminal-deck" aria-label="Terminal panes">
          <WorkspaceReporterContext.Provider value={setWorkspace}>
            <GhostteaWorkspace
              platform={platform}
              storageKey={`godview:ghosttea-workspace:v2:${window.desktop.tabId}`}
              sidebar={WorkspaceReporter}
              theme={theme === 'dark' ? TERMINAL_THEMES.midnight : TERMINAL_THEMES.daylight}
              decoratePane={decoratePane}
              createSplitSession={createSplitSession}
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
