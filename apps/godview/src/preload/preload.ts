import { clipboard, contextBridge, ipcRenderer } from 'electron';
import { forwardGhostteaRendererPorts } from '@vibecook/ghosttea-electron/preload';
import type {
  AgentSessionSnapshot,
  AgentSessionInfo,
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

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tabId = argument('ghosttea-tab-id') ?? 'default';
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
    const listener = (_event: Electron.IpcRendererEvent, state: AgentStateMessage): void => callback(state);
    ipcRenderer.on('chopsticks:agent-state', listener);
    return () => ipcRenderer.removeListener('chopsticks:agent-state', listener);
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
  claimExistingSessions,
  remoteSessionsEnabled,
  initialCwd,
  defaultShell:
    process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : (process.env.SHELL ?? '/bin/zsh'),
  writeClipboard: (text: string) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),
  showContextMenu: (canCopy: boolean) => ipcRenderer.send('terminal-context-menu', canCopy),
  toggleFullscreen: () => ipcRenderer.send('terminal-toggle-fullscreen'),
  closeWindow: () => ipcRenderer.send('terminal-close-window'),
  newTab: (cwd?: string) => ipcRenderer.send('terminal-new-tab', cwd),
  selectTab: (target: 'previous' | 'next' | number) => ipcRenderer.send('terminal-select-tab', target),
  closeTab: () => ipcRenderer.send('terminal-close-tab'),
  updateTabSessions: (sessionIds: readonly string[]) => ipcRenderer.send('terminal-tab-sessions', sessionIds),
  updateActiveCwd: (cwd?: string) => ipcRenderer.send('terminal-tab-active-cwd', cwd),
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on('terminal-menu-action', handler);
    return () => ipcRenderer.removeListener('terminal-menu-action', handler);
  },
});
