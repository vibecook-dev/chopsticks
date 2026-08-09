/**
 * The control plane: one socket for imposters, one loopback HTTP server for the
 * console, push instead of poll (draft/IMPOSTER.md §5).
 *
 * The imposter side is exercised through the REAL client, not a hand-rolled
 * stub, so the two halves of the protocol cannot drift apart in this suite.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { connectControl, ControlError, REFUSED, type ImposterControl } from '@vibecook/chopsticks-imposter/control';
import { loadConsoleUi } from './main.js';
import { createControlPlane, jsonSafe, type ControlPlane } from './plane.js';
import { collectEvents, controlPaths, IDLE_MACHINE, waitFor, type EventCollector } from './testing.js';

const planes: ControlPlane[] = [];
const clients: ImposterControl[] = [];
const collectors: EventCollector[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const collector of collectors.splice(0)) collector.close();
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const plane of planes.splice(0)) await plane.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function startPlane(options: Parameters<typeof createControlPlane>[0] = {}): Promise<ControlPlane> {
  const paths = controlPaths();
  roots.push(paths.root);
  const plane = createControlPlane({ socketPath: paths.socketPath, tokenPath: paths.tokenPath, ...options });
  planes.push(plane);
  await plane.start();
  return plane;
}

interface FakeImposter {
  triggered: Array<[string, Record<string, unknown>]>;
  ops: Array<[string, Record<string, unknown>]>;
  control: ImposterControl;
}

async function joinAs(
  plane: ControlPlane,
  overrides: Partial<Parameters<typeof connectControl>[0]> = {},
): Promise<FakeImposter> {
  const triggered: FakeImposter['triggered'] = [];
  const ops: FakeImposter['ops'] = [];
  const control = await connectControl({
    vendor: 'claude',
    version: '2.1.207',
    sessionId: 'a0000000-0000-4000-8000-000000000001',
    cwd: '/work',
    palette: [{ event: 'Notification', fields: ['message'] }],
    ops: [{ op: 'turn.start', channels: ['hook'], events: ['UserPromptSubmit'], fields: ['text'] }],
    channels: () => ['hook', 'transcript'],
    machine: () => IDLE_MACHINE,
    emitted: () => [{ at: '2026-08-07T00:00:00.000Z', sequence: 1, event: 'SessionStart' }],
    trigger: async (event, payload) => void triggered.push([event, payload]),
    runOp: async (op, argument) => void ops.push([op, argument]),
    runScenario: async () => {},
    scenarioControl: () => {},
    fault: async () => {},
    socketPath: plane.socketPath,
    tokenPath: plane.tokenPath,
    ...overrides,
  });
  expect(control).toBeDefined();
  clients.push(control!);
  return { triggered, ops, control: control! };
}

const get = (plane: ControlPlane, path: string): Promise<Response> =>
  fetch(`${plane.url}${path}`, { headers: { authorization: `Bearer ${plane.token}` } });

const post = (plane: ControlPlane, path: string, body: unknown): Promise<Response> =>
  fetch(`${plane.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plane.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sessionPath = (action: string) => `/api/sessions/a0000000-0000-4000-8000-000000000001/${action}?vendor=claude`;

describe('control plane', () => {
  it('serves the packaged console only to the token holder', async () => {
    const plane = await startPlane({ uiHtml: loadConsoleUi() });
    expect((await fetch(`${plane.url}/`)).status).toBe(401);
    const html = await (await fetch(plane.consoleUrl)).text();
    expect(html).toContain('<title>chopsticks — emulator control</title>');
    expect(html).toContain(plane.token);
    expect(await (await get(plane, '/api/sessions')).json()).toEqual({ sessions: [] });
  });

  it('owns the socket and the token file for exactly as long as it runs', async () => {
    const plane = await startPlane();
    expect(readFileSync(plane.tokenPath, 'utf8')).toHaveLength(36);
    if (process.platform !== 'win32') expect(existsSync(plane.socketPath)).toBe(true);
    await plane.stop();
    planes.splice(planes.indexOf(plane), 1);
    expect(existsSync(plane.tokenPath)).toBe(false);
    if (process.platform !== 'win32') expect(existsSync(plane.socketPath)).toBe(false);
  });

  it('refuses to start when another plane is already answering', async () => {
    const plane = await startPlane();
    const second = createControlPlane({ socketPath: plane.socketPath, tokenPath: plane.tokenPath });
    await expect(second.start()).rejects.toThrow(/another emulator control plane/);
  });

  it('lists a joined session and pushes it to the console without being asked', async () => {
    const plane = await startPlane();
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    await joinAs(plane);

    await waitFor(() => (collector.latest('sessions')?.sessions as unknown[] | undefined)?.length === 1, 'push');
    expect((collector.latest('sessions')!.sessions as Array<Record<string, unknown>>)[0]).toMatchObject({
      vendor: 'claude',
      version: '2.1.207',
      channels: ['hook', 'transcript'],
      palette: [{ event: 'Notification', fields: ['message'] }],
    });
    const listed = (await (await get(plane, '/api/sessions')).json()) as { sessions: unknown[] };
    expect(listed.sessions).toHaveLength(1);
  });

  it('turns a socket close into an immediate departure, with no prune anywhere', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');
    await imposter.control.close();
    await waitFor(() => plane.sessions.length === 0, 'departure');
  });

  it('rejects a hello that does not hold the socket token', async () => {
    const plane = await startPlane();
    const paths = controlPaths();
    roots.push(paths.root);
    // Same socket, wrong secret.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(paths.tokenPath, 'not-the-token');
    const control = await connectControl({
      vendor: 'claude',
      version: '2.1.207',
      sessionId: 'b0000000-0000-4000-8000-000000000002',
      cwd: '/work',
      palette: [],
      ops: [],
      channels: () => ['hook'],
      machine: () => IDLE_MACHINE,
      emitted: () => [],
      trigger: async () => {},
      runOp: async () => {},
      runScenario: async () => {},
      scenarioControl: () => {},
      fault: async () => {},
      socketPath: plane.socketPath,
      tokenPath: paths.tokenPath,
    });
    expect(control).toBeUndefined();
    expect(plane.sessions).toHaveLength(0);
  });

  it('proxies a trigger over the socket to the imposter that owns the session', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    const ok = await post(plane, sessionPath('trigger'), { event: 'Notification', with: { message: 'hi' } });
    expect(ok.status).toBe(200);
    expect(imposter.triggered).toEqual([['Notification', { message: 'hi' }]]);
  });

  it('proxies an op the same way, and answers with the state it produced', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    const ok = await post(plane, sessionPath('op'), { op: 'turn.start', with: { text: 'hello' } });
    expect(ok.status).toBe(200);
    expect(imposter.ops).toEqual([['turn.start', { text: 'hello' }]]);
    // The reply carries the lifecycle so the console settles without waiting
    // for the push it is also about to get.
    expect((await ok.json()) as { machine: unknown }).toMatchObject({ machine: { state: 'ready' } });
  });

  it('serves the machine graph so the console never carries its own copy', async () => {
    const plane = await startPlane();
    const description = (await (await get(plane, '/api/machine')).json()) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ op: string }>;
      globals: Array<{ op: string }>;
    };
    expect(description.nodes.map((node) => node.id)).toContain('turn.approval');
    expect(description.edges.some((edge) => edge.op === 'permission.ask')).toBe(true);
    expect(description.globals.map((global) => global.op)).toContain('session.end');
  });

  it('pushes a lifecycle transition as its own event and keeps the session view current', async () => {
    const plane = await startPlane();
    const imposter = await joinAs(plane);
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    await waitFor(() => plane.sessions.length === 1, 'join');

    imposter.control.pushMachine({ ...IDLE_MACHINE, state: 'turn.tool', applied: 5 });
    await waitFor(() => collector.latest('machine') !== undefined, 'machine push');
    expect(collector.latest('machine')).toMatchObject({ machine: { state: 'turn.tool', applied: 5 } });
    // A console that connects later must see the same thing without a replay.
    expect(plane.sessions[0]!.machine.state).toBe('turn.tool');
  });

  it('reports an imposter that declines as 422, distinct from a transport failure', async () => {
    const plane = await startPlane();
    await joinAs(plane, {
      trigger: async () => {
        throw new ControlError(REFUSED, 'imposter refused an off-model payload');
      },
    });
    await waitFor(() => plane.sessions.length === 1, 'join');
    const refused = await post(plane, sessionPath('trigger'), { event: 'Notification', with: {} });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain('off-model');
  });

  it('refuses a second connection claiming a session id that is already live', async () => {
    const plane = await startPlane();
    await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');
    // Same vendor + session id: the plane keeps the incumbent, and the newcomer
    // falls back to standalone rather than silently taking the address over.
    const logs: string[] = [];
    const duplicate = await connectControl({
      vendor: 'claude',
      version: '2.1.207',
      sessionId: 'a0000000-0000-4000-8000-000000000001',
      cwd: '/work',
      palette: [],
      ops: [],
      channels: () => ['hook'],
      machine: () => IDLE_MACHINE,
      emitted: () => [],
      trigger: async () => {},
      runOp: async () => {},
      runScenario: async () => {},
      scenarioControl: () => {},
      fault: async () => {},
      socketPath: plane.socketPath,
      tokenPath: plane.tokenPath,
      log: (message) => logs.push(message),
    });
    expect(duplicate).toBeUndefined();
    expect(logs.join(' ')).toContain('already connected');
    expect(plane.sessions).toHaveLength(1);
  });

  it('validates control params at the socket edge, not at the channel', async () => {
    const plane = await startPlane();
    await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');
    expect((await post(plane, sessionPath('scenario'), { name: 'a', script: [] })).status).toBe(400);
    expect((await post(plane, sessionPath('fault'), { kind: 'meltdown' })).status).toBe(400);
    expect((await post(plane, sessionPath('scenario-control'), { action: 'rewind' })).status).toBe(400);
  });

  it('answers for a session nobody has joined with a 404', async () => {
    const plane = await startPlane();
    expect((await post(plane, sessionPath('trigger'), { event: 'Notification' })).status).toBe(404);
  });

  it('streams emissions and channel changes as they happen', async () => {
    const plane = await startPlane();
    const collector = await collectEvents(plane.url, plane.token);
    collectors.push(collector);
    const imposter = await joinAs(plane);
    await waitFor(() => plane.sessions.length === 1, 'join');

    imposter.control.pushEmitted({ at: '2026-08-07T00:00:01.000Z', sequence: 2, event: 'Notification' });
    await waitFor(() => collector.latest('emitted') !== undefined, 'emitted push');
    expect(collector.latest('emitted')).toMatchObject({
      vendor: 'claude',
      sessionId: 'a0000000-0000-4000-8000-000000000001',
      entry: { event: 'Notification', sequence: 2 },
    });

    imposter.control.pushChannels(['transcript']);
    await waitFor(() => plane.sessions[0]?.channels.join() === 'transcript', 'channel push');
  });
});

describe('jsonSafe', () => {
  it('renders reducer Maps as objects, which is why the console showed zero tools', () => {
    const state = { tools: new Map([['toolu_1', { name: 'Bash' }]]), tags: new Set(['a']) };
    expect(JSON.stringify(state)).toBe('{"tools":{},"tags":{}}');
    expect(jsonSafe(state)).toEqual({ tools: { toolu_1: { name: 'Bash' } }, tags: ['a'] });
  });

  it('stops rather than recursing forever on a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => JSON.stringify(jsonSafe(cyclic))).not.toThrow();
  });
});
