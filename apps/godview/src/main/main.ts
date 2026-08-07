import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, shell } from 'electron';
import {
  allSettledWithin,
  GhostteaElectronBackend,
  installGhostteaClipboardHost,
  installGhostteaEditShortcuts,
  type GhostteaAutomationClient,
  type GhostteaElectronBackendOptions,
  type SessionExitedEvent,
} from '@vibecook/ghosttea-electron/main';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { ghostteadPath } from '@vibecook/ghosttead';
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
  AgentAccountUsageBatch,
  AgentSessionInfo,
  AgentSessionSnapshot,
  AgentStateBatch,
  AgentStateMessage,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  PromptReceipt,
  SerializedSessionState,
  SubmitPromptOptions,
} from '../protocol.js';
import { createAccountUsageMonitor } from './account-usage-monitor.js';
import { missingManagedSessionIds } from './session-recovery.js';
import {
  prepareSpawnThroughLaunch,
  startSpawnThroughGateway,
  type SpawnThroughGateway,
  type SpawnThroughRequest,
  type SpawnThroughResponse,
} from './spawn-through.js';
import { orderNativeTabs } from './native-tab-order.js';
import { resolveProcessCwd } from './process-cwd.js';
import { GodviewTabRegistry } from './tab-registry.js';
import { godviewTruffleConfig } from './truffle-config.js';
import { LatestValueQueue } from './latest-value-queue.js';

declare const __dirname: string;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const AGENT_FLUSH_MS = 16;
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 5_000;
const SMOKE = process.argv.includes('--smoke');
const SPAWN_THROUGH_SMOKE = process.argv
  .find((argument) => argument.startsWith('--spawn-through-smoke='))
  ?.slice('--spawn-through-smoke='.length) as BuiltinExecutableAgentKind | undefined;
const appRoot = resolve(__dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const nativeTabAddonPaths = [
  join(app.getAppPath(), 'dist', 'native', 'ghosttea_native_tabs.node'),
  join(process.resourcesPath, 'native', 'ghosttea_native_tabs.node'),
];
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

const clipboardHost = installGhostteaClipboardHost(ipcMain, clipboard);

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

interface AgentStateDelivery {
  queue: LatestValueQueue<string, AgentStateMessage>;
  paused: boolean;
}

const agentStateDeliveries = new Map<number, AgentStateDelivery>();

function safeSend(window: BrowserWindow, channel: string, value: unknown): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
  try {
    window.webContents.send(channel, value);
    return true;
  } catch {
    // A renderer can disappear between the lifecycle check and send. Periodic
    // producers must stop quietly until did-finish-load resumes delivery.
    return false;
  }
}

function broadcast(channel: string, value: unknown): void {
  for (const record of tabs.records()) {
    safeSend(record.window, channel, value);
  }
}

function stateDeliveryFor(window: BrowserWindow): AgentStateDelivery {
  const id = window.webContents.id;
  let delivery = agentStateDeliveries.get(id);
  if (!delivery) {
    delivery = { queue: new LatestValueQueue(), paused: false };
    agentStateDeliveries.set(id, delivery);
  }
  return delivery;
}

function flushAgentStateDelivery(window: BrowserWindow): void {
  const delivery = stateDeliveryFor(window);
  if (delivery.paused) return;
  const batch = delivery.queue.take();
  if (!batch) return;
  const message: AgentStateBatch = { sequence: batch.sequence, states: batch.values };
  if (!safeSend(window, 'chopsticks:agent-states', message)) {
    delivery.queue.retryInFlight();
    delivery.paused = true;
  }
}

function publishAgentState(message: AgentStateMessage): void {
  for (const record of tabs.records()) {
    if (record.window.isDestroyed() || record.window.webContents.isDestroyed()) continue;
    const delivery = stateDeliveryFor(record.window);
    delivery.queue.enqueue(message.runtimeSessionId, message);
    flushAgentStateDelivery(record.window);
  }
}

function pauseAgentStateDelivery(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const delivery = agentStateDeliveries.get(window.webContents.id);
  if (!delivery) return;
  delivery.queue.retryInFlight();
  delivery.paused = true;
}

function resumeAgentStateDelivery(window: BrowserWindow): void {
  const delivery = stateDeliveryFor(window);
  delivery.queue.retryInFlight();
  delivery.paused = false;
  flushAgentStateDelivery(window);
}

function discardAgentState(runtimeSessionId: string): void {
  dirtyAgentStates.delete(runtimeSessionId);
  for (const delivery of agentStateDeliveries.values()) delivery.queue.delete(runtimeSessionId);
}

function isReleasedGhostteaPipeCleanupError(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException;
  return (
    process.platform === 'win32' &&
    failure?.code === 'EBUSY' &&
    failure.syscall === 'lstat' &&
    typeof failure.path === 'string' &&
    failure.path.startsWith('\\\\.\\pipe\\ghosttea-')
  );
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

  const daemonBinary =
    process.env.GHOSTTEAD_BIN ??
    process.env.TERMINALD_BIN ??
    (app.isPackaged
      ? join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ghosttead.exe' : 'ghosttead')
      : ghostteadPath());
  const truffle = godviewTruffleConfig({
    appRoot,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    platform: process.platform,
    enabledByDefault: !SMOKE && !SPAWN_THROUGH_SMOKE,
  });
  remoteSessionsEnabled = truffle.enabled;
  const environment: NodeJS.ProcessEnv = {
    ...spawnThroughEnvironment,
    ...truffle.environment,
  };
  return {
    mode: 'managed',
    daemon: {
      binary: { kind: 'executable', path: daemonBinary },
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
      programKind: 'application',
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
const accountUsageMonitor = createAccountUsageMonitor({
  fetchUsage: (agent) => agentRuntime.accountUsage(agent),
  publish: (batch: AgentAccountUsageBatch) => {
    if (!quitting) broadcast('chopsticks:account-usage', batch);
  },
  onError: (error) => process.stderr.write(`[main] account usage: ${error.message}\n`),
});
agentRuntime.onAccountUsage((agent, result) => {
  if (quitting) return;
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'grok') return;
  accountUsageMonitor.ingest(agent, result);
});
agentRuntime.onEvent((runtimeSessionId) => {
  const runtimeInfo = agentRuntime.sessionInfo(runtimeSessionId);
  const record = agentRecords.get(runtimeSessionId);
  if (runtimeInfo && record && record.info.sessionId !== runtimeInfo.sessionId) {
    record.info = { ...record.info, sessionId: runtimeInfo.sessionId };
    broadcast('chopsticks:agent-session', record.info);
  }
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
    contextWindow: state.contextWindow,
    environment: state.environment,
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
  if (!state || !observationLevel) return undefined;
  return { runtimeSessionId, state: serializeState(state), observationLevel };
}

function scheduleAgentStateFlush(): void {
  if (agentFlushTimer) return;
  agentFlushTimer = setTimeout(() => {
    agentFlushTimer = undefined;
    const sessionIds = [...dirtyAgentStates];
    dirtyAgentStates.clear();
    for (const sessionId of sessionIds) {
      const snapshot = stateSnapshot(sessionId);
      if (snapshot) publishAgentState(snapshot);
    }
  }, AGENT_FLUSH_MS);
}

function pushWorkspaceFinal(final: AgentWorkspaceFinal): void {
  const record = agentRecords.get(final.runtimeSessionId);
  if (record) record.final = final;
  discardAgentState(final.runtimeSessionId);
  broadcast('chopsticks:workspace-final', final);
  // Godview presents live topology only; completed session metadata has no
  // remaining consumer and must not accumulate across a long-running app.
  agentRecords.delete(final.runtimeSessionId);
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
  if (snapshot) publishAgentState(snapshot);
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
      discardAgentState(runtimeSessionId);
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
  ipcMain.handle('chopsticks:account-usage', () => accountUsageMonitor.snapshot());
  ipcMain.handle('chopsticks:refresh-account-usage', () => accountUsageMonitor.refresh());
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
  ipcMain.on('chopsticks:agent-states-ack', (event, sequence: unknown) => {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !tabs.get(window)) return;
    const delivery = agentStateDeliveries.get(event.sender.id);
    if (delivery?.queue.acknowledge(sequence)) flushAgentStateDelivery(window);
  });
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

ipcMain.on('terminal-new-window', (event, cwd: unknown) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  void createWindow({
    initialCwd: typeof cwd === 'string' && cwd.trim() ? cwd : undefined,
  }).catch((error) => console.error('failed to create window', error));
});

ipcMain.on('terminal-quit', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (source && tabs.get(source)) app.quit();
});

ipcMain.on('terminal-close-all-windows', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  for (const record of tabs.records()) {
    if (!record.window.isDestroyed()) record.window.close();
  }
});

async function openConfigPath(): Promise<void> {
  try {
    const errorMessage = await shell.openPath(app.getPath('userData'));
    if (errorMessage) console.error(`[main] failed to open config path: ${errorMessage}`);
  } catch (error) {
    console.error('[main] failed to open config path', error);
  }
}

ipcMain.on('terminal-open-config', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  void openConfigPath();
});

ipcMain.on('terminal-reload-config', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || !tabs.get(source)) return;
  for (const record of tabs.records()) {
    if (!record.window.isDestroyed()) record.window.webContents.reload();
  }
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
  } else if (target === 'last' || (typeof target === 'number' && Number.isSafeInteger(target))) {
    const current = tabs.get(window);
    if (!current) return;
    const orderedWindows = orderNativeTabs(
      tabs.group(current.groupId).map((record) => record.window),
      nativeTabAddonPaths,
    );
    if (orderedWindows.length === 0) return;
    const index =
      target === 'last' ? orderedWindows.length - 1 : Math.min(Math.max(target, 1), orderedWindows.length) - 1;
    focusTab(orderedWindows[index]);
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

ipcMain.handle('godview:process-cwd', (event, pid: unknown): Promise<string | undefined> => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !tabs.get(window) || typeof pid !== 'number') return Promise.resolve(undefined);
  return resolveProcessCwd(pid);
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
  const webContentsId = window.webContents.id;
  let rendererRecoveryTimer: NodeJS.Timeout | undefined;
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
    // A window is only a viewport. Its PTYs may be agents, may be mirrored in
    // another viewport, and must keep running until process exit or app
    // shutdown. Removing the attachment record is intentionally observational.
    tabs.delete(window);
    agentStateDeliveries.delete(webContentsId);
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    if (lastFocusedWindow === window) lastFocusedWindow = undefined;
  });
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    pauseAgentStateDelivery(window);
    console.error(`[renderer] process gone: ${details.reason} (${details.exitCode})`);
    if (quitting || window.isDestroyed() || details.reason === 'clean-exit' || rendererRecoveryTimer) return;
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = undefined;
      if (!quitting && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.reload();
    }, 250);
  });
  // Terminal selections live in the render worker rather than the DOM, so
  // Electron's native edit role cannot copy them. Route the shortcut through
  // the same renderer command path as the terminal context menu.
  installGhostteaEditShortcuts(
    window.webContents,
    (command) => window.webContents.send('terminal-menu-action', command),
    process.platform,
    (command) => command !== 'copy' || clipboardHost.canCopy(window.webContents),
  );
  window.webContents.on('did-finish-load', () => {
    resumeAgentStateDelivery(window);
    if (!window.isDestroyed() && backend?.running) backend.attachRenderer(window.webContents);
  });
  await window.loadFile(join(__dirname, 'index.html'));
  reveal();
  return window;
}

async function runSmoke(): Promise<void> {
  await ensureBackend();
  const smokeCommand =
    process.platform === 'win32'
      ? { executable: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', 'echo SMOKE OK'] }
      : { executable: '/bin/echo', args: ['SMOKE OK'] };
  const session = await backend!.automation.createSession({
    ...smokeCommand,
    environment: { mode: 'inherit' },
    cols: 80,
    rows: 24,
    persistence: 'terminate-with-app',
    programKind: 'application',
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
    programKind: 'interactive-shell',
  });
  const launchCommand = process.env.CHOPSTICKS_SPAWN_SMOKE_COMMAND ?? agent;
  const submitted = await backend!.automation.pasteAndSubmit(session.id, launchCommand);
  if (!submitted.accepted) throw new Error(`spawn-through smoke input was rejected: ${submitted.reason}`);
  const pickerDelayMs = Number(process.env.CHOPSTICKS_SPAWN_SMOKE_PICKER_ACCEPT_MS ?? 0);
  if (pickerDelayMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pickerDelayMs));
    const accepted = await backend!.automation.pasteAndSubmit(session.id, '');
    if (!accepted.accepted) throw new Error(`spawn-through smoke picker input was rejected: ${accepted.reason}`);
  }
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
  if (process.env.CHOPSTICKS_SPAWN_SMOKE_REQUIRE_HISTORY === '1') {
    const conversation = agentRuntime.conversationSnapshot(session.id);
    const hasUser = conversation?.items.some((item) => item.kind === 'user');
    const hasAssistant = conversation?.items.some((item) => item.kind === 'assistant');
    if (!hasUser || !hasAssistant) {
      throw new Error(`${agent} resumed but did not project its existing conversation history`);
    }
  }
  const prompt = process.env.CHOPSTICKS_SPAWN_SMOKE_PROMPT;
  if (prompt) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000));
    const prompts = [prompt, process.env.CHOPSTICKS_SPAWN_SMOKE_PROMPT_2].filter((value): value is string =>
      Boolean(value),
    );
    for (const [index, smokePrompt] of prompts.entries()) {
      const before = agentRuntime.conversationSnapshot(session.id);
      const assistantCount = before?.items.filter((item) => item.kind === 'assistant').length ?? 0;
      const promptResult = await backend!.automation.pasteAndSubmit(session.id, smokePrompt);
      if (!promptResult.accepted) throw new Error(`spawn-through smoke prompt was rejected: ${promptResult.reason}`);
      const observationMs = Number(process.env.CHOPSTICKS_SPAWN_SMOKE_WAIT_MS ?? 45_000);
      const turnDeadline = Date.now() + observationMs;
      let conversation = agentRuntime.conversationSnapshot(session.id);
      while (Date.now() < turnDeadline) {
        const state = agentRuntime.sessionState(session.id);
        conversation = agentRuntime.conversationSnapshot(session.id);
        const hasUser = conversation?.items.some((item) => item.kind === 'user' && item.text === smokePrompt);
        const nextAssistantCount = conversation?.items.filter((item) => item.kind === 'assistant').length ?? 0;
        if (
          hasUser &&
          nextAssistantCount > assistantCount &&
          !conversation?.responding &&
          state?.lifecycle === 'ready'
        ) {
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      const state = agentRuntime.sessionState(session.id);
      const hasUser = conversation?.items.some((item) => item.kind === 'user' && item.text === smokePrompt);
      const nextAssistantCount = conversation?.items.filter((item) => item.kind === 'assistant').length ?? 0;
      if (
        !hasUser ||
        nextAssistantCount <= assistantCount ||
        conversation?.responding ||
        state?.lifecycle !== 'ready'
      ) {
        throw new Error(
          `${agent} prompt ${index + 1} did not project as a completed conversation turn: ${JSON.stringify({ state, conversation })}`,
        );
      }
    }
    console.log(`SPAWN-THROUGH CONVERSATION ${JSON.stringify(agentRuntime.conversationSnapshot(session.id))}`);
  }
  console.log(`SPAWN-THROUGH SMOKE OK ${agent} ${record.info.sessionId}`);
  await backend!.automation.terminateAndWait(session.id, 'application', 5_000);
}

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    quitting = true;
    accountUsageMonitor.stop();
    if (agentFlushTimer) clearTimeout(agentFlushTimer);
    for (const runtimeSessionId of adoptedProcessMonitors.keys()) stopAdoptedProcessMonitor(runtimeSessionId);
    const client = backend?.automation;
    if (client) {
      const settled = await allSettledWithin(
        [...managedTerminalIds].map((id) => client.terminateAndWait(id, 'application', 5_000)),
        SHUTDOWN_CLEANUP_TIMEOUT_MS,
      );
      if (!settled) console.warn('[main] terminal cleanup timed out during shutdown');
    }
    if (!(await allSettledWithin(exitCleanups, SHUTDOWN_CLEANUP_TIMEOUT_MS))) {
      console.warn('[main] agent exit cleanup timed out during shutdown');
    }
    const finals = await agentRuntime.dispose();
    for (const final of finals) pushWorkspaceFinal(final);
    try {
      backend?.stop();
    } catch (error) {
      // Ghosttea 0.9.2 unlinks Windows named pipes even though the OS owns
      // their lifecycle. The daemon is already stopped when this EBUSY lands.
      if (!isReleasedGhostteaPipeCleanupError(error)) throw error;
    }
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
    accountUsageMonitor.start();
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
