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
  type GhostteaPaneRehydration,
  type GhostteaWorkspaceContext,
  type GhostteaWorkspacePaneDecoration,
} from '@vibecook/ghosttea-react/workspace';
import { AccountUsagePanel } from './AccountUsagePanel.js';
import { TweakPanel, type TweakSection } from './TweakPanel.js';
import type { AgentVisualStatus } from './agent-status.js';
import { MONITOR_CHROME_ATTRIBUTE, MONITOR_STAGE_CLASS } from './monitor/chrome.js';
import { monitorAgentCounts, nextMonitorAgentForStatus } from './monitor/agents.js';
import {
  loadMonitorParameters,
  monitorParameterDefaults,
  normalizeMonitorParameters,
  saveMonitorParameters,
  type MonitorParameters,
} from './monitor/parameters.js';
import { MONITOR_VIEWS, monitorViewFor } from './monitor/registry.js';
import { useMonitorAgents } from './monitor/useMonitorAgents.js';
import { buildPaneAttachments } from './pane-attachments.js';
import { paneBadgeLabel, paneSessionLaunchSource } from './pane-session.js';
import { SCREEN_PARAMETER_GROUPS } from './screen-parameters.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles.css';

type GodviewTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'godview:color-theme:v1';
const VIEW_STORAGE_KEY = 'godview:monitor-view:v1';
const SCREEN_PARAMETERS_KEY = 'godview:screen-parameters:v1';
// Where every tunable lived before views owned their own controls; read as a
// seed so an installation keeps the look it was tuned to.
const LEGACY_PARAMETERS_KEY = 'godview:swarm-parameters:v1';
const WORKSPACE_STORAGE_KEY = `godview:ghosttea-workspace:v2:${window.desktop.tabId}`;

function viewParametersKey(viewId: string): string {
  return `godview:monitor-parameters:v1:${viewId}`;
}

// A slot is reused across windows, so an explicitly new tab starts from an
// empty document rather than inheriting the layout its predecessor left there.
//
// Strictly once per window. The flag is fixed at window creation and so is
// still set on a reload, and this window reloads itself to recover from a dead
// renderer — clearing again there would throw away the layout the user has
// built since opening it. sessionStorage is exactly the right lifetime: it
// survives the reload and dies with the window.
const WORKSPACE_RESET_MARKER = 'godview:workspace-reset-applied';
if (window.desktop.resetWorkspace) {
  try {
    if (!sessionStorage.getItem(WORKSPACE_RESET_MARKER)) {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      sessionStorage.setItem(WORKSPACE_RESET_MARKER, '1');
    }
  } catch {
    // A disabled storage partition already yields an empty workspace.
  }
}

function initialTheme(): GodviewTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function initialViewId(): string {
  try {
    return monitorViewFor(localStorage.getItem(VIEW_STORAGE_KEY)).id;
  } catch {
    return monitorViewFor(undefined).id;
  }
}

const bootTheme = initialTheme();
const bootViewId = initialViewId();
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
  const [viewId, setViewId] = useState(bootViewId);
  const [parametersByView, setParametersByView] = useState<Record<string, MonitorParameters>>(() => ({
    [bootViewId]: loadMonitorParameters(
      viewParametersKey(bootViewId),
      monitorViewFor(bootViewId).parameterGroups,
      LEGACY_PARAMETERS_KEY,
    ),
  }));
  const [screenParameters, setScreenParameters] = useState<MonitorParameters>(() =>
    loadMonitorParameters(SCREEN_PARAMETERS_KEY, SCREEN_PARAMETER_GROUPS, LEGACY_PARAMETERS_KEY),
  );
  const [tweakPanelOpen, setTweakPanelOpen] = useState(false);
  const [workspace, setWorkspace] = useState<GhostteaWorkspaceContext>();
  const [paneColors, setPaneColors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const paneColorRegistry = useRef(new Map<string, string>());
  const nextPaneHue = useRef(Math.random() * 360);
  const stageRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const view = monitorViewFor(viewId);
  // Seeded on boot and on every switch, so the fallback is a guard rather than a
  // path. Memoized regardless: a fresh object here would re-fire the save effect
  // on every render.
  const parameters = useMemo(
    () => parametersByView[view.id] ?? monitorParameterDefaults(view.parameterGroups),
    [parametersByView, view],
  );
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
      localStorage.setItem(VIEW_STORAGE_KEY, viewId);
    } catch {
      // Keep the switcher usable when persistence is unavailable.
    }
  }, [viewId]);

  useEffect(() => saveMonitorParameters(viewParametersKey(view.id), parameters), [parameters, view]);
  useEffect(() => saveMonitorParameters(SCREEN_PARAMETERS_KEY, screenParameters), [screenParameters]);

  useEffect(() => {
    if (!tweakPanelOpen) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTweakPanelOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [tweakPanelOpen]);

  // Views that lay out in flow clear the chrome with this; the swarm instead
  // reads the chrome's rect directly and steers bodies around it.
  useEffect(() => {
    const stage = stageRef.current;
    const chrome = chromeRef.current;
    if (!stage || !chrome) return;
    const publish = (): void =>
      stage.style.setProperty('--monitor-chrome-height', `${Math.round(chrome.getBoundingClientRect().height)}px`);
    const observer = new ResizeObserver(publish);
    observer.observe(chrome);
    publish();
    return () => observer.disconnect();
  }, []);

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

  const paneAttachments = useMemo(
    () => buildPaneAttachments(workspace?.panes ?? [], paneColors, workspace?.activePaneId),
    [paneColors, workspace?.activePaneId, workspace?.panes],
  );

  const onSessionExited = useCallback((listener: (sessionId: string) => void) => {
    const handler = (event: Event): void => listener((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    terminalRuntime.addEventListener('session-exited', handler);
    return () => terminalRuntime.removeEventListener('session-exited', handler);
  }, []);

  const { agents, actions } = useMonitorAgents({ workspace, attachments: paneAttachments, onSessionExited });
  const agentsBySession = useMemo(() => new Map(agents.map((agent) => [agent.session.id, agent] as const)), [agents]);
  const counts = useMemo(() => monitorAgentCounts(agents), [agents]);

  const selectNextStatus = useCallback(
    (status: AgentVisualStatus): void => {
      const next = nextMonitorAgentForStatus(agents, status, workspace?.activeSession?.id);
      if (next) actions.select(next);
    },
    [actions, agents, workspace?.activeSession?.id],
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

  const createSplitSession = useCallback(
    async (selectedSession: SessionSummary): Promise<SessionSummary> => {
      const refreshedSessions = await terminalRuntime.listSessions();
      const monitored = agentsBySession.get(selectedSession.id);
      const facet = monitored?.agent;
      const agentCwd = facet?.state?.state.environment.currentCwd?.value;
      const refreshedSession =
        refreshedSessions.find((candidate) => candidate.id === selectedSession.id) ?? selectedSession;
      const processCwd =
        !agentCwd && refreshedSession.pid ? await window.desktop.resolveProcessCwd(refreshedSession.pid) : undefined;
      const fallbackCwd = facet?.info.workspace.sourcePath || facet?.info.workspace.root || monitored?.cwd || undefined;
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
        programKind: 'interactive-shell',
      });
    },
    [agentsBySession, platform.defaultShell],
  );

  // Main owns the durable descriptors, so the answer to "what was this pane?"
  // is a lookup there; the saved session id is the key both sides already share.
  const rehydratePane = useCallback(
    ({ sessionId }: GhostteaPaneRehydration): Promise<SessionSummary | null> =>
      window.chopsticks.rehydratePane(sessionId),
    [],
  );

  const decoratePane = useCallback(
    (session: SessionSummary, paneId: string): GhostteaWorkspacePaneDecoration => {
      const monitored = agentsBySession.get(session.id);
      const label = paneBadgeLabel(session, monitored?.agent ? monitored.project : undefined, monitored?.cwd);
      const color = paneColors.get(paneId);
      return { label, ...(color ? { color } : {}) };
    },
    [agentsBySession, paneColors],
  );

  const updateParameter = useCallback(
    (key: string, value: number): void => {
      setParametersByView((current) => ({
        ...current,
        [view.id]: normalizeMonitorParameters(view.parameterGroups, { ...current[view.id], [key]: value }),
      }));
    },
    [view],
  );

  const updateScreenParameter = useCallback((key: string, value: number): void => {
    setScreenParameters((current) => normalizeMonitorParameters(SCREEN_PARAMETER_GROUPS, { ...current, [key]: value }));
  }, []);

  const selectView = useCallback((nextViewId: string): void => {
    const next = monitorViewFor(nextViewId);
    setParametersByView((current) =>
      current[next.id]
        ? current
        : {
            ...current,
            [next.id]: loadMonitorParameters(viewParametersKey(next.id), next.parameterGroups, LEGACY_PARAMETERS_KEY),
          },
    );
    setViewId(next.id);
  }, []);

  const tweakSections = useMemo<readonly TweakSection[]>(
    () => [
      ...SCREEN_PARAMETER_GROUPS.map((group) => ({
        id: `screen:${group.title}`,
        group,
        values: screenParameters,
        onChange: updateScreenParameter,
      })),
      ...view.parameterGroups.map((group) => ({
        id: `${view.id}:${group.title}`,
        group,
        values: parameters,
        onChange: updateParameter,
      })),
    ],
    [parameters, screenParameters, updateParameter, updateScreenParameter, view],
  );

  const screenStyle = {
    '--scanline-density': `${screenParameters.scanlineDensity}px`,
    '--scanline-opacity': screenParameters.scanlineOpacity,
    '--vignette-opacity': screenParameters.vignetteOpacity,
  } as CSSProperties;
  const MonitorView = view.Component;

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
            <select
              className="godview-view-switch"
              aria-label="Monitor view"
              value={view.id}
              onChange={(event) => selectView(event.currentTarget.value)}
            >
              {MONITOR_VIEWS.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
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
          sections={tweakSections}
          onClose={() => setTweakPanelOpen(false)}
          onThemeChange={setTheme}
          onReset={() => {
            setTheme('light');
            setScreenParameters(monitorParameterDefaults(SCREEN_PARAMETER_GROUPS));
            setParametersByView((current) => ({
              ...current,
              [view.id]: monitorParameterDefaults(view.parameterGroups),
            }));
          }}
        />

        <section ref={stageRef} className={MONITOR_STAGE_CLASS} aria-label="Agent monitor">
          <MonitorView agents={agents} parameters={parameters} actions={actions} />
          <div ref={chromeRef} className="godview-monitor-chrome" {...{ [MONITOR_CHROME_ATTRIBUTE]: '' }}>
            <AccountUsagePanel />
          </div>
        </section>

        <section className="godview-terminal-deck" aria-label="Terminal panes">
          <WorkspaceReporterContext.Provider value={setWorkspace}>
            <GhostteaWorkspace
              platform={platform}
              storageKey={WORKSPACE_STORAGE_KEY}
              sidebar={WorkspaceReporter}
              theme={theme === 'dark' ? TERMINAL_THEMES.midnight : TERMINAL_THEMES.daylight}
              decoratePane={decoratePane}
              createSplitSession={createSplitSession}
              onRehydratePane={rehydratePane}
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
