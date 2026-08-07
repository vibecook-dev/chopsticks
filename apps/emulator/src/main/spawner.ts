/**
 * Center-owned spawn capability (draft/EMULATOR.md §6): the control center
 * creates emulated sessions through the REAL adapter — full driver, reducer
 * state, hook bridge — with the emulator bin as the spawned process. This is
 * what lets the console spawn-and-drive agents with no product app running.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClaudeSession, type ClaudeSession } from '@vibecook/chopsticks-adapter-claude';
import type { EmulatorSpawner } from '@vibecook/chopsticks-emulator/control';

export interface ClaudeSpawnerOptions {
  /** Test override for the control state file the bin registers against. */
  controlStateFile?: string;
}

export function createClaudeSpawner(options: ClaudeSpawnerOptions = {}): EmulatorSpawner & {
  disposeAll(): Promise<void>;
} {
  const require = createRequire(import.meta.url);
  const adapterPackage = require.resolve('@vibecook/chopsticks-adapter-claude/package.json');
  const bin = join(dirname(adapterPackage), 'surface', 'emulator', 'bin.mjs');

  const sessions = new Map<string, ClaudeSession>();
  const children = new Map<string, ChildProcess>();
  const workingDirectories = new Map<string, string>();

  const removeWorkingDirectory = (sessionId: string): void => {
    const cwd = workingDirectories.get(sessionId);
    workingDirectories.delete(sessionId);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  };

  return {
    vendor: 'claude',
    label: 'Claude (emulated)',
    async spawn() {
      const cwd = mkdtempSync(join(tmpdir(), 'chopsticks-emulator-spawn-'));
      const runtimeSessionId = `console-${randomUUID()}`;
      let child: ChildProcess | undefined;
      try {
        const session = await createClaudeSession({
          cwd,
          title: 'emulator-console',
          executable: bin,
          ports: {
            spawn: async (prepared) => {
              // The recipe is self-contained (prepare wraps script executables
              // with node), so spawn it exactly as built.
              child = spawn(prepared.command, prepared.args, {
                cwd: prepared.cwd,
                env: {
                  ...process.env,
                  ...prepared.env,
                  ...(options.controlStateFile ? { CHOPSTICKS_EMULATOR_CONTROL_STATE: options.controlStateFile } : {}),
                },
                stdio: ['pipe', 'ignore', 'inherit'],
              });
              await new Promise<void>((resolve, reject) => {
                child!.once('spawn', resolve);
                child!.once('error', reject);
              });
              // A process can close between the writable check in `automate`
              // and the actual write; do not let the resulting EPIPE become an
              // unhandled stream error in the control-center process.
              child.stdin?.on('error', () => undefined);
              return { runtimeSessionId };
            },
            automate: async (_id, operation) => {
              if (!child?.stdin?.writable) return { accepted: false, reason: 'emulator process is not writable' };
              if (operation.kind === 'paste') {
                child.stdin.write(`\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`);
              } else if (operation.kind === 'text') {
                child.stdin.write(operation.text);
              } else {
                child.stdin.write('\x03');
              }
              return { accepted: true };
            },
          },
        });
        sessions.set(session.sessionId, session);
        children.set(session.sessionId, child!);
        workingDirectories.set(session.sessionId, cwd);
        child!.once('exit', () => {
          children.delete(session.sessionId);
          const tracked = sessions.get(session.sessionId);
          sessions.delete(session.sessionId);
          removeWorkingDirectory(session.sessionId);
          void tracked?.dispose().catch(() => undefined);
        });
        return { sessionId: session.sessionId };
      } catch (error) {
        child?.kill('SIGKILL');
        rmSync(cwd, { recursive: true, force: true });
        throw error;
      }
    },
    sessionState(sessionId) {
      const session = sessions.get(sessionId);
      return session ? session.state() : undefined;
    },
    async disposeAll() {
      const activeSessions = [...sessions.entries()];
      const activeChildren = [...children.values()];
      children.clear();
      sessions.clear();
      for (const child of activeChildren) child.kill('SIGKILL');
      await Promise.all(activeSessions.map(([, session]) => session.dispose().catch(() => undefined)));
      for (const [sessionId] of activeSessions) removeWorkingDirectory(sessionId);
    },
  };
}
