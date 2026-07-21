import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron';
import {
  GhostteaElectronBackend,
  type GhostteaAutomationClient,
  type GhostteaElectronBackendOptions,
  type SessionExitedEvent,
} from '@vibecook/ghosttea-electron/main';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentHost, SessionRuntimeState } from '@vibecook/chopsticks-core';
import { createActionRecorder } from '@vibecook/chopsticks-record';
import {
  buildAgentEnvironment,
  createBuiltinAgentRuntime,
  type AgentRuntime,
  type AgentWorkspaceFinal,
  type BuiltinExecutableAgentKind,
} from '@vibecook/chopsticks-runtime';
import type {
  AgentSessionInfo,
  AgentSessionSnapshot,
  AgentStateMessage,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PromptReceipt,
  SerializedSessionState,
  SubmitPromptOptions,
} from '../protocol.js';
import { missingManagedSessionIds } from './session-recovery.js';
import {
  prepareSpawnThroughLaunch,
  startSpawnThroughGateway,
  type SpawnThroughGateway,
  type SpawnThroughRequest,
  type SpawnThroughResponse,
} from './spawn-through.js';
import { GodviewTabRegistry } from './tab-registry.js';
import { godviewTruffleConfig } from './truffle-config.js';

declare const __dirname: string;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const AGENT_FLUSH_MS = 16;
const SMOKE = process.argv.includes('--smoke');
const SPAWN_THROUGH_SMOKE = process.argv
  .find((argument) => argument.startsWith('--spawn-through-smoke='))
  ?.slice('--spawn-through-smoke='.length) as BuiltinExecutableAgentKind | undefined;
const appRoot = resolve(__dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const ghostteaRoot = resolve(appRoot, '../../../../electron-ghostty');
const originalPath = process.env.PATH ?? '';

function executableOnOriginalPath(command: string): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes('/')
      ? [resolve(command)]
      : originalPath
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the original PATH.
    }
  }
  return undefined;
}

const realAgentExecutables: Partial<Record<BuiltinExecutableAgentKind, string>> = Object.fromEntries(
  (['claude', 'codex', 'grok'] as const).flatMap((agent) => {
    const configured = process.env[`CHOPSTICKS_${agent.toUpperCase()}_BIN`] ?? agent;
    const executable = executableOnOriginalPath(configured);
    return executable ? [[agent, executable]] : [];
  }),
);

app.setName('Godview');
nativeTheme.themeSource = 'light';
if (process.platform === 'darwin') app.setActivationPolicy('regular');
// Truffle state is a single-writer identity store. Native tabs share this
// process; a second Godview process must activate the existing owner instead
// of opening the same state directory concurrently.
const ownsTruffleState = app.requestSingleInstanceLock({ application: 'godview' });
if (!ownsTruffleState) app.quit();

const tabs = new GodviewTabRegistry<BrowserWindow>();
let backend: GhostteaElectronBackend | undefined;
let quitting = false;
let quitReady = false;
let shutdownPromise: Promise<void> | undefined;
let recoveringBackend: Promise<void> | undefined;
let lastFocusedWindow: BrowserWindow | undefined;
let spawnThroughGateway: SpawnThroughGateway | undefined;
let spawnThroughDirectory: string | undefined;
let spawnThroughEnvironment: NodeJS.ProcessEnv | undefined;
let remoteSessionsEnabled = true;
const wiredAutomationClients = new WeakSet<GhostteaAutomationClient>();
const managedTerminalIds = new Set<string>();
const exitCleanups = new Set<Promise<unknown>>();
const adoptedProcessMonitors = new Map<string, NodeJS.Timeout>();
const adoptedPreparationSessions = new Map<string, string>();

interface AgentRecord {
  info: AgentSessionInfo;
  session: SessionSummary;
  final?: AgentWorkspaceFinal;
}

const agentRecords = new Map<string, AgentRecord>();
const dirtyAgentStates = new Set<string>();
let agentFlushTimer: NodeJS.Timeout | undefined;

function broadcast(channel: string, value: unknown): void {
  for (const record of tabs.records()) {
    if (!record.window.isDestroyed()) record.window.webContents.send(channel, value);
  }
}

function backendOptions(): GhostteaElectronBackendOptions {
  const externalControl = process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET;
  const externalFrames = process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET;
  const externalToken = process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN;
  if (externalControl && externalFrames && externalToken) {
    return {
      mode: 'external',
      connection: { controlSocket: externalControl, frameSocket: externalFrames, authToken: externalToken },
      bridge: { entryPoint: join(__dirname, 'bridge-entry.js') },
    };
  }

  const configuredBinary =
    process.env.GHOSTTEAD_BIN ??
    process.env.TERMINALD_BIN ??
    (app.isPackaged
      ? join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ghosttead.exe' : 'ghosttead')
      : undefined);
  const truffle = godviewTruffleConfig({
    appRoot,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    platform: process.platform,
  });
  remoteSessionsEnabled = truffle.enabled;
  const environment: NodeJS.ProcessEnv = {
    ...spawnThroughEnvironment,
    ...truffle.environment,
  };
  return {
    mode: 'managed',
    daemon: {
      binary: configuredBinary
        ? { kind: 'executable', path: configuredBinary }
        : {
            kind: 'cargo',
            manifestPath: join(ghostteaRoot, 'native/ghosttead/Cargo.toml'),
            release: (process.env.GHOSTTEA_DEV_PROFILE ?? process.env.TERMINALD_DEV_PROFILE) !== 'debug',
          },
      environment,
    },
    bridge: { entryPoint: join(__dirname, 'bridge-entry.js') },
    automation: { clientBuild: 'godview' },
  };
}

const host: AgentHost = {
  async spawnTerminal(spec) {
    await ensureBackend();
    const session = await backend!.automation.createSession({
      executable: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      environment: { mode: 'clean', variables: buildAgentEnvironment({ allowed: spec.env }) },
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
      persistence: 'terminate-with-app',
    });
    managedTerminalIds.add(session.id);
    return { runtimeSessionId: session.id };
  },
  async automateTerminal(runtimeSessionId, operation) {
    await ensureBackend();
    const client = backend!.automation;
    const result =
      operation.kind === 'paste'
        ? operation.submit
          ? await client.pasteAndSubmit(runtimeSessionId, operation.text)
          : await client.paste(runtimeSessionId, operation.text)
        : operation.kind === 'text'
          ? await client.sendText(runtimeSessionId, operation.text)
          : await client.interrupt(runtimeSessionId);
    return result.accepted ? { accepted: true } : { accepted: false, reason: result.reason ?? 'human-input-conflict' };
  },
};

const recorder = createActionRecorder({
  onError: (error) => process.stderr.write(`[main] own-action record failed: ${error.message}\n`),
});
const agentRuntime: AgentRuntime = createBuiltinAgentRuntime({
  host,
  defaultCwd: repoRoot,
  executables: realAgentExecutables,
  recorder,
  onError: (error) => process.stderr.write(`[main] agent runtime: ${error.message}\n`),
});
agentRuntime.onEvent((runtimeSessionId) => {
  dirtyAgentStates.add(runtimeSessionId);
  scheduleAgentStateFlush();
});

function serializeState(state: SessionRuntimeState): SerializedSessionState {
  return {
    lifecycle: state.lifecycle,
    activeTurn: state.activeTurn,
    activeReasoning: state.activeReasoning,
    tools: [...state.tools.values()],
    permissions: [...state.permissions.values()],
    subagents: [...state.subagents.values()],
    tasks: [...state.tasks.values()],
    lastAssistantMessage: state.lastAssistantMessage,
    exit: state.exit,
    counters: state.counters,
    lastSequence: state.lastSequence,
    diagnostics: state.diagnostics,
  };
}

function stateSnapshot(runtimeSessionId: string): AgentStateMessage | undefined {
  const state = agentRuntime.sessionState(runtimeSessionId);
  const observationLevel = agentRuntime.observationLevel(runtimeSessionId);
  const conversation = agentRuntime.conversationSnapshot(runtimeSessionId);
  if (!state || !observationLevel || !conversation) return undefined;
  return { runtimeSessionId, state: serializeState(state), observationLevel, conversation };
}

function scheduleAgentStateFlush(): void {
  if (agentFlushTimer) return;
  agentFlushTimer = setTimeout(() => {
    agentFlushTimer = undefined;
    const sessionIds = [...dirtyAgentStates];
    dirtyAgentStates.clear();
    for (const sessionId of sessionIds) {
      const snapshot = stateSnapshot(sessionId);
      if (snapshot) broadcast('chopsticks:agent-state', snapshot);
    }
  }, AGENT_FLUSH_MS);
}

function pushWorkspaceFinal(final: AgentWorkspaceFinal): void {
  const record = agentRecords.get(final.runtimeSessionId);
  if (record) record.final = final;
  broadcast('chopsticks:workspace-final', final);
}

function stopAdoptedProcessMonitor(runtimeSessionId: string): void {
  const timer = adoptedProcessMonitors.get(runtimeSessionId);
  if (timer) clearInterval(timer);
  adoptedProcessMonitors.delete(runtimeSessionId);
  for (const [preparationId, sessionId] of adoptedPreparationSessions) {
    if (sessionId === runtimeSessionId) adoptedPreparationSessions.delete(preparationId);
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function finishAdoptedProcess(runtimeSessionId: string, reason = 'process-exited'): void {
  stopAdoptedProcessMonitor(runtimeSessionId);
  managedTerminalIds.delete(runtimeSessionId);
  const cleanup = agentRuntime
    .handleProcessExit(runtimeSessionId, { exitCode: null, signal: null, reason })
    .then((final) => {
      if (final) pushWorkspaceFinal(final);
    })
    .catch((error: unknown) => process.stderr.write(`[main] adopted agent exit cleanup failed: ${String(error)}\n`))
    .finally(() => exitCleanups.delete(cleanup));
  exitCleanups.add(cleanup);
}

function monitorAdoptedProcess(runtimeSessionId: string, processId: number, preparationId: string): void {
  stopAdoptedProcessMonitor(runtimeSessionId);
  adoptedPreparationSessions.set(preparationId, runtimeSessionId);
  const timer = setInterval(() => {
    if (!processIsAlive(processId)) finishAdoptedProcess(runtimeSessionId);
  }, 500);
  timer.unref?.();
  adoptedProcessMonitors.set(runtimeSessionId, timer);
}

function rememberAgent(info: AgentSessionInfo, session: SessionSummary): void {
  agentRecords.set(info.runtimeSessionId, { info, session });
  broadcast('chopsticks:agent-session', info);
  const snapshot = stateSnapshot(info.runtimeSessionId);
  if (snapshot) broadcast('chopsticks:agent-state', snapshot);
}

function onSessionExited(event: SessionExitedEvent): void {
  if (!managedTerminalIds.delete(event.sessionId)) return;
  stopAdoptedProcessMonitor(event.sessionId);
  const record = agentRecords.get(event.sessionId);
  if (record) {
    record.session = {
      ...record.session,
      exited: true,
      exitCode: event.exitCode,
      exitSignal: event.exitSignal,
      requestedTermination: event.requestedTermination,
      exitOutcome: event.exitOutcome,
    };
  }
  const cleanup = agentRuntime
    .handleProcessExit(event.sessionId, {
      exitCode: event.exitCode,
      signal: event.exitSignal,
      reason: event.exitOutcome,
    })
    .then((final) => {
      if (final) pushWorkspaceFinal(final);
    })
    .catch((error: unknown) => process.stderr.write(`[main] agent exit cleanup failed: ${String(error)}\n`))
    .finally(() => exitCleanups.delete(cleanup));
  exitCleanups.add(cleanup);
}

function wireAutomation(client: GhostteaAutomationClient): void {
  if (wiredAutomationClients.has(client)) return;
  wiredAutomationClients.add(client);
  client.on('session-exited', onSessionExited);
}

async function ensureBackend(): Promise<void> {
  if (!backend) {
    backend = new GhostteaElectronBackend(backendOptions());
    backend.on('unexpected-exit', ({ source, code, signal }) => {
      if (quitting) return;
      console.error(`${source} exited unexpectedly (${code ?? signal ?? 'unknown'}); restarting`);
      void recoverBackend();
    });
  }
  if (!backend.running) await backend.start();
  const automation = backend.automation;
  wireAutomation(automation);
}

async function reconcileManagedSessions(): Promise<void> {
  if (!backend) return;
  const liveSessionIds = (await backend.automation.listSessions()).map((session) => session.id);
  for (const sessionId of missingManagedSessionIds(managedTerminalIds, liveSessionIds)) {
    onSessionExited({
      requestId: 0,
      type: 'session-exited',
      sessionId,
      exitCode: null,
      exitSignal: null,
      requestedTermination: null,
      exitOutcome: 'unknown',
    });
  }
}

function recoverBackend(): Promise<void> {
  recoveringBackend ??= (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5 && !quitting; attempt += 1) {
      try {
        await ensureBackend();
        await reconcileManagedSessions();
        for (const record of tabs.records()) {
          if (!record.window.isDestroyed()) record.window.webContents.reload();
        }
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(5_000, 250 * 2 ** attempt)));
      }
    }
    if (lastError) console.error('terminal backend recovery failed', lastError);
  })().finally(() => {
    recoveringBackend = undefined;
  });
  return recoveringBackend;
}

async function createAgentSession(
  options: CreateAgentSessionOptions,
  owner?: BrowserWindow,
): Promise<CreateAgentSessionResult> {
  const result = await agentRuntime.createSession(options);
  if ('error' in result) return result;
  const session = await backend!.automation.getSession(result.runtimeSessionId);
  const info: AgentSessionInfo = { ...result, agent: result.agent as AgentSessionInfo['agent'], session };
  rememberAgent(info, session);
  if (owner) tabs.get(owner)?.sessionIds.add(result.runtimeSessionId);
  return info;
}

async function handleSpawnThroughRequest(request: SpawnThroughRequest): Promise<SpawnThroughResponse> {
  if (request.type === 'exec-failed') {
    const runtimeSessionId = adoptedPreparationSessions.get(request.preparationId);
    await agentRuntime.cancelPrepared(request.preparationId);
    if (runtimeSessionId) {
      stopAdoptedProcessMonitor(runtimeSessionId);
      managedTerminalIds.delete(runtimeSessionId);
      agentRecords.delete(runtimeSessionId);
      broadcast('chopsticks:agent-removed', runtimeSessionId);
    }
    process.stderr.write(`[main] spawn-through exec failed: ${request.message}\n`);
    return { action: 'ack' };
  }
  await ensureBackend();
  return prepareSpawnThroughLaunch(request, {
    runtime: agentRuntime,
    listSessions: () => backend!.automation.listSessions(),
    onAdopted: ({ info: adopted, session, processId, preparationId }) => {
      const info: AgentSessionInfo = {
        ...adopted,
        agent: adopted.agent as AgentSessionInfo['agent'],
        session,
      };
      managedTerminalIds.add(session.id);
      rememberAgent(info, session);
      monitorAdoptedProcess(session.id, processId, preparationId);
    },
  });
}

async function initializeSpawnThrough(): Promise<void> {
  if (spawnThroughGateway || process.platform === 'win32') return;
  const agents = Object.keys(realAgentExecutables) as BuiltinExecutableAgentKind[];
  if (agents.length === 0) return;
  const token = randomBytes(32).toString('hex');
  spawnThroughGateway = await startSpawnThroughGateway(token, handleSpawnThroughRequest);
  spawnThroughDirectory = join(app.getPath('temp'), `godview-agent-shims-${process.pid}`);
  rmSync(spawnThroughDirectory, { recursive: true, force: true });
  mkdirSync(spawnThroughDirectory, { recursive: true, mode: 0o700 });
  for (const agent of agents) {
    const destination = join(spawnThroughDirectory, agent);
    copyFileSync(join(__dirname, 'agent-shim.cjs'), destination);
    chmodSync(destination, 0o700);
  }
  const zDotDirectory = join(spawnThroughDirectory, 'zdot');
  mkdirSync(zDotDirectory, { recursive: true, mode: 0o700 });
  for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
    writeFileSync(
      join(zDotDirectory, file),
      [
        '_chopsticks_zdotdir="${CHOPSTICKS_ORIGINAL_ZDOTDIR:-$HOME}"',
        `if [[ -r "$_chopsticks_zdotdir/${file}" ]]; then source "$_chopsticks_zdotdir/${file}"; fi`,
        'export PATH="$CHOPSTICKS_SHIM_DIR:$PATH"',
        'unset _chopsticks_zdotdir',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }
  spawnThroughEnvironment = {
    CHOPSTICKS_SPAWN_PORT: String(spawnThroughGateway.port),
    CHOPSTICKS_SPAWN_TOKEN: token,
    CHOPSTICKS_SHIM_DIR: spawnThroughDirectory,
    CHOPSTICKS_ORIGINAL_ZDOTDIR: process.env.ZDOTDIR ?? '',
    PATH: `${spawnThroughDirectory}${delimiter}${originalPath}`,
    ZDOTDIR: zDotDirectory,
  };
}

function registerIpc(): void {
  ipcMain.handle('chopsticks:create-agent-session', (event, options: CreateAgentSessionOptions) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    return createAgentSession(options, owner && tabs.get(owner) ? owner : undefined);
  });
  ipcMain.handle('chopsticks:list-agent-sessions', (): AgentSessionSnapshot[] =>
    [...agentRecords.values()].map((record) => ({
      info: { ...record.info, session: record.session },
      state: stateSnapshot(record.info.runtimeSessionId),
      final: record.final,
    })),
  );
  ipcMain.handle('chopsticks:submit-prompt', (_event, options: SubmitPromptOptions): Promise<PromptReceipt> =>
    agentRuntime.submitPrompt(options.runtimeSessionId, { text: options.text }),
  );
  ipcMain.handle('chopsticks:workspace-diff', (_event, runtimeSessionId: string) =>
    agentRuntime.workspaceDiff(runtimeSessionId),
  );
}

ipcMain.on('terminal-context-menu', (event, canCopy: boolean) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window)) return;
  const send = (action: string): void => window.webContents.send('terminal-menu-action', action);
  Menu.buildFromTemplate([
    { label: 'Copy', enabled: Boolean(canCopy), click: () => send('copy') },
    { label: 'Paste', click: () => send('paste') },
    { type: 'separator' },
    { label: 'Select All', click: () => send('select-all') },
    { label: 'Clear Screen', click: () => send('clear-screen') },
  ]).popup({ window });
});

ipcMain.on('terminal-toggle-fullscreen', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && tabs.get(window)) window.setFullScreen(!window.isFullScreen());
});

ipcMain.on('terminal-close-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && tabs.get(window)) window.close();
});

ipcMain.on('terminal-new-tab', (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window)) return;
  void createWindow({ tabOf: window, initialCwd: typeof cwd === 'string' && cwd.trim() ? cwd : undefined }).catch(
    (error) => console.error('failed to create tab', error),
  );
});

ipcMain.on('terminal-select-tab', (event, target: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window)) return;
  if (target === 'previous') {
    if (process.platform === 'darwin') window.selectPreviousTab();
    else focusRelativeTab(window, -1);
  } else if (target === 'next') {
    if (process.platform === 'darwin') window.selectNextTab();
    else focusRelativeTab(window, 1);
  } else if (typeof target === 'number' && Number.isSafeInteger(target)) {
    focusTab(tabs.tabAt(window, target)?.window);
  }
});

ipcMain.on('terminal-close-tab', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window && tabs.get(window)) window.close();
});

ipcMain.on('terminal-tab-sessions', (event, sessionIds: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === 'string')) return;
  tabs.updateSessions(window, sessionIds);
});

ipcMain.on('terminal-tab-active-cwd', (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  tabs.updateActiveCwd(window, typeof cwd === 'string' && cwd.trim() ? cwd : undefined);
});

ipcMain.on('godview:set-theme', (event, value: unknown) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source) || (value !== 'light' && value !== 'dark')) return;
  nativeTheme.themeSource = value;
  const backgroundColor = value === 'dark' ? '#0a0a0a' : '#f7f7f7';
  for (const record of tabs.records()) {
    if (record.window.isDestroyed()) continue;
    record.window.setBackgroundColor(backgroundColor);
    record.window.webContents.send('godview:theme-changed', value);
  }
});

function focusGodviewWindow(): void {
  const window =
    BrowserWindow.getFocusedWindow() ??
    (lastFocusedWindow && !lastFocusedWindow.isDestroyed() ? lastFocusedWindow : tabs.records()[0]?.window);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.show();
  window.focus();
}

function focusTab(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

function focusRelativeTab(window: BrowserWindow, offset: -1 | 1): void {
  const current = tabs.get(window);
  if (!current) return;
  const group = tabs.group(current.groupId);
  const index = group.findIndex((record) => record.window === window);
  if (index < 0 || group.length < 2) return;
  focusTab(group[(index + offset + group.length) % group.length]?.window);
}

function terminateClosedTabSessions(sessionIds: ReadonlySet<string>): void {
  if (quitting || !backend || sessionIds.size === 0) return;
  for (const sessionId of sessionIds) {
    void backend.automation
      .terminate(sessionId, 'user')
      .catch((error) => console.warn(`[main] failed to terminate closed-tab session ${sessionId}`, error));
  }
}

interface CreateWindowOptions {
  tabOf?: BrowserWindow;
  initialCwd?: string;
  claimExistingSessions?: boolean;
}

async function createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
  await ensureBackend();
  const parentRecord = options.tabOf ? tabs.get(options.tabOf) : undefined;
  const groupId = parentRecord?.groupId ?? `godview-${randomUUID()}`;
  const tabId = randomUUID();
  const claimExistingSessions = options.claimExistingSessions ?? tabs.records().length === 0;
  const additionalArguments = [
    `--ghosttea-tab-id=${tabId}`,
    `--ghosttea-tab-claim-existing=${claimExistingSessions ? '1' : '0'}`,
    `--ghosttea-remote-sessions=${remoteSessionsEnabled ? '1' : '0'}`,
    ...(options.initialCwd ? [`--ghosttea-tab-cwd=${encodeURIComponent(options.initialCwd)}`] : []),
  ];
  const window = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 680,
    minHeight: 360,
    show: false,
    title: 'Godview',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#f7f7f7',
    titleBarStyle: 'default',
    ...(process.platform === 'darwin' ? { tabbingIdentifier: groupId } : {}),
    acceptFirstMouse: true,
    fullscreenable: true,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
      additionalArguments,
    },
  });
  const record = tabs.add(window, tabId, groupId);
  if (options.tabOf && process.platform === 'darwin' && !options.tabOf.isDestroyed()) {
    options.tabOf.addTabbedWindow(window);
  }
  const reveal = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.show();
    window.focus();
  };
  window.once('ready-to-show', reveal);
  window.on('focus', () => {
    lastFocusedWindow = window;
  });
  window.on('new-window-for-tab', () => {
    void createWindow({ tabOf: window, initialCwd: record.activeCwd }).catch((error) =>
      console.error('failed to create native tab', error),
    );
  });
  window.once('closed', () => {
    const closed = tabs.delete(window);
    if (lastFocusedWindow === window) lastFocusedWindow = undefined;
    if (closed) terminateClosedTabSessions(closed.sessionIds);
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed() && backend?.running) backend.attachRenderer(window.webContents);
  });
  await window.loadFile(join(__dirname, 'index.html'));
  reveal();
  return window;
}

async function runSmoke(): Promise<void> {
  await ensureBackend();
  const session = await backend!.automation.createSession({
    executable: '/bin/echo',
    args: ['SMOKE OK'],
    environment: { mode: 'inherit' },
    cols: 80,
    rows: 24,
    persistence: 'terminate-with-app',
  });
  const exited = await backend!.automation.waitForExit(session.id, 20_000);
  if (exited.exitCode !== 0) throw new Error(`smoke session exited ${exited.exitCode ?? exited.exitSignal}`);
  console.log('SMOKE OK');
}

async function runSpawnThroughSmoke(agent: BuiltinExecutableAgentKind): Promise<void> {
  if (!realAgentExecutables[agent]) throw new Error(`${agent} is not installed`);
  await ensureBackend();
  const session = await backend!.automation.createSession({
    executable:
      process.platform === 'win32' ? (process.env.COMSPEC ?? 'powershell.exe') : (process.env.SHELL ?? '/bin/zsh'),
    args: [],
    cwd: repoRoot,
    environment: { mode: 'inherit' },
    cols: 100,
    rows: 30,
    persistence: 'terminate-with-app',
  });
  const submitted = await backend!.automation.pasteAndSubmit(session.id, agent);
  if (!submitted.accepted) throw new Error(`spawn-through smoke input was rejected: ${submitted.reason}`);
  const deadline = Date.now() + 30_000;
  let lifecycle: string | undefined;
  while (Date.now() < deadline) {
    lifecycle = stateSnapshot(session.id)?.state.lifecycle;
    if (agentRecords.has(session.id) && lifecycle && !['preparing', 'starting'].includes(lifecycle)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const record = agentRecords.get(session.id);
  if (!record || record.info.agent !== agent || !record.info.preparationId) {
    throw new Error(`${agent} was not adopted into the shell terminal`);
  }
  if (!lifecycle || ['preparing', 'starting'].includes(lifecycle)) {
    throw new Error(`${agent} was adopted but structured control did not become ready`);
  }
  if (lifecycle === 'failed' || lifecycle === 'exited') {
    throw new Error(`${agent} entered terminal lifecycle ${lifecycle}`);
  }
  const prompt = process.env.CHOPSTICKS_SPAWN_SMOKE_PROMPT;
  if (prompt) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000));
    const promptResult = await backend!.automation.pasteAndSubmit(session.id, prompt);
    if (!promptResult.accepted) throw new Error(`spawn-through smoke prompt was rejected: ${promptResult.reason}`);
    const observationMs = Number(process.env.CHOPSTICKS_SPAWN_SMOKE_WAIT_MS ?? 12_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, observationMs));
    console.log(`SPAWN-THROUGH CONVERSATION ${JSON.stringify(agentRuntime.conversationSnapshot(session.id))}`);
  }
  console.log(`SPAWN-THROUGH SMOKE OK ${agent} ${record.info.sessionId}`);
  await backend!.automation.terminateAndWait(session.id, 'application', 5_000);
}

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    quitting = true;
    if (agentFlushTimer) clearTimeout(agentFlushTimer);
    for (const runtimeSessionId of adoptedProcessMonitors.keys()) stopAdoptedProcessMonitor(runtimeSessionId);
    const client = backend?.automation;
    if (client) {
      await Promise.allSettled([...managedTerminalIds].map((id) => client.terminateAndWait(id, 'application', 5_000)));
    }
    await Promise.allSettled([...exitCleanups]);
    const finals = await agentRuntime.dispose();
    for (const final of finals) pushWorkspaceFinal(final);
    backend?.stop();
    backend = undefined;
    await spawnThroughGateway?.close().catch(() => undefined);
    spawnThroughGateway = undefined;
    if (spawnThroughDirectory) rmSync(spawnThroughDirectory, { recursive: true, force: true });
    spawnThroughDirectory = undefined;
    spawnThroughEnvironment = undefined;
  })();
  return shutdownPromise;
}

registerIpc();
app
  .whenReady()
  .then(async () => {
    await initializeSpawnThrough();
    if (SMOKE || SPAWN_THROUGH_SMOKE) {
      if (SPAWN_THROUGH_SMOKE) await runSpawnThroughSmoke(SPAWN_THROUGH_SMOKE);
      else await runSmoke();
      await shutdown();
      app.exit(0);
      return;
    }
    await createWindow();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on('activate', () => {
  if (tabs.records().length === 0) {
    void createWindow({ claimExistingSessions: true }).catch((error) =>
      console.error('failed to recreate window', error),
    );
  } else {
    focusGodviewWindow();
  }
});

app.on('second-instance', () => focusGodviewWindow());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  void shutdown().finally(() => {
    quitReady = true;
    app.quit();
  });
});
