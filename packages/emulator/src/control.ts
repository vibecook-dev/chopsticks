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

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const MAX_BODY_BYTES = 256 * 1024;

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: import('node:http').IncomingMessage, limitBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > limitBytes) {
        settled = true;
        req.off('data', onData);
        req.resume();
        reject(new RequestError(413, `request body exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

async function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestError(400, 'request body must be valid JSON');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function sendJson(res: import('node:http').ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}

function secretsEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authorized(req: import('node:http').IncomingMessage, token: string): boolean {
  const authorization = req.headers.authorization;
  return typeof authorization === 'string' && secretsEqual(authorization, `Bearer ${token}`);
}

function requestFailure(res: import('node:http').ServerResponse, error: unknown): void {
  if (res.headersSent || res.destroyed) return;
  if (error instanceof RequestError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  sendJson(res, 500, { error: 'internal server error' });
}

function requiredString(value: unknown, field: string, maxLength = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    throw new RequestError(400, `${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function loopbackOrigin(value: unknown, field: string): string {
  const raw = requiredString(value, field, 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RequestError(400, `${field} must be a valid URL`);
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '::1'].includes(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new RequestError(400, `${field} must be an HTTP loopback origin`);
  }
  return parsed.origin;
}

// ---------------------------------------------------------------------------
// Control plane (control-center side)
// ---------------------------------------------------------------------------

export interface ControlPlane {
  /** Loopback base URL, valid after start(). */
  readonly url: string;
  /** Authenticated browser URL, valid after start(). Treat it as a secret. */
  readonly consoleUrl: string;
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

function parseStateFile(value: unknown): StateFileContents {
  const record = objectBody(value);
  const url = loopbackOrigin(record.url, 'state url');
  const token = requiredString(record.token, 'state token', 512);
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new RequestError(400, 'state pid must be a positive integer');
  }
  return { url, token, pid: record.pid as number };
}

function parseRegistration(value: unknown): EmulatorRegistration {
  const record = objectBody(value);
  const vendor = requiredString(record.vendor, 'vendor', 128);
  const sessionId = requiredString(record.sessionId, 'sessionId', 512);
  const controlUrl = loopbackOrigin(record.controlUrl, 'controlUrl');
  const controlToken = requiredString(record.controlToken, 'controlToken', 512);
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) {
    throw new RequestError(400, 'pid must be a positive integer');
  }
  if (
    !Array.isArray(record.channels) ||
    record.channels.length > 64 ||
    record.channels.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 128)
  ) {
    throw new RequestError(400, 'channels must be an array of at most 64 non-empty strings');
  }
  if (!Array.isArray(record.palette) || record.palette.length > 1024) {
    throw new RequestError(400, 'palette must be an array of at most 1024 entries');
  }
  const palette = record.palette.map((rawEntry, index): EmulatorPaletteEntry => {
    const entry = objectBody(rawEntry);
    const event = requiredString(entry.event, `palette[${index}].event`, 256);
    if (
      !Array.isArray(entry.fields) ||
      entry.fields.length > 256 ||
      entry.fields.some((field) => typeof field !== 'string' || field.length === 0 || field.length > 256)
    ) {
      throw new RequestError(400, `palette[${index}].fields must be an array of non-empty strings`);
    }
    return { event, fields: [...new Set(entry.fields as string[])] };
  });
  return {
    vendor,
    sessionId,
    pid: record.pid as number,
    controlUrl,
    controlToken,
    channels: [...new Set(record.channels as string[])],
    palette,
    registeredAt: new Date().toISOString(),
  };
}

function registrationKey(vendor: string, sessionId: string): string {
  return `${vendor}\0${sessionId}`;
}

async function registrationChannels(
  registration: EmulatorRegistration,
  timeoutMs: number,
): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${registration.controlUrl}/state`, {
      headers: { authorization: `Bearer ${registration.controlToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return undefined;
    const state = objectBody(await res.json());
    const identityMatches =
      state.vendor === registration.vendor &&
      state.sessionId === registration.sessionId &&
      state.pid === registration.pid;
    if (
      !identityMatches ||
      !Array.isArray(state.channels) ||
      state.channels.some((channel) => typeof channel !== 'string')
    ) {
      return undefined;
    }
    return state.channels as string[];
  } catch {
    return undefined;
  }
}

async function livePlaneInStateFile(stateFile: string): Promise<boolean> {
  if (!existsSync(stateFile)) return false;
  try {
    const state = parseStateFile(JSON.parse(readFileSync(stateFile, 'utf8')));
    const res = await fetch(`${state.url}/api/sessions`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(500),
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
        const channels = await registrationChannels(registration, 750);
        if (!channels) {
          log(`pruning ${registration.vendor}/${registration.sessionId} (control endpoint failed identity check)`);
          registrations.delete(registrationKey(registration.vendor, registration.sessionId));
        } else {
          registration.channels = channels;
        }
      }),
    );
  };

  const findRegistration = (
    sessionId: string,
    vendor: string | null,
  ): { registration?: EmulatorRegistration; error?: { status: number; message: string } } => {
    const matches = [...registrations.values()].filter(
      (registration) => registration.sessionId === sessionId && (vendor === null || registration.vendor === vendor),
    );
    if (matches.length === 0) {
      return { error: { status: 404, message: `no emulator registered for session ${sessionId}` } };
    }
    if (matches.length > 1) {
      return {
        error: { status: 409, message: `session ${sessionId} is ambiguous; supply the vendor query parameter` },
      };
    }
    return { registration: matches[0] };
  };

  const proxy = async (
    sessionId: string,
    vendor: string | null,
    path: string,
    body: unknown,
    res: import('node:http').ServerResponse,
  ): Promise<void> => {
    const found = findRegistration(sessionId, vendor);
    if (!found.registration) {
      sendJson(res, found.error!.status, { error: found.error!.message });
      return;
    }
    const registration = found.registration;
    try {
      const upstream = await fetch(`${registration.controlUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${registration.controlToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(path === '/scenario' ? 30_000 : 5_000),
      });
      sendJson(res, upstream.status, await upstream.json().catch(() => ({})));
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      sendJson(res, timedOut ? 504 : 502, {
        error: `emulator ${timedOut ? 'request timed out' : 'unreachable'}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const handle = async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = requestUrl.pathname;
    if (path === '/' && req.method === 'GET') {
      if (!authorized(req, token) && !secretsEqual(requestUrl.searchParams.get('token') ?? undefined, token)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      const html = options.uiHtml ?? '<h1>chopsticks emulator control</h1>';
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        })
        .end(html.replace('{TOKEN}', token));
      return;
    }
    if (path === '/register' && req.method === 'POST') {
      if (!authorized(req, token)) return sendJson(res, 401, { error: 'unauthorized' });
      const registration = parseRegistration(await readJson(req));
      const channels = await registrationChannels(registration, 1000);
      if (!channels) {
        return sendJson(res, 400, { error: 'control endpoint did not answer with the registered identity' });
      }
      registration.channels = channels;
      registrations.set(registrationKey(registration.vendor, registration.sessionId), registration);
      log(`registered ${registration.vendor} session ${registration.sessionId} at ${registration.controlUrl}`);
      return sendJson(res, 200, { ok: true });
    }
    if (!authorized(req, token)) return sendJson(res, 401, { error: 'unauthorized' });
    if (path === '/api/spawners' && req.method === 'GET') {
      return sendJson(res, 200, {
        spawners: (options.spawners ?? []).map((spawner) => ({ vendor: spawner.vendor, label: spawner.label })),
      });
    }
    if (path === '/api/spawn' && req.method === 'POST') {
      const body = objectBody(await readJson(req));
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
      const sessionId = decodeURIComponent(sessionState[1]!);
      const vendor = requestUrl.searchParams.get('vendor');
      for (const spawner of options.spawners ?? []) {
        if (vendor !== null && spawner.vendor !== vendor) continue;
        const state = spawner.sessionState(sessionId);
        if (state !== undefined) return sendJson(res, 200, state);
      }
      return sendJson(res, 404, { error: 'not a center-owned session' });
    }
    const sessionAction = path.match(/^\/api\/sessions\/([^/]+)\/(trigger|scenario|fault|log)$/);
    if (sessionAction) {
      const [, encodedSessionId, action] = sessionAction;
      const expectedMethod = action === 'log' ? 'GET' : 'POST';
      if (req.method !== expectedMethod) {
        res.setHeader('allow', expectedMethod);
        return sendJson(res, 405, { error: `method must be ${expectedMethod}` });
      }
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      return proxy(
        decodeURIComponent(encodedSessionId!),
        requestUrl.searchParams.get('vendor'),
        `/${action}`,
        body,
        res,
      );
    }
    sendJson(res, 404, { error: 'not found' });
  };

  return {
    get url() {
      return url;
    },
    get consoleUrl() {
      return url ? `${url}/?token=${encodeURIComponent(token)}` : '';
    },
    token,
    stateFile,
    async start() {
      if (server) throw new Error('control plane is already started');
      if (await livePlaneInStateFile(stateFile)) {
        throw new Error(`another emulator control plane owns ${stateFile}`);
      }
      rmSync(stateFile, { force: true });
      server = createServer((req, res) => {
        void handle(req, res).catch((error) => requestFailure(res, error));
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server!.once('error', onError);
        server!.listen(0, '127.0.0.1', () => {
          server!.off('error', onError);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address !== 'object') throw new Error('control plane failed to bind');
      url = `http://127.0.0.1:${address.port}`;
      try {
        mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
        writeFileSync(stateFile, JSON.stringify({ url, token, pid: process.pid } satisfies StateFileContents), {
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        url = '';
        throw error;
      }
    },
    async stop() {
      try {
        const state = parseStateFile(JSON.parse(readFileSync(stateFile, 'utf8')));
        if (state.url === url && secretsEqual(state.token, token)) rmSync(stateFile, { force: true });
      } catch {
        // Missing, malformed, or replaced state belongs to nobody we should remove.
      }
      registrations.clear();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
      url = '';
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
  /** Current live channels when faults can disconnect them. */
  channelState?: () => string[];
  palette: EmulatorPaletteEntry[];
  stateFile?: string;
  /** External ring buffer for /log (the bin pushes every emission here). */
  buffer?: Array<Record<string, unknown>>;
  emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
  runScenario: (request: EmulatorScenarioRequest) => Promise<void>;
  fault: (request: EmulatorFaultRequest) => void | Promise<void>;
  log?: (message: string) => void;
}

export interface EmulatorScenarioRequest {
  name?: string;
  script?: unknown;
  mode?: 'play' | 'pause' | 'step';
  speed?: number;
  stimulus?: Record<string, unknown>;
}

export type EmulatorFaultKind = 'crash' | 'exit' | 'hang' | 'flood' | 'channel-drop';

export interface EmulatorFaultRequest {
  kind: EmulatorFaultKind;
  channel?: string;
  count?: number;
  event?: string;
  with?: Record<string, unknown>;
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
    plane = parseStateFile(JSON.parse(readFileSync(stateFile, 'utf8')));
  } catch {
    log('control plane state file unreadable; running standalone');
    return undefined;
  }
  log(`control plane found at ${plane.url}; binding control server`);

  const controlToken = randomUUID();
  const buffer: Array<Record<string, unknown>> = options.buffer ?? [];
  let cursor = buffer.reduce(
    (maximum, entry) => (typeof entry.sequence === 'number' ? Math.max(maximum, entry.sequence) : maximum),
    buffer.length,
  );
  const record = (entry: Record<string, unknown>): void => {
    cursor += 1;
    buffer.push({ at: new Date().toISOString(), sequence: cursor, ...entry });
    if (buffer.length > 500) buffer.shift();
  };

  const handle = async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!authorized(req, controlToken)) return sendJson(res, 401, { error: 'unauthorized' });
    if (path === '/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        vendor: options.vendor,
        sessionId: options.sessionId,
        pid: process.pid,
        channels: options.channelState?.() ?? options.channels,
        emitted: buffer.length,
        cursor: typeof buffer.at(-1)?.sequence === 'number' ? buffer.at(-1)!.sequence : Math.max(cursor, buffer.length),
      });
    }
    if (path === '/log' && req.method === 'GET') return sendJson(res, 200, { entries: buffer });
    if (path === '/trigger' && req.method === 'POST') {
      const body = objectBody(await readJson(req));
      const event = requiredString(body.event, 'event', 256);
      const payload = body.with === undefined ? {} : objectBody(body.with);
      try {
        await options.emit(event, payload);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === '/scenario' && req.method === 'POST') {
      const body = objectBody(await readJson(req));
      if ((body.name === undefined) === (body.script === undefined)) {
        return sendJson(res, 400, { error: 'scenario requires exactly one of name or script' });
      }
      if (body.name !== undefined) requiredString(body.name, 'scenario name', 256);
      if (body.mode !== undefined && !['play', 'pause', 'step'].includes(String(body.mode))) {
        return sendJson(res, 400, { error: 'scenario mode must be play|pause|step' });
      }
      if (
        body.speed !== undefined &&
        (typeof body.speed !== 'number' || !Number.isFinite(body.speed) || body.speed <= 0 || body.speed > 100)
      ) {
        return sendJson(res, 400, { error: 'scenario speed must be greater than 0 and at most 100' });
      }
      const stimulus = body.stimulus === undefined ? undefined : objectBody(body.stimulus);
      try {
        await options.runScenario({
          ...(body.name === undefined ? {} : { name: body.name as string }),
          ...(body.script === undefined ? {} : { script: body.script }),
          ...(body.mode === undefined ? {} : { mode: body.mode as 'play' | 'pause' | 'step' }),
          ...(body.speed === undefined ? {} : { speed: body.speed as number }),
          ...(stimulus === undefined ? {} : { stimulus }),
        });
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        const notFound =
          (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') ||
          (error instanceof Error && error.message.startsWith('no scenario named'));
        return sendJson(res, notFound ? 404 : 422, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (path === '/fault' && req.method === 'POST') {
      const body = objectBody(await readJson(req));
      if (!['crash', 'exit', 'hang', 'flood', 'channel-drop'].includes(String(body.kind))) {
        return sendJson(res, 400, { error: 'fault kind must be crash|exit|hang|flood|channel-drop' });
      }
      const request: EmulatorFaultRequest = {
        kind: body.kind as EmulatorFaultKind,
        ...(body.channel === undefined ? {} : { channel: requiredString(body.channel, 'channel', 128) }),
        ...(body.event === undefined ? {} : { event: requiredString(body.event, 'event', 256) }),
        ...(body.count === undefined ? {} : { count: body.count as number }),
        ...(body.with === undefined ? {} : { with: objectBody(body.with) }),
      };
      if (
        request.count !== undefined &&
        (!Number.isInteger(request.count) || request.count < 1 || request.count > 10_000)
      ) {
        return sendJson(res, 400, { error: 'fault count must be an integer from 1 to 10000' });
      }
      if (request.kind === 'channel-drop' && (!request.channel || !options.channels.includes(request.channel))) {
        return sendJson(res, 400, { error: `channel-drop requires one of: ${options.channels.join('|')}` });
      }
      try {
        await options.fault(request);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    sendJson(res, 404, { error: 'not found' });
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => requestFailure(res, error));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
