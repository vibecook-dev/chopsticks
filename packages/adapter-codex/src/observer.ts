/**
 * Codex thread observer (M5 C6) — attach to a thread and feed the shared
 * normalizer + reducer. Two attach modes:
 *
 * 1. **Passive (legacy Model B):** wait for `thread/started` from another
 *    connection (e.g. a bare `codex --remote` TUI), then `thread/resume` until
 *    the rollout materializes. Used by live tests that drive a separate
 *    `createCodexSession`.
 *
 * 2. **Controller-owned (workbench default):** this connection
 *    `thread/start`s (or resumes a known id), materializes with an empty
 *    `thread/inject_items` so resume/TUI work without a user prompt, then
 *    opens the live stream. Proven 2026-07-15
 *    (`probe/codex/controller-owned-thread-probe3.mjs`): empty inject writes
 *    the rollout without a model turn, so the panel can go `ready` immediately
 *    and the TUI joins via `codex resume <id> --remote`.
 *
 * Observe-from-attach replays the completed turns returned by `thread/resume`
 * before reducing live notifications. A resumed native TUI must therefore
 * project the conversation it resumed, not appear as an empty new session.
 */

import { performance } from 'node:perf_hooks';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type AgentEventEnvelope,
  type ObservationLevel,
  type SessionRuntimeState,
} from '@vibecook/chopsticks-core';
import { AppServerClient, type Transport } from './app-server-client.js';
import type { CodexApprovalDecision, CodexApprovalRequest } from './driver.js';
import { CodexNotificationNormalizer } from './normalizer.js';
import { readLastCodexContextWindow } from './rollout-context.js';

const CLIENT_INFO = { name: 'chopsticks-observer', version: '0.1.6' } as const; // x-release-please-version

/** Empty inject materializes a rollout without a model turn (probe 3). */
const MATERIALIZE_ITEMS = [{ type: 'text', text: '' }] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export interface CreateCodexObserverOptions {
  transport: Transport;
  /** Decide structured approval requests. Default: deny. */
  onApproval?: (req: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>;
  /** Choose which thread to attach to when several appear. Default: the first. */
  selectThread?: (threadId: string) => boolean;
  /**
   * Attach immediately to this existing thread (resume path) instead of waiting
   * for `thread/started`. The thread must already be materializable (has a
   * rollout) — real Codex resumes always do.
   */
  threadId?: string;
  /**
   * Create + materialize a fresh thread on this connection so the session is
   * ready before any TUI attaches. Mutually exclusive with {@link threadId}.
   */
  start?: {
    cwd: string;
    model?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  };
}

export interface CodexThreadInfo {
  threadId: string;
  path?: string;
}

export interface CodexObserver {
  /** The observed thread's id / spaghetti join key (undefined until one attaches). */
  readonly sessionId: string | undefined;
  state(): SessionRuntimeState;
  observationLevel(): ObservationLevel;
  threadPath(): string | undefined;
  onEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
  /** Fires once a thread is picked up and its live stream is open. */
  onThread(listener: (info: CodexThreadInfo) => void): () => void;
  /** Bind a thread discovered by a native TUI resume request. */
  attachThread(threadId: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function createCodexObserver(opts: CreateCodexObserverOptions): Promise<CodexObserver> {
  if (opts.threadId && opts.start) {
    throw new Error('createCodexObserver: pass threadId OR start, not both');
  }

  const client = new AppServerClient(opts.transport);
  const modelNames = new Map<string, string>();
  const normalizer = new CodexNotificationNormalizer((modelId) => modelNames.get(modelId));
  const stamper = createEnvelopeStamper();

  let state = createInitialSessionState();
  let sessionId: string | undefined;
  let threadPath: string | undefined;
  let currentTurnId: string | undefined;
  let attached = false;
  let attaching = false;
  let disposed = false;
  const observation: ObservationLevel = 'structured';
  const listeners = new Set<(e: AgentEventEnvelope) => void>();
  const threadListeners = new Set<(info: CodexThreadInfo) => void>();
  const pendingEvents: AgentEventEnvelope[] = [];
  const queuedLiveNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];

  function apply(event: AgentEvent, source: AgentEventEnvelope['source'], nativeEvent?: unknown, replay = false): void {
    const envelope = stamper.next({
      sessionId: sessionId ?? '',
      nativeSessionId: sessionId,
      turnId: currentTurnId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source,
      confidence: 'authoritative',
      event,
      nativeEvent,
      ...(replay ? { replay: true } : {}),
    });
    state = reduceSessionState(state, envelope);
    if (listeners.size === 0) pendingEvents.push(envelope);
    for (const l of listeners) {
      try {
        l(envelope);
      } catch {
        /* listener faults stay out of the pipeline */
      }
    }
  }

  function consumeNotification(method: string, params: Record<string, unknown>, replayed = false): void {
    const tid = str(params.threadId) ?? str(rec(params.thread)?.id);
    if (tid && tid !== sessionId) return;
    const norm = normalizer.normalize({ method, params });
    if (norm.turnId) currentTurnId = norm.turnId;
    for (const event of norm.events) {
      const source =
        event.type.startsWith('context-window.') || event.type === 'session.environment.updated'
          ? 'native-protocol'
          : 'native-hook';
      apply(event, source, replayed ? { method, params, replayed: true } : { method, params }, replayed);
    }
  }

  function notificationThreadId(params: Record<string, unknown>): string | undefined {
    return str(params.threadId) ?? str(rec(params.thread)?.id);
  }

  function notificationTurnId(params: Record<string, unknown>): string | undefined {
    return str(params.turnId) ?? str(rec(params.turn)?.id);
  }

  function isTurnStreamNotification(method: string): boolean {
    return method === 'turn/started' || method === 'turn/completed' || method.startsWith('item/');
  }

  function applyEnvironmentFromResponse(
    response: Record<string, unknown> | undefined,
    fallbackCwd?: string,
    fallbackModel?: string,
  ): void {
    const thread = rec(response?.thread);
    const currentCwd = str(response?.cwd) ?? str(thread?.cwd) ?? fallbackCwd;
    const modelId = str(response?.model) ?? fallbackModel;
    const provider = str(response?.modelProvider);
    if (!currentCwd && !modelId) return;
    apply(
      {
        type: 'session.environment.updated',
        ...(currentCwd ? { currentCwd } : {}),
        ...(modelId
          ? {
              model: {
                id: modelId,
                ...(modelNames.get(modelId) ? { displayName: modelNames.get(modelId) } : {}),
                ...(provider ? { provider } : {}),
              },
            }
          : {}),
      },
      'native-protocol',
      { response, bootstrap: 'thread-response' },
    );
  }

  function replayCompletedTurns(resumed: Record<string, unknown> | undefined): Set<string> {
    const replayedTurnIds = new Set<string>();
    const thread = rec(resumed?.thread);
    const legacyTurns = Array.isArray(thread?.turns) ? thread.turns : [];
    const page = rec(resumed?.initialTurnsPage);
    const paginatedTurns = Array.isArray(page?.data) ? page.data : [];
    const turns = paginatedTurns.length > 0 ? paginatedTurns : legacyTurns;
    for (const value of turns) {
      const turn = rec(value);
      const turnId = str(turn?.id);
      const status = str(turn?.status);
      if (!turn || !turnId || status === 'inProgress') continue;
      replayedTurnIds.add(turnId);
      consumeNotification('turn/started', { threadId: sessionId, turn }, true);
      for (const value of Array.isArray(turn.items) ? turn.items : []) {
        const item = rec(value);
        if (!item) continue;
        const params = { threadId: sessionId, turnId, item };
        consumeNotification('item/started', params, true);
        consumeNotification('item/completed', params, true);
      }
      consumeNotification('turn/completed', { threadId: sessionId, turn }, true);
    }
    return replayedTurnIds;
  }

  /**
   * Open the live stream for `threadId` via `thread/resume`, then mark ready.
   * Retries while the rollout is missing (passive mode: TUI's first turn is
   * still writing it). Controller-owned mode materializes first so this is a
   * single success.
   */
  async function attach(threadId: string, thread: Record<string, unknown> | undefined): Promise<void> {
    if (attached || attaching) return;
    attaching = true;
    sessionId = threadId;
    threadPath = str(thread?.path) ?? threadPath;
    if (thread) applyEnvironmentFromResponse({ thread });
    // A thread isn't materializable until it has a rollout. Passive-created threads
    // only write one on the first user message; controller-owned threads write
    // one via empty inject_items before calling attach. Retry until it takes,
    // the connection drops, or we're disposed — a bounded one-shot was the
    // "stuck at preparing, no messages" bug when a slow first turn missed it.
    let delay = 200;
    while (!attached && !disposed) {
      try {
        const resumed = rec(await client.request('thread/resume', { threadId })); // opens the live stream
        threadPath = str(rec(resumed?.thread)?.path) ?? threadPath;
        let history = resumed;
        applyEnvironmentFromResponse(resumed);
        try {
          history = rec(await client.request('thread/read', { threadId, includeTurns: true })) ?? resumed;
          threadPath = str(rec(history?.thread)?.path) ?? threadPath;
        } catch {
          // History enrichment must never prevent live resume attachment.
        }
        apply({ type: 'session.started', nativeSessionId: threadId }, 'native-hook');
        const replayedTurnIds = replayCompletedTurns(history);

        // thread/resume opens the live stream before thread/read resolves. Keep
        // live traffic behind this replay barrier so the stateful normalizer
        // always sees old turns first. If thread/read already contains a turn
        // that completed while it was in flight, discard that turn's queued
        // protocol notifications rather than reducing it twice.
        attached = true;
        attaching = false;
        for (const notification of queuedLiveNotifications.splice(0)) {
          const turnId = notificationTurnId(notification.params);
          if (turnId && replayedTurnIds.has(turnId) && isTurnStreamNotification(notification.method)) continue;
          consumeNotification(notification.method, notification.params);
        }
      } catch {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(Math.floor(delay * 1.5), 2000);
      }
    }
    if (!attached) {
      attaching = false; // disposed before the thread ever materialized
      return;
    }
    if (threadPath && !state.contextWindow) {
      const contextWindow = await readLastCodexContextWindow(threadPath);
      if (contextWindow && !state.contextWindow) {
        apply(contextWindow, 'native-log', { path: threadPath, bootstrap: 'rollout-token-count' });
      }
    }
    for (const l of threadListeners) l({ threadId, path: threadPath });
  }

  client.onNotification((method, params) => {
    if (!attached) {
      const notificationParams = params ?? {};
      if (
        attaching &&
        (!notificationThreadId(notificationParams) || notificationThreadId(notificationParams) === sessionId)
      ) {
        queuedLiveNotifications.push({ method, params: notificationParams });
        return;
      }
      // Passive mode only: wait for another client (the TUI) to create a thread.
      // Controller-owned start/resume never relies on this path.
      if (!opts.threadId && !opts.start && method === 'thread/started') {
        const thread = rec(params?.thread);
        const tid = str(thread?.id);
        if (tid && (!opts.selectThread || opts.selectThread(tid))) void attach(tid, thread);
      }
      return; // ignore everything until we've attached to a thread
    }
    // Only our thread's notifications drive state (avoid cross-thread bleed).
    consumeNotification(method, params ?? {});
  });

  client.onServerRequest(async (method, params, id) => {
    const requestId = String(id);
    apply(
      { type: 'permission.requested', requestId, tool: method, input: params, presentation: 'host-ui' },
      'native-hook',
      { method, params, id },
    );
    const decision = opts.onApproval ? await opts.onApproval({ method, params, requestId: id }) : 'denied';
    apply(
      { type: 'permission.resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
      'native-hook',
      { method, params, id },
    );
    return { decision };
  });

  client.onClose(() => {
    disposed = true; // let any in-flight attach retry loop exit
    if (attached) apply({ type: 'process.exited', reason: 'signal' }, 'runtime');
  });

  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
  client.notify('initialized');
  try {
    const catalog = rec(await client.request('model/list', {}));
    const models = Array.isArray(catalog?.data) ? catalog.data : Array.isArray(catalog?.models) ? catalog.models : [];
    for (const value of models) {
      const model = rec(value);
      const displayName = str(model?.displayName);
      if (!displayName) continue;
      const id = str(model?.id);
      const wireModel = str(model?.model);
      if (id) modelNames.set(id, displayName);
      if (wireModel) modelNames.set(wireModel, displayName);
    }
  } catch {
    // A missing/older model-list method must not prevent session attachment.
  }

  // Controller-owned bootstrap: create + materialize, or resume a known id,
  // before returning so callers can spawn `codex resume <id> --remote` with a
  // ready join key and the panel can leave `preparing` immediately.
  if (opts.start) {
    const startResult = await client.request('thread/start', {
      cwd: opts.start.cwd,
      model: opts.start.model,
      sandbox: opts.start.sandbox ?? 'workspace-write',
      approvalPolicy: opts.start.approvalPolicy ?? 'on-request',
    });
    const thread = rec(rec(startResult)?.thread);
    const tid = str(thread?.id) ?? str(thread?.sessionId);
    if (!tid) {
      client.close();
      throw new Error('codex thread/start returned no thread id');
    }
    threadPath = str(thread?.path);
    // Empty text item materializes the rollout without a model turn (probe 3).
    // Without this, thread/resume and `codex resume --remote` fail with
    // "no rollout found" until the user types.
    await client.request('thread/inject_items', { threadId: tid, items: [...MATERIALIZE_ITEMS] });
    await attach(tid, thread);
    if (!attached) {
      client.close();
      throw new Error(`codex observer failed to attach to owned thread ${tid}`);
    }
    applyEnvironmentFromResponse(rec(startResult), opts.start.cwd, opts.start.model);
  } else if (opts.threadId) {
    await attach(opts.threadId, undefined);
    if (!attached) {
      client.close();
      throw new Error(`codex observer failed to attach to thread ${opts.threadId}`);
    }
  }

  return {
    get sessionId() {
      return sessionId;
    },
    state: () => state,
    observationLevel: () => observation,
    threadPath: () => threadPath,
    onEvent(listener) {
      listeners.add(listener);
      for (const envelope of pendingEvents.splice(0)) {
        try {
          listener(envelope);
        } catch {
          // Listener faults stay out of buffered-history delivery too.
        }
      }
      return () => listeners.delete(listener);
    },
    onThread(listener) {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    attachThread: (threadId) => attach(threadId, undefined),
    async dispose() {
      disposed = true; // stop the attach retry loop if it is still running
      client.close();
    },
  };
}
