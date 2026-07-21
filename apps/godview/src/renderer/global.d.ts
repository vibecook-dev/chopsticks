import type { TerminalMenuAction } from '@vibecook/ghosttea-react';
import type { ChopsticksBridge } from '../protocol.js';

declare global {
  interface Window {
    chopsticks: ChopsticksBridge;
    desktop: {
      platform: string;
      tabId: string;
      claimExistingSessions: boolean;
      remoteSessionsEnabled: boolean;
      initialCwd?: string;
      defaultShell: string;
      writeClipboard: (text: string) => void;
      readClipboard: () => string;
      showContextMenu: (canCopy: boolean) => void;
      toggleFullscreen: () => void;
      closeWindow: () => void;
      newTab: (cwd?: string) => void;
      selectTab: (target: 'previous' | 'next' | number) => void;
      closeTab: () => void;
      updateTabSessions: (sessionIds: readonly string[]) => void;
      updateActiveCwd: (cwd?: string) => void;
      setTheme: (theme: 'light' | 'dark') => void;
      onThemeChanged: (listener: (theme: 'light' | 'dark') => void) => () => void;
      onMenuAction: (listener: (action: TerminalMenuAction) => void) => () => void;
    };
  }
}

export {};
