/**
 * The client against a real socket — a minimal stand-in plane built from the
 * same `createPeer`, which is what the control center does (§7.2).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectControl, type ControlClientOptions, type ImposterControl } from './client.ts';
import { createPeer, type Peer } from './peer.ts';
import { ControlError, METHOD_NOT_FOUND, REFUSED } from './protocol.ts';

// `sun_path` is ~103 bytes, and the macOS TMPDIR alone eats half of that, so
// tests dig their own short root rather than nest under os.tmpdir().
const shortRoot = (): string => mkdtempSync(process.platform === 'win32' ? 'cs-' : '/tmp/cs-');

interface FakePlane {
  socketPath: string;
  tokenPath: string;
  token: string;
  /** Messages the imposter pushed, in arrival order. */
  pushes: Array<{ method: string; params: Record<string, unknown> }>;
  peer(): Peer;
  joined(): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

const servers: Server[] = [];
const roots: string[] = [];
const clients: ImposterControl[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fakePlane(options: { acceptHello?: boolean } = {}): Promise<FakePlane> {
  const root = shortRoot();
  roots.push(root);
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\chopsticks-test-${randomUUID()}` : join(root, 'p.sock');
  const tokenPath = join(root, 'p.token');
  const token = randomUUID();
  writeFileSync(tokenPath, token, { mode: 0o600 });

  const pushes: FakePlane['pushes'] = [];
  let peer: Peer | undefined;
  let resolveJoined: (hello: Record<string, unknown>) => void;
  const joined = new Promise<Record<string, unknown>>((resolve) => (resolveJoined = resolve));

  const server = createServer((socket: Socket) => {
    peer = createPeer(socket, {
      handle: (method, params) => {
        if (method === 'session.hello') {
          if (options.acceptHello === false) throw new ControlError(REFUSED, 'plane says no');
          resolveJoined(params);
          return { ok: true };
        }
        pushes.push({ method, params });
        return { ok: true };
      },
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  return {
    socketPath,
    tokenPath,
    token,
    pushes,
    peer: () => peer!,
    joined: () => joined,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function clientOptions(plane: FakePlane, overrides: Partial<ControlClientOptions> = {}): ControlClientOptions {
  return {
    vendor: 'claude',
    version: '2.1.207',
    sessionId: 'a0000000-0000-4000-8000-000000000001',
    cwd: '/work',
    palette: [{ event: 'Notification', fields: ['message'] }],
    channels: () => ['hook', 'transcript'],
    emitted: () => [{ at: '2026-08-07T00:00:00.000Z', sequence: 1, event: 'SessionStart' }],
    trigger: async () => {},
    runScenario: async () => {},
    scenarioControl: () => {},
    fault: async () => {},
    socketPath: plane.socketPath,
    tokenPath: plane.tokenPath,
    ...overrides,
  };
}

async function joinPlane(plane: FakePlane, overrides: Partial<ControlClientOptions> = {}): Promise<ImposterControl> {
  const client = await connectControl(clientOptions(plane, overrides));
  expect(client).toBeDefined();
  clients.push(client!);
  return client!;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('imposter control client', () => {
  it('introduces the session with its identity, channels, and ASM palette', async () => {
    const plane = await fakePlane();
    await joinPlane(plane);
    await expect(plane.joined()).resolves.toMatchObject({
      token: plane.token,
      vendor: 'claude',
      version: '2.1.207',
      sessionId: 'a0000000-0000-4000-8000-000000000001',
      cwd: '/work',
      channels: ['hook', 'transcript'],
      palette: [{ event: 'Notification', fields: ['message'] }],
      pid: process.pid,
    });
  });

  it('runs standalone when no plane is listening', async () => {
    const root = shortRoot();
    roots.push(root);
    const tokenPath = join(root, 'p.token');
    writeFileSync(tokenPath, 'token');
    const logs: string[] = [];
    const client = await connectControl(
      clientOptions({ socketPath: join(root, 'absent.sock'), tokenPath } as FakePlane, {
        socketPath: join(root, 'absent.sock'),
        tokenPath,
        log: (message) => logs.push(message),
      }),
    );
    expect(client).toBeUndefined();
    expect(logs.join(' ')).toContain('standalone');
  });

  it('runs standalone when the token file is missing', async () => {
    const plane = await fakePlane();
    const client = await connectControl(clientOptions(plane, { tokenPath: join(shortRoot(), 'absent.token') }));
    expect(client).toBeUndefined();
  });

  it('runs standalone when the plane refuses the hello', async () => {
    const plane = await fakePlane({ acceptHello: false });
    const logs: string[] = [];
    const client = await connectControl(clientOptions(plane, { log: (message) => logs.push(message) }));
    expect(client).toBeUndefined();
    expect(logs.join(' ')).toContain('plane says no');
  });

  it('serves triggers, state, and the log to the plane', async () => {
    const triggered: Array<[string, Record<string, unknown>]> = [];
    const plane = await fakePlane();
    await joinPlane(plane, { trigger: async (event, payload) => void triggered.push([event, payload]) });
    await plane.joined();

    await expect(plane.peer().request('trigger', { event: 'Stop', with: { a: 1 } })).resolves.toEqual({ ok: true });
    expect(triggered).toEqual([['Stop', { a: 1 }]]);

    await expect(plane.peer().request('state')).resolves.toMatchObject({
      vendor: 'claude',
      channels: ['hook', 'transcript'],
      emitted: 1,
    });
    await expect(plane.peer().request('log')).resolves.toMatchObject({
      entries: [{ event: 'SessionStart', sequence: 1 }],
    });
  });

  it('reports a session that declines as REFUSED, not as a transport failure', async () => {
    const plane = await fakePlane();
    await joinPlane(plane, {
      trigger: async () => {
        throw new Error('imposter refused an off-model payload for Stop: missing required field "prompt_id"');
      },
    });
    await plane.joined();
    await expect(plane.peer().request('trigger', { event: 'Stop' })).rejects.toMatchObject({
      code: REFUSED,
      message: expect.stringContaining('off-model'),
    });
  });

  it('validates control params before they reach the session', async () => {
    const plane = await fakePlane();
    await joinPlane(plane);
    await plane.joined();
    await expect(plane.peer().request('scenario.run', { name: 'a', script: [] })).rejects.toThrow(/exactly one/);
    await expect(plane.peer().request('fault', { kind: 'meltdown' })).rejects.toThrow(/fault kind/);
    await expect(plane.peer().request('scenario.control', { action: 'rewind' })).rejects.toThrow(/pause\|step/);
    await expect(plane.peer().request('nonsense')).rejects.toMatchObject({ code: METHOD_NOT_FOUND });
  });

  it('pushes emissions and channel changes without being asked', async () => {
    const plane = await fakePlane();
    const client = await joinPlane(plane);
    await plane.joined();
    client.pushEmitted({ at: '2026-08-07T00:00:01.000Z', sequence: 2, event: 'Notification' });
    client.pushChannels(['transcript']);
    await settle();
    expect(plane.pushes).toEqual([
      { method: 'session.emitted', params: { at: '2026-08-07T00:00:01.000Z', sequence: 2, event: 'Notification' } },
      { method: 'session.channels', params: { channels: ['transcript'] } },
    ]);
  });

  it('says goodbye before closing so a clean exit is distinguishable from death', async () => {
    const plane = await fakePlane();
    const client = await joinPlane(plane);
    await plane.joined();
    await client.close('other');
    await settle();
    expect(plane.pushes).toEqual([{ method: 'session.goodbye', params: { reason: 'other' } }]);
  });
});
