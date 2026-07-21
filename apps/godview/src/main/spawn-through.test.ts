import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { matchingTerminalSession, prepareSpawnThroughLaunch } from './spawn-through.js';

const shellSession = {
  id: 'terminal-1',
  handle: '1',
  executable: '/bin/zsh',
  cols: 100,
  rows: 30,
  exited: false,
  readWrite: true,
  title: null,
  cwd: '/repo',
  bellCount: 0,
  pid: 123,
  createdAtMs: 1,
  exitCode: null,
  exitSignal: null,
  requestedTermination: null,
  exitOutcome: null,
  ownerId: null,
} satisfies SessionSummary;

describe('Godview spawn-through', () => {
  it('matches a direct shell child and the shell-exec optimization', () => {
    expect(matchingTerminalSession([shellSession], { pid: 456, parentPid: 123 })?.id).toBe('terminal-1');
    expect(matchingTerminalSession([shellSession], { pid: 123, parentPid: 9 })?.id).toBe('terminal-1');
  });

  it('prepares and adopts the existing terminal before returning the authoritative recipe', async () => {
    const prepareSession = vi.fn().mockResolvedValue({
      preparationId: 'preparation-1',
      agent: 'codex',
      sessionId: 'thread-1',
      launch: { command: '/real/codex', args: ['resume', 'thread-1'], cwd: '/repo' },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const adoptPrepared = vi.fn().mockResolvedValue({
      preparationId: 'preparation-1',
      agent: 'codex',
      sessionId: 'thread-1',
      runtimeSessionId: 'terminal-1',
      processId: 456,
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
    });
    const onAdopted = vi.fn();
    const result = await prepareSpawnThroughLaunch(
      { type: 'launch', token: 'secret', agent: 'codex', cwd: '/repo', argv: [], pid: 456, parentPid: 123 },
      {
        runtime: { prepareSession, adoptPrepared, cancelPrepared: vi.fn() } as never,
        listSessions: async () => [shellSession],
        onAdopted,
      },
    );

    expect(prepareSession).toHaveBeenCalledWith({ agent: 'codex', cwd: '/repo' });
    expect(adoptPrepared).toHaveBeenCalledWith('preparation-1', {
      runtimeSessionId: 'terminal-1',
      processId: 456,
    });
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(result).toEqual({
      action: 'exec',
      preparationId: 'preparation-1',
      launch: { command: '/real/codex', args: ['resume', 'thread-1'], cwd: '/repo' },
    });
  });

  it('falls through untouched when the user supplies arguments', async () => {
    const prepareSession = vi.fn();
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'codex',
        cwd: '/repo',
        argv: ['--help'],
        pid: 456,
        parentPid: 123,
      },
      {
        runtime: { prepareSession } as never,
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    expect(result).toEqual({ action: 'fallback', reason: 'custom arguments are not spawn-through compatible' });
    expect(prepareSession).not.toHaveBeenCalled();
  });
});
