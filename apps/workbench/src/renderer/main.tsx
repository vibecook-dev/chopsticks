import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  GhostteaProvider,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
} from '@vibecook/ghosttea-react';
import { GhostteaWorkspace } from '@vibecook/ghosttea-react/workspace';
import { AgentSidebar } from './AgentSidebar.js';
import '@vibecook/ghosttea-react/styles.css';
import '@vibecook/ghosttea-react/workspace.css';
import './styles.css';

const terminalRuntime = createGhostteaTerminalRuntime({
  ports: waitForGhostteaRendererPorts(),
  clientBuild: 'chopsticks-workbench',
  // Workbench windows are viewports, not PTY owners. In particular, an
  // adopted agent must survive closing the window where its shell originated.
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

function Workbench() {
  const [active, setActive] = useState(document.visibilityState !== 'hidden');
  const platform = useMemo(
    () => ({
      platform: window.desktop.platform,
      defaultShell: window.desktop.defaultShell,
      readClipboard: window.desktop.readClipboard,
      showContextMenu: window.desktop.showContextMenu,
      toggleFullscreen: window.desktop.toggleFullscreen,
      closeWindow: window.desktop.closeWindow,
      newWindow: window.desktop.newWindow,
      quit: window.desktop.quit,
      closeAllWindows: window.desktop.closeAllWindows,
      openConfig: window.desktop.openConfig,
      reloadConfig: window.desktop.reloadConfig,
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

  return (
    <GhostteaWorkspace
      platform={platform}
      storageKey={`chopsticks:ghosttea-workspace:v2:${window.desktop.tabId}`}
      sidebar={AgentSidebar}
      claimExistingSessions={window.desktop.claimExistingSessions}
      enableRemoteSessions={window.desktop.remoteSessionsEnabled}
      active={active}
      showTitlebar={false}
      onSessionsChange={window.desktop.updateTabSessions}
      onActiveSessionChange={(session) => window.desktop.updateActiveCwd(session?.cwd ?? undefined)}
      {...(window.desktop.initialCwd ? { initialCwd: window.desktop.initialCwd } : {})}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GhostteaProvider runtime={terminalRuntime}>
      <Workbench />
    </GhostteaProvider>
  </StrictMode>,
);
