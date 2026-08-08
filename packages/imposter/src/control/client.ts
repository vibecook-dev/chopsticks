/**
 * The imposter's control client (draft/IMPOSTER.md §5): dial the plane's one
 * socket and hold the connection.
 *
 * The direction is inverted from the PoC on purpose. An imposter that dials out
 * serves nothing, needs no port, no state file, and no second bearer token; the
 * plane learns it died the moment the socket closes rather than by failing a
 * poll. Because the connection is held, the plane can push work in — which is
 * what makes `scenario.control` pause/step possible at all.
 *
 * Standalone is a first-class mode (§4.2): every failure here logs and returns
 * `undefined`, and the session runs on exactly as it would in CI.
 */

import { readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { createPeer } from './peer.ts';
import {
  ControlError,
  defaultSocketPath,
  defaultTokenPath,
  MAX_SOCKET_PATH_BYTES,
  METHOD_NOT_FOUND,
  parseFault,
  parseScenarioControl,
  parseScenarioRun,
  parseTrigger,
  REFUSED,
  type EmittedEntry,
  type FaultRequest,
  type PaletteEntry,
  type ScenarioControlAction,
  type ScenarioRunRequest,
} from './protocol.ts';

const DIAL_TIMEOUT_MS = 2_000;
const HELLO_TIMEOUT_MS = 3_000;

export interface ControlClientOptions {
  vendor: string;
  version: string;
  sessionId: string;
  cwd: string;
  palette: PaletteEntry[];
  /** Live channels, re-read per request so a dropped channel is never stale. */
  channels(): string[];
  emitted(): readonly EmittedEntry[];
  trigger(event: string, payload: Record<string, unknown>): Promise<void>;
  runScenario(request: ScenarioRunRequest): Promise<void>;
  scenarioControl(action: ScenarioControlAction): void;
  fault(request: FaultRequest): Promise<void>;
  socketPath?: string;
  tokenPath?: string;
  log?(message: string): void;
}

export interface ImposterControl {
  readonly socketPath: string;
  /** Push one emission. Dropped silently when the socket is backed up. */
  pushEmitted(entry: EmittedEntry): void;
  pushChannels(channels: string[]): void;
  close(reason?: string): Promise<void>;
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let settled = false;
    // The listener stays attached past connect so the socket is never without
    // one; it simply stops mattering once `settled` is true.
    socket.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    });
    socket.setTimeout(DIAL_TIMEOUT_MS, () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`connect to ${path} timed out`));
    });
    socket.once('connect', () => {
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

/** Anything the session throws is the imposter declining, not a protocol fault. */
async function refusing<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError(REFUSED, error instanceof Error ? error.message : String(error));
  }
}

export async function connectControl(options: ControlClientOptions): Promise<ImposterControl | undefined> {
  const log = options.log ?? (() => {});
  const socketPath = options.socketPath ?? defaultSocketPath();
  const tokenPath = options.tokenPath ?? defaultTokenPath();

  if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    log(`control socket path is too long for sun_path (${socketPath}); running standalone`);
    return undefined;
  }

  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
    if (token.length === 0) throw new Error('token file is empty');
  } catch {
    log(`no control token at ${tokenPath}; running standalone`);
    return undefined;
  }

  let socket: Socket;
  try {
    socket = await dial(socketPath);
  } catch (error) {
    log(`no control plane at ${socketPath} (${error instanceof Error ? error.message : String(error)}); standalone`);
    return undefined;
  }

  const handle = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'state':
        return {
          vendor: options.vendor,
          sessionId: options.sessionId,
          pid: process.pid,
          channels: options.channels(),
          emitted: options.emitted().length,
        };
      case 'log':
        return { entries: options.emitted() };
      case 'trigger': {
        const request = parseTrigger(params);
        await refusing(() => options.trigger(request.event, request.with));
        return { ok: true };
      }
      case 'scenario.run': {
        const request = parseScenarioRun(params);
        await refusing(() => options.runScenario(request));
        return { ok: true };
      }
      case 'scenario.control': {
        const request = parseScenarioControl(params);
        await refusing(() => options.scenarioControl(request.action));
        return { ok: true };
      }
      case 'fault': {
        const request = parseFault(params, options.channels());
        await refusing(() => options.fault(request));
        return { ok: true };
      }
      default:
        throw new ControlError(METHOD_NOT_FOUND, `unknown control method ${method}`);
    }
  };

  const peer = createPeer(socket, {
    handle,
    onClose: (error) => log(`control plane disconnected${error ? `: ${error.message}` : ''}`),
    log,
  });

  try {
    await peer.request(
      'session.hello',
      {
        token,
        vendor: options.vendor,
        version: options.version,
        sessionId: options.sessionId,
        pid: process.pid,
        cwd: options.cwd,
        channels: options.channels(),
        palette: options.palette,
      },
      { timeoutMs: HELLO_TIMEOUT_MS },
    );
  } catch (error) {
    log(`control plane refused the session (${error instanceof Error ? error.message : String(error)}); standalone`);
    peer.close();
    return undefined;
  }
  log(`joined the control plane at ${socketPath}`);

  return {
    socketPath,
    pushEmitted(entry) {
      // A flood is exactly when this matters: drop pushes rather than grow the
      // write buffer without bound. The plane's own log is the backfill.
      if (peer.closed || peer.saturated) return;
      peer.notify('session.emitted', { ...entry });
    },
    pushChannels(channels) {
      peer.notify('session.channels', { channels });
    },
    async close(reason = 'other') {
      if (peer.closed) return;
      peer.notify('session.goodbye', { reason });
      // Let the goodbye reach the socket before the FIN that would also have
      // told the plane, just less politely.
      await new Promise((resolve) => setImmediate(resolve));
      peer.close();
    },
  };
}
