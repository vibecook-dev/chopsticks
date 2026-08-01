import { contextBridge, ipcRenderer } from 'electron';
import { createGhostteaClipboardBridge, forwardGhostteaRendererPorts } from '@vibecook/ghosttea-electron/preload';
import type {
  AgentAccountUsageBatch,
  AgentSessionSnapshot,
  AgentSessionInfo,
  AgentStateBatch,
  AgentStateMessage,
  ChopsticksBridge,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PromptReceipt,
  SubmitPromptOptions,
  WorkspaceDiff,
  WorkspaceFinalEvent,
} from '../protocol.js';

forwardGhostteaRendererPorts(ipcRenderer);
const clipboardBridge = createGhostteaClipboardBridge(ipcRenderer);
const agentStateListeners = new Set<(state: AgentStateMessage) => void>();

ipcRenderer.on('chopsticks:agent-states', (_event, batch: AgentStateBatch) => {
  try {
    for (const state of batch.states) {
      for (const listener of agentStateListeners) listener(state);
    }
  } finally {
    ipcRenderer.send('chopsticks:agent-states-ack', batch.sequence);
  }
});

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tabId = argument('ghosttea-tab-id') ?? 'default';
const resetWorkspace = argument('ghosttea-tab-reset') === '1';
const claimExistingSessions = argument('ghosttea-tab-claim-existing') !== '0';
const remoteSessionsEnabled = argument('ghosttea-remote-sessions') !== '0';
const encodedInitialCwd = argument('ghosttea-tab-cwd');
let initialCwd: string | undefined;
try {
  initialCwd = encodedInitialCwd ? decodeURIComponent(encodedInitialCwd) : undefined;
} catch {
  initialCwd = undefined;
}

const chopsticks: ChopsticksBridge = {
  accountUsage: (): Promise<AgentAccountUsageBatch> => ipcRenderer.invoke('chopsticks:account-usage'),
  refreshAccountUsage: (): Promise<AgentAccountUsageBatch> => ipcRenderer.invoke('chopsticks:refresh-account-usage'),
  onAccountUsage: (callback: (batch: AgentAccountUsageBatch) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, batch: AgentAccountUsageBatch): void => callback(batch);
    ipcRenderer.on('chopsticks:account-usage', listener);
    return () => ipcRenderer.removeListener('chopsticks:account-usage', listener);
  },
  createAgentSession: (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> =>
    ipcRenderer.invoke('chopsticks:create-agent-session', options),
  listAgentSessions: (): Promise<AgentSessionSnapshot[]> => ipcRenderer.invoke('chopsticks:list-agent-sessions'),
  onAgentSession: (callback: (info: AgentSessionInfo) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: AgentSessionInfo): void => callback(info);
    ipcRenderer.on('chopsticks:agent-session', listener);
    return () => ipcRenderer.removeListener('chopsticks:agent-session', listener);
  },
  onAgentRemoved: (callback: (runtimeSessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, runtimeSessionId: string): void => callback(runtimeSessionId);
    ipcRenderer.on('chopsticks:agent-removed', listener);
    return () => ipcRenderer.removeListener('chopsticks:agent-removed', listener);
  },
  submitPrompt: (options: SubmitPromptOptions): Promise<PromptReceipt> =>
    ipcRenderer.invoke('chopsticks:submit-prompt', options),
  onAgentState: (callback: (state: AgentStateMessage) => void): (() => void) => {
    agentStateListeners.add(callback);
    return () => agentStateListeners.delete(callback);
  },
  workspaceDiff: (runtimeSessionId: string): Promise<WorkspaceDiff | null> =>
    ipcRenderer.invoke('chopsticks:workspace-diff', runtimeSessionId),
  onWorkspaceFinal: (callback: (event: WorkspaceFinalEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, final: WorkspaceFinalEvent): void => callback(final);
    ipcRenderer.on('chopsticks:workspace-final', listener);
    return () => ipcRenderer.removeListener('chopsticks:workspace-final', listener);
  },
};

contextBridge.exposeInMainWorld('chopsticks', chopsticks);
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  tabId,
  resetWorkspace,
  claimExistingSessions,
  remoteSessionsEnabled,
  initialCwd,
  defaultShell:
    process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : (process.env.SHELL ?? '/bin/zsh'),
  writeClipboard: clipboardBridge.writeText,
  readClipboard: clipboardBridge.readText,
  setTerminalCanCopy: clipboardBridge.setCanCopy,
  showContextMenu: (canCopy: boolean) => ipcRenderer.send('terminal-context-menu', canCopy),
  toggleFullscreen: () => ipcRenderer.send('terminal-toggle-fullscreen'),
  closeWindow: () => ipcRenderer.send('terminal-close-window'),
  newWindow: (cwd?: string) => ipcRenderer.send('terminal-new-window', cwd),
  quit: () => ipcRenderer.send('terminal-quit'),
  closeAllWindows: () => ipcRenderer.send('terminal-close-all-windows'),
  openConfig: () => ipcRenderer.send('terminal-open-config'),
  reloadConfig: () => ipcRenderer.send('terminal-reload-config'),
  newTab: (cwd?: string) => ipcRenderer.send('terminal-new-tab', cwd),
  selectTab: (target: 'previous' | 'next' | 'last' | number) => ipcRenderer.send('terminal-select-tab', target),
  closeTab: () => ipcRenderer.send('terminal-close-tab'),
  updateTabSessions: (sessionIds: readonly string[]) => ipcRenderer.send('terminal-tab-sessions', sessionIds),
  updateActiveCwd: (cwd?: string) => ipcRenderer.send('terminal-tab-active-cwd', cwd),
  resolveProcessCwd: (pid: number): Promise<string | undefined> => ipcRenderer.invoke('godview:process-cwd', pid),
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.send('godview:set-theme', theme),
  onThemeChanged: (listener: (theme: 'light' | 'dark') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark'): void => listener(theme);
    ipcRenderer.on('godview:theme-changed', handler);
    return () => ipcRenderer.removeListener('godview:theme-changed', handler);
  },
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on('terminal-menu-action', handler);
    return () => ipcRenderer.removeListener('terminal-menu-action', handler);
  },
});
