/**
 * Grok's native-TUI recipe (leader + TUI + ACP control) as one `AgentSession`.
 *
 * Grok-specific behavior contained here:
 *   1. a shared `grok agent leader`, spawned once and owned by the backend;
 *   2. a native `grok --leader` TUI spawned through the host terminal;
 *   3. a generic ACP client attached to the leader session, with Grok-specific
 *      command arguments and retry behavior while the TUI registers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAcpSession, createStdioAcpConnector } from '@vibecook/chopsticks-adapter-acp';
import type { CreateAcpSessionOptions } from '@vibecook/chopsticks-adapter-acp';
import {
  createInitialSessionState,
  createEnvelopeStamper,
  reduceSessionState,
  type AgentEventEnvelope,
  type AgentHost,
  type AgentSession,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
  type SessionRuntimeState,
  type TerminalSpec,
} from '@vibecook/chopsticks-core';
import {
  createGrokSessionObserver,
  grokUpdatesPath,
  latestGrokSessionId,
  type GrokObservedEvent,
  type GrokSessionObserver,
} from './session-observer.js';

export interface CreateGrokBackendOptions {
  /** Grok executable (default `grok`). */
  executable?: string;
  /** The host terminal capability the TUI is spawned through. */
  host: AgentHost;
}

export interface GrokBackend {
  /** Start a Grok tab: native TUI + a control client attached to the same session. */
  createSession(opts: CreateGrokSessionOptions): Promise<AgentSession>;
  /** Prepare leader wiring and a native launch recipe without spawning the TUI. */
  prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession>;
  /** Tear down the shared leader (host shutdown). */
  dispose(): void;
}

export interface CreateGrokSessionOptions {
  cwd: string;
  resume?: string;
  /** Resolve and resume Grok's most recently updated session for this cwd. */
  resumeLatest?: boolean;
  /** Model id passed to the native Grok TUI. */
  model?: string;
  /** Grok permission mode. Kept open because the CLI's modes evolve. */
  permissionMode?: string;
  /** Grok sandbox profile passed to the native TUI. */
  sandbox?: string;
  /** ACP capabilities advertised by the structured control client. */
  clientCapabilities?: CreateAcpSessionOptions['clientCapabilities'];
  /** Decide ACP permission requests. Default: deny. */
  onApproval?: CreateAcpSessionOptions['onApproval'];
}

export interface PreparedGrokSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AgentSession>;
  dispose(): Promise<void>;
}

/** Bind a prepared Grok recipe to exactly one caller-owned terminal. */
export function createPreparedGrokSession(
  sessionId: string,
  launch: TerminalSpec,
  attach: () => AgentSession | Promise<AgentSession>,
  disposeUnadopted?: () => void | Promise<void>,
  observe?: () => GrokSessionObserver,
): PreparedGrokSession {
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: AgentSession | undefined;
  let disposed = false;

  return {
    sessionId,
    launch,
    async adopt(runtimeSessionId): Promise<AgentSession> {
      if (disposed) throw new Error('prepared Grok session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Grok session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = createPendingControlSession(sessionId, runtimeSessionId, attach, observe?.());
      return adoptedSession;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (adoptedSession) await adoptedSession.dispose().catch(() => undefined);
      else await Promise.resolve(disposeUnadopted?.()).catch(() => undefined);
    },
  };
}

/** Build the native TUI invocation for a new or resumed leader-owned session. */
export function buildGrokTuiArgs(
  socketPath: string,
  sessionId: string,
  opts: Pick<CreateGrokSessionOptions, 'resume' | 'model' | 'permissionMode' | 'sandbox'>,
): string[] {
  const args: string[] = [];
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.permissionMode !== undefined) args.push('--permission-mode', opts.permissionMode);
  if (opts.sandbox !== undefined) args.push('--sandbox', opts.sandbox);
  args.push('--leader', '--leader-socket', socketPath);
  args.push(opts.resume ? '--resume' : '--session-id', sessionId);
  return args;
}

/** Open ACP control through the shared leader, optionally loading an existing session. */
async function openControl(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string | undefined,
  opts: Pick<CreateGrokSessionOptions, 'clientCapabilities' | 'onApproval'>,
): Promise<AgentSession> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  return createAcpSession({
    cwd,
    connector: createStdioAcpConnector({ executable, args, cwd }),
    ...(sessionId ? { resume: sessionId } : {}),
    clientCapabilities: opts.clientCapabilities,
    onApproval: opts.onApproval,
  });
}

/**
 * A Grok TUI session whose ACP control client attaches asynchronously. The TUI
 * is usable immediately; observation and prompt injection bind once attach
 * succeeds.
 */
export function createPendingControlSession(
  sessionId: string,
  runtimeSessionId: string,
  attach: () => AgentSession | Promise<AgentSession>,
  observer?: GrokSessionObserver,
): AgentSession {
  const listeners = new Set<(event: AgentEventEnvelope) => void>();
  let control: AgentSession | undefined;
  let disposed = false;
  // TUI conversation and lifecycle are authoritative in Grok's persisted
  // structured log. ACP remains a control/approval side channel.
  const observation: ObservationLevel = observer ? 'native-log' : 'structured';
  const stamper = createEnvelopeStamper();
  let pendingState = createInitialSessionState();
  let unsubscribeControl: (() => void) | undefined;
  let unsubscribeObserver: (() => void) | undefined;
  let unsubscribeObserverError: (() => void) | undefined;
  let protocolContextAvailable = false;

  function publish(envelope: AgentEventEnvelope): void {
    pendingState = reduceSessionState(pendingState, envelope);
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch {
        /* listener faults stay out of the pipeline */
      }
    }
  }

  function applyObserved(observed: GrokObservedEvent): void {
    if (
      protocolContextAvailable &&
      observed.source === 'native-log' &&
      observed.event.type.startsWith('context-window.')
    ) {
      return;
    }
    publish(
      stamper.next({
        sessionId,
        nativeSessionId: sessionId,
        promptId: observed.promptId,
        turnId: observed.promptId,
        timestamp: observed.timestamp ?? new Date().toISOString(),
        monotonicTime: performance.now(),
        source: observed.source ?? 'native-transcript',
        confidence: observed.confidence ?? 'authoritative',
        event: observed.event,
        nativeEvent: observed.nativeEvent,
      }),
    );
  }

  function failControl(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = stamper.next({
      sessionId,
      nativeSessionId: sessionId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source: 'runtime',
      confidence: 'authoritative',
      event: { type: 'process.exited', reason: 'crash' },
      nativeEvent: { code: 'grok-control-attach-failed', message },
    });
    const reduced = reduceSessionState(pendingState, envelope);
    const failed = {
      ...reduced,
      diagnostics: [
        ...reduced.diagnostics,
        { sequence: envelope.sequence, code: 'grok-control-attach-failed', message },
      ],
    };
    pendingState = failed;
    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch {
        /* listener faults stay out of the pipeline */
      }
    }
  }

  function bindControl(acp: AgentSession): AgentSession | undefined {
    if (disposed) {
      void acp.dispose().catch(() => undefined);
      return undefined;
    }
    control = acp;
    applyObserved({
      event: { type: 'session.ready' },
      source: 'runtime',
      confidence: 'authoritative',
      nativeEvent: { code: 'grok-control-attached' },
    });
    unsubscribeControl = acp.onEvent((envelope) => {
      // The native log owns TUI conversation and lifecycle. ACP remains the
      // live authority for host-side permissions and standard context usage.
      const allowedWithObserver = [
        'permission.requested',
        'permission.resolved',
        'context-window.updated',
        'context-window.invalidated',
      ];
      if (observer && !allowedWithObserver.includes(envelope.event.type)) return;
      if (envelope.event.type.startsWith('context-window.')) protocolContextAvailable = true;
      applyObserved({
        event: envelope.event,
        promptId: pendingState.activeTurn?.id,
        timestamp: envelope.timestamp,
        source: envelope.source,
        confidence: envelope.confidence,
        nativeEvent: envelope.nativeEvent,
      });
    });
    return acp;
  }

  if (observer) {
    unsubscribeObserver = observer.onEvent(applyObserved);
    unsubscribeObserverError = observer.onError((error) => {
      applyObserved({
        event: { type: 'adapter.native-event', adapter: 'grok', nativeType: 'updates-log-error' },
        source: 'runtime',
        confidence: 'derived',
        nativeEvent: { message: error.message },
      });
    });
    // Start after listeners are wired. The async read gives the runtime time to
    // subscribe while still catching records written before terminal adoption.
    void observer.poll();
  }

  let controlReady: Promise<AgentSession | undefined>;
  try {
    const attached = attach();
    if (typeof (attached as Promise<AgentSession>).then === 'function') {
      controlReady = Promise.resolve(attached)
        .then(bindControl)
        .catch((error: unknown) => {
          failControl(error);
          return undefined;
        });
    } else {
      controlReady = Promise.resolve(bindControl(attached as AgentSession));
    }
  } catch (error) {
    failControl(error);
    controlReady = Promise.resolve(undefined);
  }

  return {
    sessionId,
    runtimeSessionId,
    state: (): SessionRuntimeState => pendingState,
    observationLevel: () => observation,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      const acp = control ?? (await controlReady.catch(() => undefined));
      if (!acp) return { status: 'rejected', reason: 'grok control client not attached' };
      return acp.submitPrompt(submission);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeControl?.();
      unsubscribeObserver?.();
      unsubscribeObserverError?.();
      observer?.stop();
      if (control) await control.dispose().catch(() => undefined);
    },
  };
}

export function createGrokBackend(options: CreateGrokBackendOptions): GrokBackend {
  const executable = options.executable ?? 'grok';
  const host = options.host;
  let leader: { socketPath: string; child: ChildProcess } | undefined;

  async function ensureLeader(): Promise<string> {
    if (leader && leader.child.exitCode === null && !leader.child.killed) return leader.socketPath;
    // macOS /tmp is a symlink the agent's socket bind rejects — use the real tmp.
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chopsticks-grok-'));
    const socketPath = join(dir, 'leader.sock');
    const child = spawn(
      executable,
      ['agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--leader-socket', socketPath],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 80 && !existsSync(socketPath); i++) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!existsSync(socketPath)) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      throw new Error('grok agent leader failed to start (no socket)');
    }
    leader = { socketPath, child };
    return socketPath;
  }

  async function prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession> {
    const { cwd } = opts;
    const socketPath = await ensureLeader();
    // Materialize the leader-owned session before returning the launch recipe.
    // A fresh TUI does not persist its --session-id until the first prompt, so
    // racing session/load against process startup can leave control unattached
    // forever. ACP session/new gives us the authoritative id up front; the TUI
    // then joins that already-real session through --resume.
    const resume = opts.resume ?? (opts.resumeLatest ? await latestGrokSessionId(cwd) : undefined);
    if (opts.resumeLatest && !resume) throw new Error(`no Grok session is available to resume in ${cwd}`);
    const control = await openControl(executable, cwd, socketPath, resume, opts);
    const sessionId = control.sessionId;
    const launch: TerminalSpec = {
      command: executable,
      args: buildGrokTuiArgs(socketPath, sessionId, { ...opts, resume: sessionId }),
      cwd,
    };
    return createPreparedGrokSession(
      sessionId,
      launch,
      () => control,
      () => control.dispose(),
      () => createGrokSessionObserver(grokUpdatesPath(cwd, sessionId)),
    );
  }

  return {
    prepareSession,

    async createSession(opts): Promise<AgentSession> {
      const prepared = await prepareSession(opts);
      try {
        const { runtimeSessionId } = await host.spawnTerminal(prepared.launch);
        return await prepared.adopt(runtimeSessionId);
      } catch (err) {
        await prepared.dispose();
        throw err;
      }
    },

    dispose(): void {
      if (!leader) return;
      try {
        leader.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      leader = undefined;
    },
  };
}
