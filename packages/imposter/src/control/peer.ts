/**
 * Newline-delimited JSON-RPC 2.0 over a duplex stream (draft/IMPOSTER.md §5.1).
 *
 * One codec, both ends: the imposter's client and the control center's plane
 * build their halves from this, so there is a single place where framing,
 * correlation, and shutdown can be wrong — and a single place that is tested.
 *
 * Either side may originate. A message with an `id` is a request and gets a
 * reply; without one it is a notification and never does. Ids are per-peer, so
 * the two directions never collide.
 */

import type { Duplex } from 'node:stream';
import { ControlError, INTERNAL_ERROR, INVALID_REQUEST, PARSE_ERROR } from './protocol.ts';

/**
 * A single line is one whole message, so a peer that cannot find a newline
 * inside this many bytes has lost sync and cannot recover by reading further.
 */
const MAX_LINE_BYTES = 1024 * 1024;

/** Beyond this much unflushed output, drop pushes rather than grow the heap. */
const SATURATION_BYTES = 4 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 5_000;

export interface PeerOptions {
  /**
   * Handles one inbound request or notification. Throw a `ControlError` to
   * answer with a specific JSON-RPC code; anything else becomes an internal
   * error, so a handler bug can never take the connection down.
   */
  handle(method: string, params: Record<string, unknown>): unknown | Promise<unknown>;
  /** Fired exactly once, whether the stream ended, errored, or we closed it. */
  onClose?(error?: Error): void;
  log?(message: string): void;
  timeoutMs?: number;
}

export interface Peer {
  request(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Fire-and-forget. Returns false when the message was not written. */
  notify(method: string, params?: Record<string, unknown>): boolean;
  /** True when unflushed output has grown past the point of pushing more. */
  readonly saturated: boolean;
  readonly closed: boolean;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export function createPeer(stream: Duplex, options: PeerOptions): Peer {
  const log = options.log ?? (() => {});
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  let buffer = '';

  const write = (message: Record<string, unknown>): boolean => {
    if (closed || !stream.writable) return false;
    stream.write(`${JSON.stringify(message)}\n`);
    return true;
  };

  const settle = (error?: Error): void => {
    if (closed) return;
    closed = true;
    const failure = error ?? new ControlError(INTERNAL_ERROR, 'control connection closed');
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
    options.onClose?.(error);
  };

  const respond = async (id: number | string, method: string, params: Record<string, unknown>): Promise<void> => {
    try {
      const result = await options.handle(method, params);
      write({ jsonrpc: '2.0', id, result: result ?? { ok: true } });
    } catch (error) {
      const code = error instanceof ControlError ? error.code : INTERNAL_ERROR;
      write({
        jsonrpc: '2.0',
        id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const dispatch = (raw: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      // No id is recoverable from an unparseable line, so answer with the
      // null-id form the spec reserves for exactly this and keep reading.
      write({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'message must be valid JSON' } });
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      write({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'message must be an object' } });
      return;
    }
    const record = message as Record<string, unknown>;
    const id = record.id;

    if (record.method === undefined) {
      // A response: match it against what we sent, or drop it.
      if (typeof id !== 'number') return log('dropping a response with no usable id');
      const entry = pending.get(id);
      if (!entry) return log(`dropping a response for unknown id ${id}`);
      pending.delete(id);
      clearTimeout(entry.timer);
      if (record.error !== undefined) {
        const failure = record.error as { code?: number; message?: string };
        entry.reject(new ControlError(failure.code ?? INTERNAL_ERROR, failure.message ?? 'control request failed'));
      } else {
        entry.resolve(record.result);
      }
      return;
    }

    if (typeof record.method !== 'string') {
      if (id !== undefined)
        write({ jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'method must be a string' } });
      return;
    }
    const params =
      record.params === null || typeof record.params !== 'object' || Array.isArray(record.params)
        ? {}
        : (record.params as Record<string, unknown>);

    if (id === undefined) {
      // Notification: a handler failure is logged, never answered.
      void (async () => {
        try {
          await options.handle(record.method as string, params);
        } catch (error) {
          log(
            `notification ${String(record.method)} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
      return;
    }
    void respond(id as number | string, record.method, params);
  };

  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) dispatch(line);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      buffer = '';
      const error = new ControlError(INVALID_REQUEST, `control message exceeds ${MAX_LINE_BYTES} bytes`);
      stream.destroy(error);
    }
  });
  stream.on('error', (error: Error) => settle(error));
  stream.on('close', () => settle());
  stream.on('end', () => {
    if (!closed) stream.destroy();
  });

  return {
    get saturated() {
      return stream.writableLength > SATURATION_BYTES;
    },
    get closed() {
      return closed;
    },
    request(method, params = {}, requestOptions = {}) {
      if (closed || !stream.writable) {
        return Promise.reject(new ControlError(INTERNAL_ERROR, 'control connection is closed'));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new ControlError(INTERNAL_ERROR, `control request ${method} timed out`));
        }, requestOptions.timeoutMs ?? defaultTimeout);
        // An unref'd timer must not be the only thing keeping a CLI alive.
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params = {}) {
      return write({ jsonrpc: '2.0', method, params });
    },
    close() {
      if (closed) return;
      stream.end();
      stream.destroy();
      settle();
    },
  };
}
