/**
 * The app-server channel (draft/IMPOSTER.md §9.3) — the imposter as a server.
 *
 * A hook imposter only emits; a JSON-RPC imposter must also SERVE. This is the
 * inbound half of that: NDJSON over stdio, the transport `adapter-codex` spawns
 * (`<bin> app-server`, `stdio: ['pipe','pipe','pipe']`).
 *
 * It does NOT reuse `control/peer.ts`, deliberately, because faithfulness here
 * runs the other way. Codex's wire is JSON-RPC-2.0-SHAPED but not conformant:
 * it **omits `jsonrpc` on server output** (22/22 in the C1 capture) and merely
 * tolerates it on input. An imposter that helpfully added the field would teach
 * the adapter that codex sends it, and mask the day the adapter starts
 * depending on it. The control channel is ours and can be strict; this one
 * belongs to the vendor and must lie exactly as the vendor lies.
 */

import type { Readable, Writable } from 'node:stream';

/** A refusal the imposter wants the client to see as a JSON-RPC error. */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export interface AppServerChannelOptions {
  input: Readable;
  output: Writable;
  /** Serve one inbound client request. Throw `RpcError` to answer with a code. */
  serve(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Inbound notifications (`initialized`); nothing is ever replied. */
  notified?(method: string, params: Record<string, unknown>): void;
  onClose?(): void;
  log?(message: string): void;
}

export interface AppServerChannel {
  /** Server notification — the op timeline's sink for this family. */
  notify(method: string, params: Record<string, unknown>): void;
  /**
   * A SERVER-initiated request. Codex uses these for approvals, and the reply
   * is the whole point: `permission.ask` cannot resolve until the client
   * answers, which is why the op timeline had to be async before this existed.
   */
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function createAppServerChannel(options: AppServerChannelOptions): AppServerChannel {
  const log = options.log ?? (() => {});
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  // Server request ids share no space with the client's; correlation is per
  // direction, exactly as the vendor does it.
  let nextId = 1;
  let closed = false;
  let buffer = '';

  const write = (message: Record<string, unknown>): void => {
    if (closed || !options.output.writable) return;
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  const reply = async (id: unknown, method: string, params: Record<string, unknown>): Promise<void> => {
    try {
      write({ id, result: (await options.serve(method, params)) ?? {} });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
      write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  };

  const dispatch = (line: string): void => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // The vendor ignores non-JSON banner lines rather than failing; so do we.
      return log(`ignoring a non-JSON input line`);
    }
    if (message === null || typeof message !== 'object') return;

    const params =
      message.params !== null && typeof message.params === 'object' && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};

    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        try {
          options.notified?.(message.method, params);
        } catch (error) {
          log(`notification ${message.method} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      void reply(message.id, message.method, params);
      return;
    }

    // Otherwise it is the client's reply to a server request.
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return log('dropping a reply with no usable id');
    const entry = pending.get(id);
    if (!entry) return log(`dropping a reply for unknown id ${id}`);
    pending.delete(id);
    if (message.error !== undefined) {
      const failure = message.error as { code?: number; message?: string };
      entry.reject(new RpcError(failure.code ?? INTERNAL_ERROR, failure.message ?? 'client refused'));
    } else {
      entry.resolve(message.result);
    }
  };

  options.input.setEncoding('utf8');
  options.input.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) dispatch(line);
    }
  });
  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const [, entry] of pending) entry.reject(new RpcError(INTERNAL_ERROR, 'app-server channel closed'));
    pending.clear();
    options.onClose?.();
  };
  options.input.on('end', finish);
  options.input.on('close', finish);

  return {
    notify(method, params) {
      write({ method, params });
    },
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (closed) return Promise.reject(new RpcError(INTERNAL_ERROR, 'app-server channel is closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RpcError(INTERNAL_ERROR, `server request ${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        write({ id, method, params });
      });
    },
    close: finish,
  };
}
