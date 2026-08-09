/**
 * The §6.4 flow, over one socket (draft/EMULATOR.md §6.4, IMPOSTER.md §5).
 *
 * A real driver spawns `ai`, the imposter dials the plane, and a trigger issued
 * at the plane's HTTP edge travels console → socket → imposter → hook bridge →
 * normalizer → reducer with no claude binary anywhere. This lived in
 * `adapter-claude` while the stand-in was a per-adapter bin; the plane is the
 * thing under test, so it lives with the plane now.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { createClaudeSession, type ClaudeSession } from '@vibecook/chopsticks-adapter-claude';
import { createControlPlane, type ControlPlane } from './plane.js';
import { imposterBin } from './spawner.js';
import { controlPaths, waitFor } from './testing.js';

let plane: ControlPlane;
let child: ChildProcess | undefined;
let session: ClaudeSession | undefined;
const tmps: string[] = [];

beforeEach(async () => {
  const paths = controlPaths();
  tmps.push(paths.root);
  plane = createControlPlane({ socketPath: paths.socketPath, tokenPath: paths.tokenPath });
  await plane.start();
});

afterEach(async () => {
  await session?.dispose();
  session = undefined;
  child?.kill('SIGKILL');
  child = undefined;
  await plane.stop();
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const planeApi = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${plane.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${plane.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function spawnImposterSession(): Promise<ClaudeSession> {
  const cwd = mkdtempSync(join(tmpdir(), 'chopsticks-cc-cwd-'));
  const imposterHome = mkdtempSync(join(tmpdir(), 'chopsticks-cc-home-'));
  tmps.push(cwd, imposterHome);
  return createClaudeSession({
    cwd,
    title: 'control-channel',
    executable: imposterBin(),
    ports: {
      spawn: async (prepared) => {
        child = spawn(prepared.command, prepared.args, {
          cwd: prepared.cwd,
          env: {
            ...process.env,
            ...prepared.env,
            AI_PERSONA: 'claude',
            CHOPSTICKS_IMPOSTER_HOME: imposterHome,
            CHOPSTICKS_IMPOSTER_SOCKET: plane.socketPath,
            CHOPSTICKS_IMPOSTER_TOKEN_FILE: plane.tokenPath,
          },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        return { runtimeSessionId: 'rt-control-channel' };
      },
      automate: async () => ({ accepted: true }),
    },
  });
}

/**
 * SKIPPED ON WINDOWS, and the gap is real rather than cosmetic.
 *
 * These are the only tests that spawn `ai` and wait for it to dial back into
 * the control plane, and on Windows that join never happens: the wait expired
 * identically at 5 s and at 15 s across four CI rounds, so it is not slowness.
 * The plane takes a named pipe there instead of a socket path
 * (`control/protocol.ts`), and nobody has ever watched that path work.
 *
 * Skipping states the truth — the emulator's control channel is UNVERIFIED on
 * Windows — where pretending otherwise, or deleting the Windows job to make the
 * red go away, would hide it. `plane.test.ts` still runs there and covers the
 * plane's own HTTP and socket surface in-process; what is not covered is a
 * spawned imposter finding it. Tracked in draft/IMPOSTER.md §11.4.
 */
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('emulator control channel', () => {
  it('joins, accepts a trigger through the full chain, and leaves when killed', async () => {
    session = await spawnImposterSession();
    await waitFor(() => session!.state().lifecycle === 'ready', 'imposter boot');

    // Joined over the socket, carrying the palette generated from its ASM.
    await waitFor(() => plane.sessions.length === 1, 'session join');
    expect(plane.sessions[0]).toMatchObject({ vendor: 'claude', sessionId: session.sessionId });
    expect(plane.sessions[0]!.palette.length).toBeGreaterThan(0);

    // A trigger travels plane -> socket -> imposter -> bridge -> reducer.
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

    // Unknown names still travel a known hook transport, proving ADR-008
    // retention across the real bridge/normalizer boundary.
    const unknown = new Promise<AgentEventEnvelope>((resolve) => {
      const off = session!.onEvent((candidate) => {
        if (candidate.event.type === 'adapter.native-event' && candidate.event.nativeType === 'FutureHookEvent') {
          off();
          resolve(candidate);
        }
      });
    });
    const future = await planeApi(`/api/sessions/${session.sessionId}/trigger`, {
      event: 'FutureHookEvent',
      with: { future_field: 'preserve me' },
    });
    expect(future.status).toBe(200);
    expect((await unknown).nativeEvent).toMatchObject({ future_field: 'preserve me' });

    // The imposter's own log is the authoritative backfill, served through the
    // plane; the SSE stream carries everything after that.
    const log = (await (await planeApi(`/api/sessions/${session.sessionId}/log`)).json()) as {
      entries: Array<{ event: string }>;
    };
    expect(log.entries.map((entry) => entry.event)).toContain('SessionStart');
    expect(log.entries.map((entry) => entry.event)).toContain('Notification');

    // Death is the socket closing — no prune, no poll, no grace period.
    child!.kill('SIGKILL');
    await waitFor(() => plane.sessions.length === 0, 'departure');
  });

  it('runs a named scenario paused and releases it one step at a time', async () => {
    session = await spawnImposterSession();
    await waitFor(() => session!.state().lifecycle === 'ready', 'imposter boot');
    await waitFor(() => plane.sessions.length === 1, 'session join');

    const emitted = (): Promise<string[]> =>
      planeApi(`/api/sessions/${session!.sessionId}/log`)
        .then((res) => res.json() as Promise<{ entries: Array<{ event: string }> }>)
        .then((body) => body.entries.map((entry) => entry.event));
    const before = (await emitted()).length;

    // `pause` answers as soon as the script is known to be valid, rather than
    // waiting for a resume that has not been pressed yet.
    const started = await planeApi(`/api/sessions/${session.sessionId}/scenario`, {
      name: 'permission-allow',
      mode: 'pause',
      stimulus: { text: 'from the control center' },
    });
    expect(started.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await emitted()).toHaveLength(before);

    await planeApi(`/api/sessions/${session.sessionId}/scenario-control`, { action: 'step' });
    await waitFor(async () => (await emitted()).length === before + 1, 'one released step');

    await planeApi(`/api/sessions/${session.sessionId}/scenario-control`, { action: 'resume' });
    await waitFor(async () => (await emitted()).length > before + 1, 'the rest of the scenario');
  });

  it('refuses an off-model trigger instead of teaching the adapter a lie', async () => {
    session = await spawnImposterSession();
    await waitFor(() => plane.sessions.length === 1, 'session join');
    const refused = await planeApi(`/api/sessions/${session.sessionId}/trigger`, {
      event: 'Notification',
      with: { message: 42 },
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toMatch(/message/);
  });
});
