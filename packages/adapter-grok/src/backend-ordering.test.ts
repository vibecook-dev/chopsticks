import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSessionState, type AgentHost, type AgentSession } from '@vibecook/chopsticks-core';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createAcpSession: vi.fn(),
  createStdioAcpConnector: vi.fn(() => ({ connector: 'fake' })),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).endsWith('leader.sock') || actual.existsSync(path),
  };
});
vi.mock('@vibecook/chopsticks-adapter-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vibecook/chopsticks-adapter-acp')>()),
  createAcpSession: mocks.createAcpSession,
  createStdioAcpConnector: mocks.createStdioAcpConnector,
}));

import { createGrokBackend } from './backend.js';

function controlSession(sessionId: string): AgentSession {
  return {
    sessionId,
    runtimeSessionId: `control-${sessionId}`,
    state: () => ({ ...createInitialSessionState(), lifecycle: 'ready' }),
    observationLevel: () => 'structured',
    onEvent: () => () => undefined,
    submitPrompt: async () => ({ status: 'confirmed', turnId: 'turn-1' }),
    dispose: vi.fn(async () => undefined),
  };
}

function host(): AgentHost & { spawnTerminal: ReturnType<typeof vi.fn> } {
  return {
    spawnTerminal: vi.fn(async () => ({ runtimeSessionId: 'terminal-1' })),
    automateTerminal: vi.fn(async () => ({ accepted: true as const })),
  };
}

describe('Grok leader session materialization ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockReturnValue({ exitCode: null, killed: false, kill: vi.fn() });
    mocks.createAcpSession.mockImplementation(async (options: { resume?: string }) =>
      controlSession(options.resume ?? 'materialized-session'),
    );
  });

  it('materializes a fresh ACP session before returning a TUI recipe that resumes it', async () => {
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    const prepared = await backend.prepareSession({ cwd: '/repo' });

    expect(mocks.createAcpSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo' }));
    expect(mocks.createAcpSession.mock.calls[0]![0]).not.toHaveProperty('resume');
    expect(prepared.sessionId).toBe('materialized-session');
    expect(prepared.launch).toEqual({
      command: '/real/grok',
      args: expect.arrayContaining(['--resume', 'materialized-session']),
      cwd: '/repo',
    });
    expect(prepared.launch.args).not.toContain('--session-id');

    const adopted = await prepared.adopt('terminal-1');
    await vi.waitFor(() => expect(adopted.state().lifecycle).toBe('ready'));
    await prepared.dispose();
    backend.dispose();
  });

  it('opens structured control before the managed host spawns the TUI', async () => {
    const terminalHost = host();
    const backend = createGrokBackend({ executable: '/real/grok', host: terminalHost });
    const session = await backend.createSession({ cwd: '/repo' });

    expect(mocks.createAcpSession.mock.invocationCallOrder[0]).toBeLessThan(
      terminalHost.spawnTerminal.mock.invocationCallOrder[0]!,
    );
    expect(terminalHost.spawnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['--resume', 'materialized-session']) }),
    );
    await vi.waitFor(() => expect(session.state().lifecycle).toBe('ready'));
    await session.dispose();
    backend.dispose();
  });

  it('loads an explicit resume id before launching the matching TUI', async () => {
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    const prepared = await backend.prepareSession({ cwd: '/repo', resume: 'existing-session' });

    expect(mocks.createAcpSession).toHaveBeenCalledWith(expect.objectContaining({ resume: 'existing-session' }));
    expect(prepared.sessionId).toBe('existing-session');
    expect(prepared.launch.args).toEqual(expect.arrayContaining(['--resume', 'existing-session']));
    await prepared.dispose();
    backend.dispose();
  });
});
