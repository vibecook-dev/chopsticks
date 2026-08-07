/**
 * Emulator control channel (draft/EMULATOR.md §6): the loopback control plane
 * (control-center side) and the per-emulator control server (bin side).
 *
 * Discovery is a well-known state file (`~/.chopsticks/emulator-control.json`)
 * written by the plane; emulator bins read it at startup and register their
 * own control endpoint. Both directions are loopback + bearer, mirroring the
 * hook bridge's discipline (DESIGN §16.6). Emulators run standalone when no
 * plane is up — CI never depends on the center.
 *
 * SELF-CONTAINED like model.ts/engine.ts: bins are `.mjs` under node type
 * stripping, which does not remap `.js`-suffixed relative imports.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface EmulatorPaletteEntry {
  event: string;
  /** PayloadSchema property names, for the console's trigger form. */
  fields: string[];
}

export interface EmulatorRegistration {
  vendor: string;
  sessionId: string;
  pid: number;
  controlUrl: string;
  controlToken: string;
  channels: string[];
  palette: EmulatorPaletteEntry[];
  registeredAt: string;
}

/** Public session view — never carries controlUrl/controlToken. */
export interface EmulatorSessionView {
  vendor: string;
  sessionId: string;
  pid: number;
  channels: string[];
  palette: EmulatorPaletteEntry[];
  registeredAt: string;
}

interface StateFileContents {
  url: string;
  token: string;
  pid: number;
}

export function defaultControlStateFile(): string {
  return join(homedir(), '.chopsticks', 'emulator-control.json');
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: import('node:http').ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

function authorized(req: import('node:http').IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Control plane (control-center side)
// ---------------------------------------------------------------------------

export interface ControlPlane {
  /** Loopback base URL, valid after start(). */
  readonly url: string;
  readonly token: string;
  readonly stateFile: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ControlPlaneOptions {
  stateFile?: string;
  /** HTML served at GET / — `{TOKEN}` is replaced with the plane token. */
  uiHtml?: string;
  /**
   * Center-owned spawn capability (EMULATOR.md §6): the console can create
   * emulated sessions itself, through the real adapter. Vendor wiring lives in
   * the app; the plane stays vendor-neutral.
   */
  spawners?: EmulatorSpawner[];
  /** Diagnostic log for registration/prune decisions. */
  log?: (message: string) => void;
}

/** A vendor spawn binding supplied by the control-center app. */
export interface EmulatorSpawner {
  vendor: string;
  label: string;
  /** Create one emulated session; resolves once the process is launched. */
  spawn(): Promise<{ sessionId: string }>;
  /** Reducer state for a center-owned session; undefined when unknown/app-owned. */
  sessionState(sessionId: string): unknown;
}

async function ping(url: string, token: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${url}/state`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export function createControlPlane(options: ControlPlaneOptions = {}): ControlPlane {
  const stateFile = options.stateFile ?? defaultControlStateFile();
  const token = randomUUID();
  const registrations = new Map<string, EmulatorRegistration>();
  const log = options.log ?? (() => {});
  let server: Server | undefined;
  let url = '';

  const toView = (registration: EmulatorRegistration): EmulatorSessionView => ({
    vendor: registration.vendor,
    sessionId: registration.sessionId,
    pid: registration.pid,
    channels: registration.channels,
    palette: registration.palette,
    registeredAt: registration.registeredAt,
  });

  /** Drop registrations whose emulator no longer answers. */
  const prune = async (): Promise<void> => {
    await Promise.all(
      [...registrations.values()].map(async (registration) => {
        const alive = await ping(registration.controlUrl, registration.controlToken, 750);
        if (!alive) {
          log(`pruning ${registration.sessionId} (ping to ${registration.controlUrl} failed)`);
          registrations.delete(registration.sessionId);
        }
      }),
    );
  };

  const proxy = async (
    sessionId: string,
    path: string,
    body: unknown,
    res: import('node:http').ServerResponse,
  ): Promise<void> => {
    const registration = registrations.get(sessionId);
    if (!registration) {
      sendJson(res, 404, { error: `no emulator registered for session ${sessionId}` });
      return;
    }
    try {
      const upstream = await fetch(`${registration.controlUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${registration.controlToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    } catch (error) {
      registrations.delete(sessionId);
      sendJson(res, 502, { error: `emulator unreachable: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  return {
    get url() {
      return url;
    },
    token,
    stateFile,
    async start() {
      server = createServer(async (req, res) => {
        const path = (req.url ?? '/').split('?')[0]!;
        if (path === '/' && req.method === 'GET') {
          const html = options.uiHtml ?? '<h1>chopsticks emulator control</h1>';
          res.writeHead(200, { 'content-type': 'text/html' }).end(html.replace('{TOKEN}', token));
          return;
        }
        if (path === '/register' && req.method === 'POST') {
          if (!authorized(req, token)) return sendJson(res, 401, { error: 'unauthorized' });
          const body = JSON.parse(await readBody(req)) as EmulatorRegistration;
          registrations.set(body.sessionId, { ...body, registeredAt: new Date().toISOString() });
          log(`registered ${body.vendor} session ${body.sessionId} at ${body.controlUrl}`);
          return sendJson(res, 200, { ok: true });
        }
        if (!authorized(req, token)) return sendJson(res, 401, { error: 'unauthorized' });
        if (path === '/api/spawners' && req.method === 'GET') {
          return sendJson(res, 200, {
            spawners: (options.spawners ?? []).map((spawner) => ({ vendor: spawner.vendor, label: spawner.label })),
          });
        }
        if (path === '/api/spawn' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { vendor?: string };
          const spawner = (options.spawners ?? []).find((candidate) => candidate.vendor === body.vendor);
          if (!spawner) return sendJson(res, 404, { error: `no spawner for vendor ${String(body.vendor)}` });
          try {
            return sendJson(res, 200, await spawner.spawn());
          } catch (error) {
            return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (path === '/api/sessions' && req.method === 'GET') {
          await prune();
          return sendJson(res, 200, { sessions: [...registrations.values()].map(toView) });
        }
        const sessionState = path.match(/^\/api\/sessions\/([^/]+)\/session-state$/);
        if (sessionState && req.method === 'GET') {
          for (const spawner of options.spawners ?? []) {
            const state = spawner.sessionState(sessionState[1]!);
            if (state !== undefined) return sendJson(res, 200, state);
          }
          return sendJson(res, 404, { error: 'not a center-owned session' });
        }
        const sessionAction = path.match(/^\/api\/sessions\/([^/]+)\/(trigger|scenario|fault|log)$/);
        if (sessionAction) {
          const [, sessionId, action] = sessionAction;
          const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined;
          return proxy(sessionId!, `/${action}`, body, res);
        }
        sendJson(res, 404, { error: 'not found' });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address !== 'object') throw new Error('control plane failed to bind');
      url = `http://127.0.0.1:${address.port}`;
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ url, token, pid: process.pid } satisfies StateFileContents), {
        mode: 0o600,
      });
    },
    async stop() {
      rmSync(stateFile, { force: true });
      registrations.clear();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Emulator control server (bin side)
// ---------------------------------------------------------------------------

export interface EmulatorControlOptions {
  vendor: string;
  sessionId: string;
  channels: string[];
  palette: EmulatorPaletteEntry[];
  stateFile?: string;
  /** External ring buffer for /log (the bin pushes every emission here). */
  buffer?: Array<Record<string, unknown>>;
  emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
  runScenario: (name: string) => Promise<void>;
  fault: (kind: 'crash' | 'exit' | 'hang') => void;
  log?: (message: string) => void;
}

export interface EmulatorControl {
  readonly controlUrl: string;
  /** Feed the emitted-event ring buffer (the bin's emit wrapper calls this). */
  record(entry: Record<string, unknown>): void;
  close(): Promise<void>;
}

/**
 * Start the bin-side control server and register with the plane. Returns
 * undefined when no plane state file exists or the plane is unreachable —
 * standalone operation is a first-class mode (EMULATOR.md §4 item 4).
 */
export async function createEmulatorControlServer(
  options: EmulatorControlOptions,
): Promise<EmulatorControl | undefined> {
  const log = options.log ?? (() => {});
  const stateFile = options.stateFile ?? defaultControlStateFile();
  if (!existsSync(stateFile)) {
    log('no control plane state file; running standalone');
    return undefined;
  }
  let plane: StateFileContents;
  try {
    plane = JSON.parse(readFileSync(stateFile, 'utf8')) as StateFileContents;
  } catch {
    log('control plane state file unreadable; running standalone');
    return undefined;
  }
  log(`control plane found at ${plane.url}; binding control server`);

  const controlToken = randomUUID();
  const buffer: Array<Record<string, unknown>> = options.buffer ?? [];
  const record = (entry: Record<string, unknown>): void => {
    buffer.push({ at: new Date().toISOString(), ...entry });
    if (buffer.length > 500) buffer.shift();
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (!authorized(req, controlToken)) return sendJson(res, 401, { error: 'unauthorized' });
    if (path === '/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        vendor: options.vendor,
        sessionId: options.sessionId,
        pid: process.pid,
        channels: options.channels,
        emitted: buffer.length,
      });
    }
    if (path === '/log' && req.method === 'GET') return sendJson(res, 200, { entries: buffer });
    if (path === '/trigger' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { event?: string; with?: Record<string, unknown> };
      if (!body.event) return sendJson(res, 400, { error: 'trigger requires an event' });
      try {
        await options.emit(body.event, body.with ?? {});
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === '/scenario' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { name?: string };
      if (!body.name) return sendJson(res, 400, { error: 'scenario requires a name' });
      try {
        await options.runScenario(body.name);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === '/fault' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { kind?: 'crash' | 'exit' | 'hang' };
      if (!body.kind || !['crash', 'exit', 'hang'].includes(body.kind)) {
        return sendJson(res, 400, { error: 'fault kind must be crash|exit|hang' });
      }
      sendJson(res, 200, { ok: true });
      setImmediate(() => options.fault(body.kind!));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('emulator control server failed to bind');
  const controlUrl = `http://127.0.0.1:${address.port}`;
  log(`control server bound at ${controlUrl}; registering`);

  try {
    const registration: EmulatorRegistration = {
      vendor: options.vendor,
      sessionId: options.sessionId,
      pid: process.pid,
      controlUrl,
      controlToken,
      channels: options.channels,
      palette: options.palette,
      registeredAt: '',
    };
    const res = await fetch(`${plane.url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${plane.token}` },
      body: JSON.stringify(registration),
      signal: AbortSignal.timeout(2000),
    });
    if (res.status !== 200) throw new Error(`register -> ${res.status}`);
  } catch (error) {
    log(`control plane registration failed (${error instanceof Error ? error.message : String(error)}); standalone`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return undefined;
  }

  log(`registered with control plane at ${plane.url}`);
  return {
    controlUrl,
    record,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
