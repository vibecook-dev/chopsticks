/**
 * Claude session driver — the composition layer (DESIGN §11, §16).
 *
 * Runs HUB-SIDE (Electron main / future daemon), never in the pty-host: the
 * host stays Claude-agnostic. The driver owns observation and control only;
 * PROCESS lifecycle (spawn/terminate) belongs to the host behind the injected
 * ports:
 *
 *   prepare (settings + UUID join contract)
 *     → ports.spawn (the host carries the hook token in its explicit env grant)
 *     → hook bridge (loopback HTTP; the ONLY session it accepts is ours)
 *     → normalizer → envelope stamping → session reducer state
 *     → transcript observer (lazy: created at the first hook envelope, whose
 *       payload hands us transcript_path; every envelope pokes poll())
 *     → prompt injector (uses ports.automate; confirmation and
 *       permission gating wired from the normalized event stream)
 *
 * Observation level (DESIGN §19.2) is reported honestly: 'terminal-only'
 * until the first hook arrives, 'native-hooks' after.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentSession,
  type ObservationLevel,
  type TerminalAutomationOperation,
  type TerminalAutomationResult,
} from '@vibecook/chopsticks-core';
import { createHookBridge, type HookBridge } from './hook-bridge.js';
import { ClaudeHookNormalizer, type ClaudeHookPayload } from './normalizer.js';
import { prepareClaudeSession, cleanupClaudeSession, type PreparedClaudeSession } from './prepare.js';
import { createPromptInjector, type PromptInjector } from './prompt.js';
import {
  assistantMessageEvent,
  createTranscriptObserver,
  projectTranscriptHistory,
  type TranscriptObserver,
  type TranscriptRecordEvent,
} from './transcript-observer.js';
import { claudeContextWindowEvent, claudeEnvironmentEvent } from './statusline.js';

const TOKEN_ENV_VAR = 'CHOPSTICKS_HOOK_TOKEN';

export interface ClaudeSessionPorts {
  /** Spawn the prepared command; resolves with the host's session id for writes. */
  spawn(prepared: PreparedClaudeSession): Promise<{ runtimeSessionId: string }>;
  /** Ordered semantic automation; never attaches a view or claims layout. */
  automate(runtimeSessionId: string, operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
}

export interface CreateClaudeSessionOptions {
  cwd: string;
  ports: ClaudeSessionPorts;
  title?: string;
  executable?: string;
  permissionMode?: string;
  /** Model alias or full model id passed through to Claude Code. */
  model?: string;
  /**
   * Resume an existing session by id (native `--resume`; the session keeps its
   * transcript and id — HOOK-SURFACE-FINDINGS §6). Omit to start fresh.
   */
  resume?: string;
  /** Preserve Claude's native resume picker/continue selection after launch. */
  resumeInvocation?: string[];
  /** Observer fallback cadence; hook envelopes are the primary poll signal. */
  transcriptPollIntervalMs?: number;
}

/**
 * The core `AgentSession` handle (sessionId is the `--session-id` UUID = the
 * chopsticks ↔ spaghetti join contract) plus Claude-specific transcript extras.
 */
export interface ClaudeSession extends AgentSession {
  /** Absolute path to this session's transcript JSONL (handed to us by hooks). */
  transcriptPath(): string | undefined;
  /** Force a transcript delta parse now (tests, explicit refresh). */
  pollTranscript(): Promise<void>;
}

export interface PrepareClaudeTuiSessionOptions extends Omit<CreateClaudeSessionOptions, 'ports'> {
  /** Route semantic automation to a terminal after the preparation is adopted. */
  automate(runtimeSessionId: string, operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
}

/**
 * A live Claude hook bridge plus an authoritative launch recipe that has not
 * yet been bound to a host terminal. Call `adopt` before executing `launch` so
 * the runtime is subscribed before Claude can emit its first hook.
 */
export interface PreparedClaudeTuiSession {
  readonly sessionId: string;
  readonly launch: PreparedClaudeSession;
  adopt(runtimeSessionId: string): Promise<ClaudeSession>;
  dispose(): Promise<void>;
}

export async function prepareClaudeTuiSession(
  options: PrepareClaudeTuiSessionOptions,
): Promise<PreparedClaudeTuiSession> {
  if (options.resume && options.resumeInvocation) {
    throw new Error('Claude preparation accepts resume or resumeInvocation, not both');
  }
  // Session id first: the bridge must be able to enforce its allow-list from
  // the instant it starts listening, with no window where the closure could
  // dereference a not-yet-prepared session. On resume the id is the session
  // being resumed (it keeps its own id); otherwise mint a fresh one.
  const sessionId = options.resume ?? randomUUID();
  let selectedSessionId = options.resume;
  let selectionLocked = options.resume !== undefined;
  const bridge: HookBridge = createHookBridge({
    allowSession: (id, kind, body) => {
      if (!options.resumeInvocation) return id === sessionId;
      // The native resume picker renders status lines for the currently
      // highlighted conversation before the user commits a selection. That
      // preview must not claim the bridge. Claude can also emit SessionStart
      // for a picker preview before it emits the final resumed SessionStart,
      // so SessionStart may rebind only until the selected session reaches its
      // boot-finished InstructionsLoaded hook.
      if (kind === 'statusline' && selectedSessionId === undefined) return true;
      if (kind === 'hook' && body.hook_event_name === 'SessionStart') {
        if (selectionLocked) return id === selectedSessionId;
        selectedSessionId = id;
        return true;
      }
      selectedSessionId ??= id;
      if (id !== selectedSessionId) return false;
      if (kind === 'hook' && body.hook_event_name === 'InstructionsLoaded' && body.load_reason === 'session_start') {
        selectionLocked = true;
      }
      return true;
    },
  });
  await bridge.start();

  try {
    const prepared = await prepareClaudeSession({
      cwd: options.cwd,
      sessionId,
      resume: options.resume,
      resumeInvocation: options.resumeInvocation,
      title: options.title,
      executable: options.executable,
      permissionMode: options.permissionMode,
      model: options.model,
      endpoint: bridge.endpoint(),
      statusLineEndpoint: bridge.statusLineEndpoint(),
      tokenEnvVar: TOKEN_ENV_VAR,
      token: bridge.token,
    });

    return createPreparedClaudeSession(options, bridge, prepared, () => selectedSessionId ?? prepared.sessionId);
  } catch (err) {
    await bridge.dispose();
    throw err;
  }
}

function createPreparedClaudeSession(
  options: PrepareClaudeTuiSessionOptions,
  bridge: HookBridge,
  prepared: PreparedClaudeSession,
  nativeSessionId: () => string = () => prepared.sessionId,
): PreparedClaudeTuiSession {
  const normalizer = new ClaudeHookNormalizer();
  const stamper = createEnvelopeStamper();
  let state = createInitialSessionState();
  let observation: ObservationLevel = 'terminal-only';
  let transcriptPath: string | undefined;
  let observer: TranscriptObserver | undefined;
  let observerGeneration = 0;
  let historyBootstrap: Promise<void> | undefined;
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: ClaudeSession | undefined;
  let disposed = false;
  const eventListeners = new Set<(e: AgentEventEnvelope) => void>();

  const injector: PromptInjector = createPromptInjector({
    automate: (operation) => {
      if (!adoptedRuntimeSessionId) {
        return Promise.resolve({ accepted: false, reason: 'prepared Claude session is not adopted' });
      }
      return options.automate(adoptedRuntimeSessionId, operation);
    },
  });

  function apply(
    event: AgentEvent,
    meta: {
      source: AgentEventEnvelope['source'];
      timestamp: string;
      promptId?: string;
      turnId?: string;
      native?: unknown;
      replay?: boolean;
    },
  ): void {
    const envelope = stamper.next({
      sessionId: nativeSessionId(),
      nativeSessionId: nativeSessionId(),
      promptId: meta.promptId,
      turnId: meta.turnId,
      timestamp: meta.timestamp,
      monotonicTime: performance.now(),
      source: meta.source,
      confidence: 'authoritative',
      ...(meta.replay ? { replay: true } : {}),
      event,
      nativeEvent: meta.native,
    });
    state = reduceSessionState(state, envelope);

    // Injector wiring rides the normalized stream, not raw payloads.
    switch (event.type) {
      case 'turn.started':
        injector.handleTurnStarted(event.turnId, event.prompt);
        break;
      case 'permission.requested':
        injector.setPermissionPending(true);
        break;
      // The dialog is gone on any of these; denial has no positive signal
      // (the absence pattern), so turn/session boundaries clear the gate.
      case 'permission.resolved':
      case 'turn.completed':
      case 'turn.failed':
      case 'session.exited':
        injector.setPermissionPending(false);
        break;
    }

    for (const listener of eventListeners) {
      try {
        listener(envelope);
      } catch {
        /* listener faults stay out of the pipeline */
      }
    }
  }

  function ensureObserver(path: string): void {
    if (observer && transcriptPath === path) return;
    observer?.stop();
    observerGeneration += 1;
    const generation = observerGeneration;
    transcriptPath = path;
    const nextObserver = createTranscriptObserver(path, { pollIntervalMs: options.transcriptPollIntervalMs });
    observer = nextObserver;
    const historyRecords: TranscriptRecordEvent[] = [];
    let capturingHistory = options.resume !== undefined || options.resumeInvocation !== undefined;
    nextObserver.onRecord((record) => {
      if (generation !== observerGeneration) return;
      if (capturingHistory) {
        historyRecords.push(record);
        return;
      }
      const event = assistantMessageEvent(record.message);
      if (!event) return; // non-assistant records: transcript is enrichment, not lifecycle
      apply(event, {
        source: 'native-transcript',
        timestamp: (record.message as { timestamp?: string }).timestamp ?? new Date().toISOString(),
        native: record.message,
      });
    });
    nextObserver.onError(() => {
      // §16.8: transcript failure must never fail the session; hooks carry on.
    });
    historyBootstrap = capturingHistory
      ? nextObserver
          .notifyActivity()
          .then(() => {
            if (generation !== observerGeneration) return;
            capturingHistory = false;
            for (const projection of projectTranscriptHistory(historyRecords.map((record) => record.message))) {
              apply(projection.event, {
                source: 'native-transcript',
                timestamp: projection.timestamp ?? new Date().toISOString(),
                promptId: projection.promptId,
                turnId: projection.turnId,
                native: projection.nativeEvent,
                replay: true,
              });
            }
          })
          .catch(() => {
            capturingHistory = false;
          })
      : undefined;
  }

  bridge.onEvent((hookEnvelope) => {
    observation = 'native-hooks';
    const body = hookEnvelope.body as ClaudeHookPayload;
    const normalized = normalizer.normalize(body);
    // A picker preview can emit SessionStart. Wait for the selected session's
    // boot-finished hook before binding its durable transcript.
    if (
      normalized.transcriptPath &&
      (!options.resumeInvocation ||
        (body.hook_event_name === 'InstructionsLoaded' && body.load_reason === 'session_start'))
    ) {
      ensureObserver(normalized.transcriptPath);
    }
    const deliver = (): void => {
      for (const event of normalized.events) {
        apply(event, {
          source: 'native-hook',
          timestamp: hookEnvelope.receivedAt,
          promptId: normalized.promptId,
          turnId: normalized.turnId,
          native: body,
        });
      }
      // Hooks fire 1:1 with transcript appends — poke the tail now instead of
      // waiting out its fallback interval.
      void observer?.notifyActivity();
    };

    // SessionStart establishes identity, then durable history must be
    // projected before any newer hook mutates state. Promise callbacks retain
    // bridge arrival order, forming the Claude equivalent of Codex's replay
    // barrier.
    if (historyBootstrap && body.hook_event_name !== 'SessionStart') {
      void historyBootstrap.then(deliver);
    } else {
      deliver();
    }
  });

  bridge.onStatusLine((statusEnvelope) => {
    const environment = claudeEnvironmentEvent(statusEnvelope.body);
    if (environment) {
      const current = state.environment;
      const unchangedCwd = environment.currentCwd === undefined || environment.currentCwd === current.currentCwd?.value;
      const unchangedModel =
        environment.model === undefined ||
        (environment.model !== null &&
          environment.model.id === current.model?.value.id &&
          environment.model.displayName === current.model?.value.displayName);
      if (!unchangedCwd || !unchangedModel) {
        apply(environment, {
          source: 'native-statusline',
          timestamp: statusEnvelope.receivedAt,
          native: statusEnvelope.body,
        });
      }
    }

    const contextEvent = claudeContextWindowEvent(statusEnvelope.body);
    if (!contextEvent) return;
    const currentContext = state.contextWindow;
    if (contextEvent.type === 'context-window.invalidated') {
      if (!currentContext) return;
    } else if (
      currentContext?.usedTokens === contextEvent.usedTokens &&
      currentContext.capacityTokens === contextEvent.capacityTokens &&
      currentContext.modelId === contextEvent.modelId
    ) {
      return;
    }
    apply(contextEvent, {
      source: 'native-statusline',
      timestamp: statusEnvelope.receivedAt,
      native: statusEnvelope.body,
    });
  });

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    observer?.stop();
    eventListeners.clear();
    await bridge.dispose();
    await cleanupClaudeSession(prepared);
  }

  return {
    sessionId: prepared.sessionId,
    launch: prepared,
    async adopt(runtimeSessionId): Promise<ClaudeSession> {
      if (disposed) throw new Error('prepared Claude session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Claude session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = {
        get sessionId() {
          return nativeSessionId();
        },
        runtimeSessionId,
        state: () => state,
        observationLevel: () => observation,
        transcriptPath: () => transcriptPath,
        onEvent(listener) {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        },
        submitPrompt: (submission) => injector.submit(submission),
        pollTranscript: async () => {
          await historyBootstrap;
          await observer?.notifyActivity();
        },
        dispose,
      };
      return adoptedSession;
    },
    dispose,
  };
}

export async function createClaudeSession(options: CreateClaudeSessionOptions): Promise<ClaudeSession> {
  const prepared = await prepareClaudeTuiSession({
    cwd: options.cwd,
    title: options.title,
    executable: options.executable,
    permissionMode: options.permissionMode,
    model: options.model,
    resume: options.resume,
    resumeInvocation: options.resumeInvocation,
    transcriptPollIntervalMs: options.transcriptPollIntervalMs,
    automate: options.ports.automate,
  });
  try {
    const { runtimeSessionId } = await options.ports.spawn(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (err) {
    await prepared.dispose();
    throw err;
  }
}
