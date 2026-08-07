/**
 * Control-channel integration test (draft/EMULATOR.md §6, P3): a real
 * emulator bin spawned by the real driver registers with a control plane, and
 * the plane's trigger endpoint drives events through the full chain —
 * center → bin → hook bridge → normalizer → reducer — with no claude binary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { createControlPlane, type ControlPlane } from '@vibecook/chopsticks-emulator/control';
import { createClaudeSession, type ClaudeSession } from './driver.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const BIN = join(here, '..', 'surface', 'emulator', 'bin.mjs');

let plane: ControlPlane;
let child: ChildProcess | undefined;
let session: ClaudeSession | undefined;
const tmps: string[] = [];

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chopsticks-control-it-'));
  tmps.push(dir);
  plane = createControlPlane({ stateFile: join(dir, 'emulator-control.json') });
  await plane.start();
});

afterEach(async () => {
  await session?.dispose();
  child?.kill('SIGKILL');
  await plane.stop();
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const planeApi = (path: string, body?: unknown) =>
  fetch(`${plane.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${plane.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('emulator control channel', () => {
  it('registers, accepts a trigger through the full chain, and prunes on death', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'chopsticks-emulator-cwd-'));
    const emulatorHome = mkdtempSync(join(tmpdir(), 'chopsticks-emulator-home-'));
    tmps.push(cwd, emulatorHome);

    session = await createClaudeSession({
      cwd,
      title: 'control-channel',
      executable: BIN,
      ports: {
        spawn: async (prepared) => {
          child = spawn(prepared.command, prepared.args, {
            cwd: prepared.cwd,
            env: {
              ...process.env,
              ...prepared.env,
              CHOPSTICKS_EMULATOR_CLAUDE_HOME: emulatorHome,
              CHOPSTICKS_EMULATOR_CONTROL_STATE: plane.stateFile,
            },
            stdio: ['pipe', 'pipe', 'inherit'],
          });
          return { runtimeSessionId: 'rt-control-channel' };
        },
        automate: async () => ({ accepted: true }),
      },
    });
    await waitFor(() => session!.state().lifecycle === 'ready', 'emulator boot');

    // Registered with the plane, with the model palette.
    let sessions: Array<Record<string, unknown>> = [];
    await waitFor(async () => {
      sessions = ((await (await planeApi('/api/sessions')).json()) as { sessions: Array<Record<string, unknown>> })
        .sessions;
      return sessions.length === 1;
    }, 'emulator registration');
    expect(sessions[0]).toMatchObject({ vendor: 'claude', sessionId: session.sessionId });
    expect((sessions[0]!.palette as unknown[]).length).toBeGreaterThan(0);

    // Trigger fires through center → bin → bridge → reducer.
    const notification = new Promise<AgentEventEnvelope>((resolve) => {
      const off = session!.onEvent((envelope) => {
        if (envelope.event.type === 'notification') {
          off();
          resolve(envelope);
        }
      });
    });
    const trigger = await planeApi(`/api/sessions/${session.sessionId}/trigger`, {
      event: 'Notification',
      with: { message: 'hello from the control center', notification_type: 'emulator', prompt_id: crypto.randomUUID() },
    });
    expect(trigger.status).toBe(200);
    const envelope = await notification;
    expect(envelope.event.type === 'notification' && envelope.event.message).toBe('hello from the control center');

    // The emitted log is visible through the plane.
    const log = (await (await planeApi(`/api/sessions/${session.sessionId}/log`)).json()) as {
      entries: Array<{ event: string }>;
    };
    expect(log.entries.map((entry) => entry.event)).toContain('SessionStart');
    expect(log.entries.map((entry) => entry.event)).toContain('Notification');

    // Death prunes the registration.
    child!.kill('SIGKILL');
    await waitFor(async () => {
      const remaining = ((await (await planeApi('/api/sessions')).json()) as { sessions: unknown[] }).sessions;
      return remaining.length === 0;
    }, 'registration prune');
  });
});
