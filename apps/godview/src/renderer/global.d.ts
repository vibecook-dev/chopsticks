import type { TerminalMenuAction } from '@vibecook/ghosttea-react';
import type { ChopsticksBridge } from '../protocol.js';

declare global {
  interface Window {
    chopsticks: ChopsticksBridge;
    desktop: {
      platform: string;
      tabId: string;
      resetWorkspace: boolean;
      claimExistingSessions: boolean;
      remoteSessionsEnabled: boolean;
      initialCwd?: string;
      defaultShell: string;
      writeClipboard: (text: string) => void;
      readClipboard: () => Promise<string>;
      setTerminalCanCopy: (canCopy: boolean) => void;
      showContextMenu: (canCopy: boolean) => void;
      toggleFullscreen: () => void;
      closeWindow: () => void;
      newWindow: (cwd?: string) => void;
      quit: () => void;
      closeAllWindows: () => void;
      openConfig: () => void;
      reloadConfig: () => void;
      newTab: (cwd?: string) => void;
      selectTab: (target: 'previous' | 'next' | 'last' | number) => void;
      closeTab: () => void;
      updateTabSessions: (sessionIds: readonly string[]) => void;
      updateActiveCwd: (cwd?: string) => void;
      resolveProcessCwd: (pid: number) => Promise<string | undefined>;
      setTheme: (theme: 'light' | 'dark') => void;
      onThemeChanged: (listener: (theme: 'light' | 'dark') => void) => () => void;
      onMenuAction: (listener: (action: TerminalMenuAction) => void) => () => void;
    };
  }
}

export {};
