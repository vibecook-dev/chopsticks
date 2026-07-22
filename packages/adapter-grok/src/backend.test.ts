import { describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, type AgentEventEnvelope, type AgentSession } from '@vibecook/chopsticks-core';
import { buildGrokTuiArgs, createPendingControlSession, createPreparedGrokSession } from './backend.js';
import type { GrokObservedEvent, GrokSessionObserver } from './session-observer.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeControl() {
  const listeners = new Set<(event: AgentEventEnvelope) => void>();
  let disposed = false;
  const session: AgentSession = {
    sessionId: 'ctl',
    runtimeSessionId: 'ctl-rt',
    state: () => ({ ...createInitialSessionState(), lifecycle: 'ready' }),
    observationLevel: () => 'structured',
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submitPrompt: async () => ({ status: 'confirmed', turnId: 't1' }),
    dispose: async () => {
      disposed = true;
    },
  };
  return {
    session,
    emit: (event: AgentEventEnvelope) => listeners.forEach((listener) => listener(event)),
    get disposed() {
      return disposed;
    },
  };
}

const ENVELOPE: AgentEventEnvelope = {
  sequence: 1,
  sessionId: 'sid',
  timestamp: '2026-07-14T00:00:00.000Z',
  monotonicTime: 0,
  source: 'native-hook',
  confidence: 'authoritative',
  event: { type: 'session.ready' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeObserver() {
  const listeners = new Set<(event: GrokObservedEvent) => void>();
  let stopped = false;
  const observer: GrokSessionObserver = {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onError: () => () => undefined,
    poll: async () => undefined,
    stop: () => {
      stopped = true;
    },
  };
  return {
    observer,
    emit: (event: GrokObservedEvent) => listeners.forEach((listener) => listener(event)),
    get stopped() {
      return stopped;
    },
  };
}

describe('createPendingControlSession', () => {
  it('exposes id + terminal immediately and initial state before attach', () => {
    const session = createPendingControlSession('sid', 'rt', () => new Promise<AgentSession>(() => {}));
    expect(session.sessionId).toBe('sid');
    expect(session.runtimeSessionId).toBe('rt');
    expect(session.observationLevel()).toBe('structured');
    expect(session.state().lifecycle).toBe('preparing');
  });

  it('forwards buffered listeners once control attaches', async () => {
    const control = fakeControl();
    const pending = deferred<AgentSession>();
    const session = createPendingControlSession('sid', 'rt', () => pending.promise);
    const received: AgentEventEnvelope[] = [];
    session.onEvent((event) => received.push(event));

    control.emit(ENVELOPE);
    expect(received).toHaveLength(0);
    pending.resolve(control.session);
    await tick();
    control.emit(ENVELOPE);

    expect(received).toHaveLength(2);
    expect(received.map(({ event }) => event.type)).toEqual(['session.ready', 'session.ready']);
    expect(session.state().lifecycle).toBe('ready');
  });

  it('waits for attach before delegating prompt submission', async () => {
    const control = fakeControl();
    const pending = deferred<AgentSession>();
    const session = createPendingControlSession('sid', 'rt', () => pending.promise);

    const receiptPending = session.submitPrompt({ text: 'hi' });
    pending.resolve(control.session);
    await expect(receiptPending).resolves.toEqual({ status: 'confirmed', turnId: 't1' });
  });

  it('rejects prompt submission when control does not attach', async () => {
    const session = createPendingControlSession('sid', 'rt', () => Promise.reject(new Error('nope')));
    await expect(session.submitPrompt({ text: 'hi' })).resolves.toMatchObject({ status: 'rejected' });
    expect(session.state()).toMatchObject({
      lifecycle: 'failed',
      diagnostics: [expect.objectContaining({ code: 'grok-control-attach-failed', message: 'nope' })],
    });
  });

  it('disposes a control client that arrives after the TUI session closed', async () => {
    const control = fakeControl();
    const pending = deferred<AgentSession>();
    const session = createPendingControlSession('sid', 'rt', () => pending.promise);

    await session.dispose();
    pending.resolve(control.session);
    await tick();
    expect(control.disposed).toBe(true);
  });

  it('disposes an attached control client', async () => {
    const control = fakeControl();
    const session = createPendingControlSession('sid', 'rt', () => Promise.resolve(control.session));
    await tick();
    await session.dispose();
    expect(control.disposed).toBe(true);
  });

  it('is ready synchronously for a materialized control and uses the Grok log for lifecycle', async () => {
    const control = fakeControl();
    const observed = fakeObserver();
    const session = createPendingControlSession('sid', 'rt', () => control.session, observed.observer);
    const envelopes: AgentEventEnvelope[] = [];
    session.onEvent((event) => envelopes.push(event));

    expect(session.state().lifecycle).toBe('ready');
    expect(session.observationLevel()).toBe('native-log');
    observed.emit({
      event: { type: 'turn.started', turnId: 'prompt-1', prompt: 'hello' },
      promptId: 'prompt-1',
      nativeEvent: {},
    });
    observed.emit({
      event: { type: 'turn.completed', turnId: 'prompt-1', lastAssistantMessage: 'hi' },
      promptId: 'prompt-1',
      nativeEvent: {},
    });

    expect(envelopes.map(({ event }) => event.type)).toEqual(['turn.started', 'turn.completed']);
    expect(session.state()).toMatchObject({ lifecycle: 'ready', activeTurn: undefined, lastAssistantMessage: 'hi' });
    await session.dispose();
    expect(observed.stopped).toBe(true);
  });

  it('prefers standard ACP context usage over the native signals fallback', async () => {
    const control = fakeControl();
    const observed = fakeObserver();
    const session = createPendingControlSession('sid', 'rt', () => control.session, observed.observer);

    observed.emit({
      event: { type: 'context-window.updated', usedTokens: 10, capacityTokens: 100, modelId: 'fallback' },
      source: 'native-log',
      confidence: 'authoritative',
      nativeEvent: {},
    });
    control.emit({
      ...ENVELOPE,
      source: 'native-protocol',
      event: { type: 'context-window.updated', usedTokens: 40, capacityTokens: 100, modelId: 'protocol' },
    });
    observed.emit({
      event: { type: 'context-window.updated', usedTokens: 50, capacityTokens: 100, modelId: 'fallback' },
      source: 'native-log',
      confidence: 'authoritative',
      nativeEvent: {},
    });

    expect(session.state().contextWindow).toMatchObject({
      usedTokens: 40,
      capacityTokens: 100,
      modelId: 'protocol',
      source: 'native-protocol',
    });
    await session.dispose();
  });
});

describe('buildGrokTuiArgs', () => {
  it('forwards model and safety posture to a fresh native TUI session', () => {
    expect(
      buildGrokTuiArgs('/tmp/grok.sock', 'session-1', {
        model: 'grok-code-fast',
        permissionMode: 'plan',
        sandbox: 'workspace-write',
      }),
    ).toEqual([
      '--model',
      'grok-code-fast',
      '--permission-mode',
      'plan',
      '--sandbox',
      'workspace-write',
      '--leader',
      '--leader-socket',
      '/tmp/grok.sock',
      '--session-id',
      'session-1',
    ]);
  });

  it('preserves the resume recipe when launch options are absent', () => {
    expect(buildGrokTuiArgs('/tmp/grok.sock', 'session-1', { resume: 'session-1' })).toEqual([
      '--leader',
      '--leader-socket',
      '/tmp/grok.sock',
      '--resume',
      'session-1',
    ]);
  });
});

describe('Grok TUI preparation', () => {
  it('binds the leader recipe to one existing terminal and attaches control once', async () => {
    const control = fakeControl();
    const attach = async () => control.session;
    const prepared = createPreparedGrokSession(
      'grok-session',
      { command: '/opt/grok', args: ['--leader'], cwd: '/work/repo' },
      attach,
    );

    expect(prepared.launch).toEqual({ command: '/opt/grok', args: ['--leader'], cwd: '/work/repo' });
    const first = await prepared.adopt('existing-pane');
    expect(first.runtimeSessionId).toBe('existing-pane');
    expect(await prepared.adopt('existing-pane')).toBe(first);
    await expect(prepared.adopt('other-pane')).rejects.toThrow('already adopted');

    await tick();
    await prepared.dispose();
    expect(control.disposed).toBe(true);
  });

  it('cleans up a materialized control session when preparation is never adopted', async () => {
    const disposeUnadopted = vi.fn();
    const prepared = createPreparedGrokSession(
      'grok-session',
      { command: '/opt/grok', args: ['--resume', 'grok-session'], cwd: '/work/repo' },
      () => new Promise<AgentSession>(() => undefined),
      disposeUnadopted,
    );

    await prepared.dispose();
    await prepared.dispose();
    expect(disposeUnadopted).toHaveBeenCalledOnce();
  });
});
