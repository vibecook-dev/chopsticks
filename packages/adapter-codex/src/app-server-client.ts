/**
 * A small hand-written JSON-RPC 2.0 client for `codex app-server` (M5 C4).
 *
 * The C1 spike proved the exact framing (draft/CODEX-SURFACE-FINDINGS.md §7), so
 * rather than vendor 500 KB of codegen for a churning experimental protocol we
 * type only the handful of methods/notifications we use. The transport is
 * injected — real sessions spawn `codex app-server` over stdio; tests drive a
 * scripted in-memory transport.
 *
 * Three inbound message shapes are distinguished the JSON-RPC way:
 * - response      = has `id`, no `method`      → resolves a pending request
 * - server request = has `id` AND `method`     → we must answer (approvals)
 * - notification  = has `method`, no `id`      → streamed session events
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (info: { code: number | null; signal: string | null }) => void): void;
  close(): void;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export class AppServerError extends Error {
  constructor(public readonly body: JsonRpcErrorBody) {
    super(body.message);
    this.name = 'AppServerError';
  }
}

export class AppServerRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`app-server request "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'AppServerRequestTimeoutError';
  }
}

export interface AppServerClientOptions {
  /** Upper bound for every JSON-RPC request. Default: 30 seconds. */
  requestTimeoutMs?: number;
}

export interface AppServerRequestOptions {
  /** Override the client's timeout for this request. Must be positive. */
  timeoutMs?: number;
}

export type NotificationHandler = (method: string, params: Record<string, unknown> | undefined) => void;
export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
  id: number | string,
) => Promise<unknown> | unknown;

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export class AppServerClient {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private notificationHandler?: NotificationHandler;
  private serverRequestHandler?: ServerRequestHandler;
  private closeHandler?: (info: { code: number | null; signal: string | null }) => void;
  private closed = false;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly transport: Transport,
    options: AppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs ?? 30_000);
    transport.onMessage((msg) => void this.handle(msg));
    // The transport carries a single onClose; the client owns it and fans out to
    // its subscriber, so the driver layers on the client, never the transport.
    transport.onClose((info) => {
      this.closed = true;
      this.rejectAllPending(new Error('app-server transport closed'));
      this.closeHandler?.(info);
    });
  }

  /** Send a request; resolves with `result`, rejects with an AppServerError. */
  request(method: string, params?: unknown, options: AppServerRequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    const id = this.nextId++;
    const timeoutMs = positiveTimeout(options.timeoutMs ?? this.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new AppServerRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.transport.send({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Fires when the transport closes (process exit / disconnect). */
  onClose(handler: (info: { code: number | null; signal: string | null }) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(new Error('client closed'));
    this.transport.close();
  }

  private rejectAllPending(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  private async handle(msg: unknown): Promise<void> {
    const m = rec(msg);
    if (!m) return;
    const hasId = m.id !== undefined && m.id !== null;
    const method = typeof m.method === 'string' ? m.method : undefined;

    if (hasId && method === undefined) {
      const entry = this.pending.get(m.id as number);
      if (!entry) return; // unknown/duplicate id
      this.pending.delete(m.id as number);
      clearTimeout(entry.timer);
      if (m.error !== undefined) entry.reject(new AppServerError(m.error as JsonRpcErrorBody));
      else entry.resolve(m.result);
      return;
    }

    if (hasId && method !== undefined) {
      // Server → client request (approvals). Answer, or error back on throw.
      try {
        const result = this.serverRequestHandler
          ? await this.serverRequestHandler(method, rec(m.params), m.id as number | string)
          : null;
        this.transport.send({ jsonrpc: '2.0', id: m.id, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.transport.send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } });
      }
      return;
    }

    if (method !== undefined) this.notificationHandler?.(method, rec(m.params));
  }
}

function positiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('app-server request timeout must be positive');
  return value;
}

/** Default transport: spawn `codex app-server` and speak newline-delimited JSON over stdio. */
export function spawnAppServerTransport(opts?: { executable?: string; args?: string[] }): Transport {
  const child = spawn(opts?.executable ?? 'codex', ['app-server', ...(opts?.args ?? [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = createInterface({ input: child.stdout });
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // non-JSON banner lines are ignored
    }
    onMsg?.(parsed);
  });
  child.on('exit', (code, signal) => onCls?.({ code, signal }));
  child.on('error', () => onCls?.({ code: null, signal: null }));

  return {
    send: (message) => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n');
    },
    onMessage: (handler) => {
      onMsg = handler;
    },
    onClose: (handler) => {
      onCls = handler;
    },
    close: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}
