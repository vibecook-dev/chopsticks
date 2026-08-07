import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createControlPlane, createEmulatorControlServer, type ControlPlane, type EmulatorControl } from './control.js';

let dir: string;
let stateFile: string;
let plane: ControlPlane | undefined;
let controls: EmulatorControl[];

const api = (path: string, body?: unknown, token?: string) =>
  fetch(`${plane!.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? plane!.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chopsticks-control-'));
  stateFile = join(dir, 'emulator-control.json');
  controls = [];
});

afterEach(async () => {
  for (const control of controls) await control.close();
  await plane?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function startPlane(): Promise<ControlPlane> {
  plane = createControlPlane({ stateFile, uiHtml: '<h1>token={TOKEN}</h1>' });
  await plane.start();
  return plane;
}

function fakeEmulator(sessionId: string, emitted: Array<Record<string, unknown>>) {
  return createEmulatorControlServer({
    vendor: 'fake',
    sessionId,
    channels: ['hook', 'terminal'],
    palette: [{ event: 'Notification', fields: ['message'] }],
    stateFile,
    emit: async (event, payload) => {
      emitted.push({ event, ...payload });
    },
    runScenario: async (name) => {
      if (name !== 'known') throw new Error(`no scenario named ${name}`);
    },
    fault: () => {},
  });
}

describe('control plane + emulator control server', () => {
  it('round-trips: register → list → trigger proxied to the emulator', async () => {
    await startPlane();
    const emitted: Array<Record<string, unknown>> = [];
    const control = (await fakeEmulator('sess-1', emitted))!;
    controls.push(control);
    expect(control.controlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const sessionsBody = (await (await api('/api/sessions')).json()) as { sessions: Array<Record<string, unknown>> };
    const sessions = sessionsBody.sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ vendor: 'fake', sessionId: 'sess-1' });
    expect(sessions[0]!.palette).toEqual([{ event: 'Notification', fields: ['message'] }]);
    // The public view must not leak control coordinates.
    expect(sessions[0]!.controlUrl).toBeUndefined();
    expect(sessions[0]!.controlToken).toBeUndefined();

    const res = await api('/api/sessions/sess-1/trigger', { event: 'Notification', with: { message: 'hi' } });
    expect(res.status).toBe(200);
    expect(emitted).toEqual([{ event: 'Notification', message: 'hi' }]);

    control.record({ event: 'Notification' });
    const log = (await (await api('/api/sessions/sess-1/log')).json()) as { entries: Array<{ event: string }> };
    expect(log.entries.map((entry) => entry.event)).toEqual(['Notification']);
  });

  it('rejects wrong tokens on both plane and emulator endpoints', async () => {
    await startPlane();
    const control = (await fakeEmulator('sess-1', []))!;
    controls.push(control);
    expect((await api('/api/sessions', undefined, 'wrong')).status).toBe(401);
    expect(
      (
        await fetch(`${control.controlUrl}/state`, {
          headers: { authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
  });

  it('prunes sessions whose emulator stopped answering', async () => {
    await startPlane();
    const control = (await fakeEmulator('sess-1', []))!;
    const before = (await (await api('/api/sessions')).json()) as { sessions: unknown[] };
    expect(before.sessions).toHaveLength(1);
    await control.close(); // emulator died without deregistering
    const after = (await (await api('/api/sessions')).json()) as { sessions: unknown[] };
    expect(after.sessions).toHaveLength(0);
  });

  it('runs standalone when the state file is absent', async () => {
    const control = await fakeEmulator('sess-1', []);
    expect(control).toBeUndefined();
  });

  it('proxies scenario errors as 404 and validates fault kinds', async () => {
    await startPlane();
    const control = (await fakeEmulator('sess-1', []))!;
    controls.push(control);
    expect((await api('/api/sessions/sess-1/scenario', { name: 'nope' })).status).toBe(404);
    expect((await api('/api/sessions/sess-1/fault', { kind: 'explode' })).status).toBe(400);
  });

  it('exposes spawner routes: list, spawn, and center-owned session state', async () => {
    const spawned: string[] = [];
    plane = createControlPlane({
      stateFile,
      spawners: [
        {
          vendor: 'fake',
          label: 'Fake (emulated)',
          spawn: async () => {
            spawned.push('x');
            return { sessionId: 'spawned-1' };
          },
          sessionState: (id) => (id === 'spawned-1' ? { lifecycle: 'ready' } : undefined),
        },
      ],
    });
    await plane.start();

    const spawners = (await (await api('/api/spawners')).json()) as { spawners: Array<{ vendor: string }> };
    expect(spawners.spawners).toEqual([{ vendor: 'fake', label: 'Fake (emulated)' }]);

    const spawn = await api('/api/spawn', { vendor: 'fake' });
    expect(spawn.status).toBe(200);
    expect(((await spawn.json()) as { sessionId: string }).sessionId).toBe('spawned-1');
    expect(spawned).toHaveLength(1);
    expect((await api('/api/spawn', { vendor: 'nobody' })).status).toBe(404);

    const state = await api('/api/sessions/spawned-1/session-state');
    expect(((await state.json()) as { lifecycle: string }).lifecycle).toBe('ready');
    expect((await api('/api/sessions/app-owned/session-state')).status).toBe(404);
  });

  it('serves the console UI with the token injected and removes the state file on stop', async () => {
    const p = await startPlane();
    const html = await (await fetch(`${p.url}/`)).text();
    expect(html).toContain(`token=${p.token}`);
    expect(existsSync(stateFile)).toBe(true);
    await p.stop();
    plane = undefined;
    expect(existsSync(stateFile)).toBe(false);
  });
});
