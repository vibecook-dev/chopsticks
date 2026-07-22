import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, type AgentHost } from '@vibecook/chopsticks-core';

const fakes = vi.hoisted(() => ({
  createObserver: vi.fn(),
  observerDispose: vi.fn(),
  serverDispose: vi.fn(),
  serverReady: vi.fn(),
  spawnServer: vi.fn(),
  transport: {},
  tapReady: vi.fn(),
  tapDispose: vi.fn(),
  tapClientMessage: undefined as ((message: unknown) => void) | undefined,
}));

vi.mock('./observer.js', () => ({
  createCodexObserver: fakes.createObserver,
}));

vi.mock('./ws-transport.js', () => ({
  spawnAppServer: fakes.spawnServer,
  wsOverUnixTransport: vi.fn(() => fakes.transport),
  createUnixWebSocketTapProxy: vi.fn((_upstream: string, onClientMessage: (message: unknown) => void) => {
    fakes.tapClientMessage = onClientMessage;
    return { socketPath: '/tmp/codex-tap.sock', ready: fakes.tapReady, dispose: fakes.tapDispose };
  }),
}));

import { createCodexTuiSession, prepareCodexTuiSession } from './tui-session.js';

function host(): AgentHost {
  return {
    spawnTerminal: vi.fn(async () => ({ runtimeSessionId: 'spawned-pane' })),
    automateTerminal: vi.fn(async () => ({ accepted: true as const })),
  };
}

describe('Codex TUI preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.serverReady.mockResolvedValue(undefined);
    fakes.tapReady.mockResolvedValue(undefined);
    fakes.observerDispose.mockResolvedValue(undefined);
    fakes.spawnServer.mockReturnValue({
      socketPath: '/tmp/codex.sock',
      ready: fakes.serverReady,
      dispose: fakes.serverDispose,
    });
    fakes.createObserver.mockResolvedValue({
      sessionId: 'thread-1',
      state: createInitialSessionState,
      observationLevel: () => 'structured',
      threadPath: () => '/tmp/thread.jsonl',
      onEvent: () => () => undefined,
      attachThread: vi.fn(),
      dispose: fakes.observerDispose,
    });
  });

  it('owns the thread before launch and adopts one existing terminal idempotently', async () => {
    const terminalHost = host();
    const onApproval = vi.fn(() => 'approved' as const);
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: terminalHost,
      model: 'gpt-test',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      onApproval,
    });

    expect(terminalHost.spawnTerminal).not.toHaveBeenCalled();
    expect(prepared.sessionId).toBe('thread-1');
    expect(prepared.launch).toEqual({
      command: '/opt/codex',
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex.sock'],
      cwd: '/work/repo',
    });
    expect(fakes.createObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        start: expect.objectContaining({ model: 'gpt-test', sandbox: 'read-only', approvalPolicy: 'never' }),
        onApproval,
      }),
    );

    const first = await prepared.adopt('existing-pane');
    expect(first.runtimeSessionId).toBe('existing-pane');
    expect(await prepared.adopt('existing-pane')).toBe(first);
    await expect(prepared.adopt('other-pane')).rejects.toThrow('already adopted');

    await first.submitPrompt({ text: 'hello' });
    expect(terminalHost.automateTerminal).toHaveBeenCalledWith('existing-pane', {
      kind: 'paste',
      text: 'hello',
      submit: true,
    });
    await prepared.dispose();
    expect(fakes.observerDispose).toHaveBeenCalledOnce();
    expect(fakes.serverDispose).toHaveBeenCalledOnce();
  });

  it('preserves the managed createSession spawn path through the same preparation', async () => {
    const terminalHost = host();
    const session = await createCodexTuiSession({ cwd: '/work/repo', host: terminalHost });

    expect(terminalHost.spawnTerminal).toHaveBeenCalledWith({
      command: 'codex',
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex.sock'],
      cwd: '/work/repo',
    });
    expect(session.runtimeSessionId).toBe('spawned-pane');
    await session.dispose();
  });

  it('preserves the native resume picker and binds its selected thread lazily', async () => {
    let selectedThread: string | undefined;
    const attachThread = vi.fn(async (threadId: string) => {
      selectedThread = threadId;
    });
    fakes.createObserver.mockResolvedValue({
      get sessionId() {
        return selectedThread;
      },
      state: createInitialSessionState,
      observationLevel: () => 'structured',
      threadPath: () => undefined,
      onEvent: () => () => undefined,
      attachThread,
      dispose: fakes.observerDispose,
    });
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: host(),
      resumeInvocation: ['resume'],
    });

    expect(prepared.sessionId).toMatch(/^codex-pending-/);
    expect(prepared.launch.args).toEqual(['resume', '--remote', 'unix:///tmp/codex-tap.sock']);
    expect(fakes.createObserver).toHaveBeenCalledWith(
      expect.not.objectContaining({ start: expect.anything(), threadId: expect.anything() }),
    );
    const session = await prepared.adopt('existing-pane');
    expect(session.sessionId).toBe(prepared.sessionId);
    fakes.tapClientMessage?.({ method: 'thread/resume', params: { threadId: 'thread-selected-in-picker' } });
    await vi.waitFor(() => expect(attachThread).toHaveBeenCalledWith('thread-selected-in-picker'));
    expect(session.sessionId).toBe('thread-selected-in-picker');
    await session.dispose();
    expect(fakes.tapDispose).toHaveBeenCalledOnce();
  });
});
