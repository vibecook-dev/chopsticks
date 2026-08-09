/**
 * The emulator control plane (draft/IMPOSTER.md §5, EMULATOR.md §6).
 *
 * One socket, dialed by imposters; one loopback HTTP server, for the browser
 * console. The plane translates between them: browser ⇄ HTTP ⇄ plane ⇄ UDS ⇄
 * imposter.
 *
 * What the inversion deletes, relative to the PoC: the discovery state file,
 * the per-imposter HTTP server, the second bearer token, `prune()`, and the
 * console's 1.5 s poll. Liveness is socket close — instant and correct rather
 * than inferred from a failed round trip — and because the connection is held,
 * the console is fed by push (SSE) instead of polling.
 *
 * This is the sole consumer of the control protocol's server half and is not
 * published API (§7.2).
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection, createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import { dirname } from 'node:path';
import {
  ControlError,
  createPeer,
  defaultSocketPath,
  defaultTokenPath,
  httpStatusForCode,
  INVALID_REQUEST,
  MAX_SOCKET_PATH_BYTES,
  METHOD_NOT_FOUND,
  NOT_FOUND,
  parseEmitted,
  parseHello,
  parseMachine,
  REFUSED,
  type EmittedEntry,
  type Peer,
  type SessionView,
} from '@vibecook/chopsticks-imposter/control';
import { describeMachine } from '@vibecook/chopsticks-imposter/machine';

/** A connection that has not introduced itself by then is not an imposter. */
const HELLO_GRACE_MS = 5_000;
/** A play-mode scenario can legitimately run for a while; everything else is snappy. */
const SCENARIO_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 5_000;
const STATE_COALESCE_MS = 100;
const SSE_KEEPALIVE_MS = 25_000;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * A vendor spawn binding supplied by the control center. The plane stays
 * vendor-neutral; wiring lives in the app (EMULATOR.md §6).
 */
export interface EmulatorSpawner {
  vendor: string;
  label: string;
  /** Create one emulated session; resolves once the process is launched. */
  spawn(): Promise<{ sessionId: string }>;
  /** Reducer state for a center-owned session; undefined when app-owned. */
  sessionState(sessionId: string): unknown;
  /** Notify on reducer change so the console is pushed, never polled. */
  subscribe?(listener: (sessionId: string) => void): () => void;
}

export interface ControlPlaneOptions {
  socketPath?: string;
  tokenPath?: string;
  /** HTML served at GET / — `{TOKEN}` is replaced with the plane token. */
  uiHtml?: string;
  spawners?: EmulatorSpawner[];
  log?: (message: string) => void;
}

export interface ControlPlane {
  /** Loopback base URL, valid after start(). */
  readonly url: string;
  /** Authenticated browser URL, valid after start(). Treat it as a secret. */
  readonly consoleUrl: string;
  readonly token: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly sessions: SessionView[];
  start(): Promise<void>;
  stop(): Promise<void>;
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        req.off('data', onData);
        req.resume();
        reject(new RequestError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`));
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new RequestError(400, 'request body must be valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}

function secretsEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && secretsEqual(authorization, `Bearer ${token}`)) return true;
  // EventSource cannot set headers, so the SSE stream and the console page
  // itself carry the token in the query string.
  return secretsEqual(url.searchParams.get('token') ?? undefined, token);
}

/**
 * Reducer state is full of `Map`s (tools, permissions, subagents, tasks), and
 * `JSON.stringify` renders a Map as `{}` — which is why the PoC console always
 * reported zero tools in flight. Convert before serializing, not after.
 */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[nested too deep]';
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, entry]) => [String(key), jsonSafe(entry, depth + 1)]));
  }
  if (value instanceof Set) return [...value].map((entry) => jsonSafe(entry, depth + 1));
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, depth + 1)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Plane
// ---------------------------------------------------------------------------

interface JoinedSession {
  view: SessionView;
  peer: Peer;
}

const sessionKey = (vendor: string, sessionId: string): string => `${vendor}\0${sessionId}`;

/** True when something is already accepting connections at this path. */
function planeIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    const finish = (live: boolean): void => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function createControlPlane(options: ControlPlaneOptions = {}): ControlPlane {
  const log = options.log ?? (() => {});
  const socketPath = options.socketPath ?? defaultSocketPath();
  const tokenPath = options.tokenPath ?? defaultTokenPath();
  // Two secrets, because they guard different doors: the browser gets one in
  // its URL, imposters read the other from a 0600 file next to the socket.
  const token = randomUUID();
  const socketToken = randomUUID();

  const sessions = new Map<string, JoinedSession>();
  const streams = new Set<ServerResponse>();
  const stateTimers = new Map<string, NodeJS.Timeout>();
  let httpServer: Server | undefined;
  let socketServer: SocketServer | undefined;
  let url = '';
  let keepalive: NodeJS.Timeout | undefined;
  let unsubscribeSpawners: Array<() => void> = [];

  const publish = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) {
      if (!stream.writableEnded) stream.write(frame);
    }
  };

  const sessionViews = (): SessionView[] => [...sessions.values()].map((session) => session.view);
  const publishSessions = (): void => publish('sessions', { sessions: sessionViews() });

  const publishState = (vendor: string, sessionId: string): void => {
    const spawner = (options.spawners ?? []).find((candidate) => candidate.vendor === vendor);
    const state = spawner?.sessionState(sessionId);
    if (state === undefined) return;
    publish('state', { vendor, sessionId, state: jsonSafe(state) });
  };

  /**
   * A turn produces a burst of reducer changes; the console only needs the
   * settled result, so coalesce rather than push one frame per delta.
   */
  const scheduleState = (vendor: string, sessionId: string): void => {
    const key = sessionKey(vendor, sessionId);
    if (stateTimers.has(key)) return;
    const timer = setTimeout(() => {
      stateTimers.delete(key);
      publishState(vendor, sessionId);
    }, STATE_COALESCE_MS);
    timer.unref?.();
    stateTimers.set(key, timer);
  };

  // -------------------------------------------------------------------------
  // Socket side: imposters dial in
  // -------------------------------------------------------------------------

  const onConnection = (socket: import('node:net').Socket): void => {
    let key: string | undefined;
    let vendor = '';
    let sessionId = '';

    const peer: Peer = createPeer(socket, {
      handle: (method, params) => {
        if (method === 'session.hello') {
          if (key) throw new ControlError(INVALID_REQUEST, 'this connection already introduced a session');
          const hello = parseHello(params);
          if (!secretsEqual(hello.token, socketToken)) throw new ControlError(REFUSED, 'unauthorized');
          const candidate = sessionKey(hello.vendor, hello.sessionId);
          if (sessions.has(candidate)) {
            throw new ControlError(REFUSED, `${hello.vendor} session ${hello.sessionId} is already connected`);
          }
          key = candidate;
          vendor = hello.vendor;
          sessionId = hello.sessionId;
          sessions.set(key, {
            peer,
            view: {
              vendor: hello.vendor,
              version: hello.version,
              sessionId: hello.sessionId,
              pid: hello.pid,
              cwd: hello.cwd,
              channels: hello.channels,
              palette: hello.palette,
              ops: hello.ops,
              machine: hello.machine,
              joinedAt: new Date().toISOString(),
            },
          });
          log(`${hello.vendor} session ${hello.sessionId} joined (pid ${hello.pid})`);
          publishSessions();
          scheduleState(vendor, sessionId);
          return { ok: true };
        }

        const joined = key ? sessions.get(key) : undefined;
        if (!joined) throw new ControlError(INVALID_REQUEST, 'session.hello must come first');

        switch (method) {
          case 'session.emitted': {
            const entry: EmittedEntry = parseEmitted(params);
            publish('emitted', { vendor, sessionId, entry });
            scheduleState(vendor, sessionId);
            return { ok: true };
          }
          case 'session.machine': {
            joined.view.machine = parseMachine(params);
            // Its own event rather than a `sessions` reframe: transitions are
            // frequent and the console animates them, while the session list
            // rebuilds cards.
            publish('machine', { vendor, sessionId, machine: joined.view.machine });
            return { ok: true };
          }
          case 'session.channels': {
            const channels = params.channels;
            if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== 'string')) {
              throw new ControlError(INVALID_REQUEST, 'channels must be an array of strings');
            }
            joined.view.channels = channels as string[];
            publishSessions();
            return { ok: true };
          }
          case 'session.goodbye':
            // Bookkeeping only: removal is the socket closing, which covers the
            // ungraceful cases too and is therefore the only path that matters.
            log(`${vendor} session ${sessionId} said goodbye`);
            return { ok: true };
          default:
            throw new ControlError(METHOD_NOT_FOUND, `unknown control method ${method}`);
        }
      },
      onClose: () => {
        if (!key) return;
        sessions.delete(key);
        log(`${vendor} session ${sessionId} left`);
        publishSessions();
      },
      log,
    });

    const grace = setTimeout(() => {
      if (!key) {
        log('dropping a control connection that never introduced itself');
        peer.close();
      }
    }, HELLO_GRACE_MS);
    grace.unref?.();
  };

  // -------------------------------------------------------------------------
  // HTTP side: the browser console
  // -------------------------------------------------------------------------

  const findSession = (sessionId: string, vendor: string | null): JoinedSession => {
    const matches = [...sessions.values()].filter(
      (session) => session.view.sessionId === sessionId && (vendor === null || session.view.vendor === vendor),
    );
    if (matches.length === 0) throw new RequestError(404, `no imposter connected for session ${sessionId}`);
    if (matches.length > 1) {
      throw new RequestError(409, `session ${sessionId} is ambiguous; supply the vendor query parameter`);
    }
    return matches[0]!;
  };

  const call = async (
    res: ServerResponse,
    sessionId: string,
    vendor: string | null,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    const session = findSession(sessionId, vendor);
    try {
      const result = await session.peer.request(method, params, {
        timeoutMs: method === 'scenario.run' ? SCENARIO_TIMEOUT_MS : SESSION_TIMEOUT_MS,
      });
      sendJson(res, 200, result ?? { ok: true });
    } catch (error) {
      const code = error instanceof ControlError ? error.code : 0;
      sendJson(res, code ? httpStatusForCode(code) : 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const openStream = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    streams.add(res);
    req.on('close', () => streams.delete(res));
    res.write(`event: sessions\ndata: ${JSON.stringify({ sessions: sessionViews() })}\n\n`);
    for (const session of sessions.values()) scheduleState(session.view.vendor, session.view.sessionId);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = requestUrl.pathname;

    if (!authorized(req, requestUrl, token)) return sendJson(res, 401, { error: 'unauthorized' });

    if (path === '/' && req.method === 'GET') {
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
    if (path === '/api/events' && req.method === 'GET') return openStream(req, res);
    if (path === '/api/machine' && req.method === 'GET') {
      // Served rather than duplicated in the page: the console draws whatever
      // the imposter's own machine says it is, so the picture cannot drift from
      // the thing it pictures.
      return sendJson(res, 200, describeMachine());
    }
    if (path === '/api/spawners' && req.method === 'GET') {
      return sendJson(res, 200, {
        spawners: (options.spawners ?? []).map((spawner) => ({ vendor: spawner.vendor, label: spawner.label })),
      });
    }
    if (path === '/api/spawn' && req.method === 'POST') {
      const body = await readJson(req);
      const spawner = (options.spawners ?? []).find((candidate) => candidate.vendor === body.vendor);
      if (!spawner) return sendJson(res, 404, { error: `no spawner for vendor ${String(body.vendor)}` });
      try {
        return sendJson(res, 200, await spawner.spawn());
      } catch (error) {
        return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, { sessions: sessionViews() });
    }

    const sessionState = /^\/api\/sessions\/([^/]+)\/session-state$/.exec(path);
    if (sessionState && req.method === 'GET') {
      const sessionId = decodeURIComponent(sessionState[1]!);
      const vendor = requestUrl.searchParams.get('vendor');
      for (const spawner of options.spawners ?? []) {
        if (vendor !== null && spawner.vendor !== vendor) continue;
        const state = spawner.sessionState(sessionId);
        if (state !== undefined) return sendJson(res, 200, jsonSafe(state));
      }
      return sendJson(res, 404, { error: 'not a center-owned session' });
    }

    const action = /^\/api\/sessions\/([^/]+)\/(trigger|op|scenario|scenario-control|fault|log)$/.exec(path);
    if (action) {
      const [, encodedSessionId, name] = action;
      const expectedMethod = name === 'log' ? 'GET' : 'POST';
      if (req.method !== expectedMethod) {
        res.setHeader('allow', expectedMethod);
        return sendJson(res, 405, { error: `method must be ${expectedMethod}` });
      }
      const method = {
        trigger: 'trigger',
        op: 'op',
        scenario: 'scenario.run',
        'scenario-control': 'scenario.control',
        fault: 'fault',
        log: 'log',
      }[name!]!;
      return call(
        res,
        decodeURIComponent(encodedSessionId!),
        requestUrl.searchParams.get('vendor'),
        method,
        req.method === 'POST' ? await readJson(req) : {},
      );
    }
    sendJson(res, 404, { error: 'not found' });
  };

  const fail = (res: ServerResponse, error: unknown): void => {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof RequestError) return sendJson(res, error.status, { error: error.message });
    if (error instanceof ControlError) return sendJson(res, httpStatusForCode(error.code), { error: error.message });
    sendJson(res, 500, { error: 'internal server error' });
  };

  return {
    get url() {
      return url;
    },
    get consoleUrl() {
      return url ? `${url}/?token=${encodeURIComponent(token)}` : '';
    },
    get sessions() {
      return sessionViews();
    },
    token,
    socketPath,
    tokenPath,

    async start() {
      if (httpServer) throw new Error('control plane is already started');
      if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
        throw new Error(`control socket path is too long for sun_path: ${socketPath}`);
      }
      // A socket file outlives an ungraceful exit, so "does the path exist" is
      // not ownership — only "does something answer on it" is.
      if (await planeIsLive(socketPath)) throw new Error(`another emulator control plane owns ${socketPath}`);
      if (process.platform !== 'win32') {
        mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
        rmSync(socketPath, { force: true });
      }
      mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });

      socketServer = createSocketServer(onConnection);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        socketServer!.once('error', onError);
        socketServer!.listen(socketPath, () => {
          socketServer!.off('error', onError);
          resolve();
        });
      });

      httpServer = createHttpServer((req, res) => {
        void handle(req, res).catch((error) => fail(res, error));
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer!.once('error', onError);
        httpServer!.listen(0, '127.0.0.1', () => {
          httpServer!.off('error', onError);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address !== 'object') throw new Error('control plane failed to bind');
      url = `http://127.0.0.1:${address.port}`;

      writeFileSync(tokenPath, socketToken, { mode: 0o600 });

      unsubscribeSpawners = (options.spawners ?? [])
        .map((spawner) => spawner.subscribe?.((sessionId) => scheduleState(spawner.vendor, sessionId)))
        .filter((off): off is () => void => typeof off === 'function');

      keepalive = setInterval(() => publish('ping', {}), SSE_KEEPALIVE_MS);
      keepalive.unref?.();
      log(`control plane listening on ${socketPath}, console at ${url}`);
    },

    async stop() {
      for (const off of unsubscribeSpawners.splice(0)) off();
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
      for (const timer of stateTimers.values()) clearTimeout(timer);
      stateTimers.clear();
      for (const stream of streams) stream.end();
      streams.clear();
      for (const session of sessions.values()) session.peer.close();
      sessions.clear();
      rmSync(tokenPath, { force: true });
      await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
      await new Promise<void>((resolve) => (socketServer ? socketServer.close(() => resolve()) : resolve()));
      if (process.platform !== 'win32') rmSync(socketPath, { force: true });
      httpServer = undefined;
      socketServer = undefined;
      url = '';
    },
  };
}
