import { describe, it, expect, vi } from 'vitest';
import { AppServerClient, AppServerError, AppServerRequestTimeoutError, type Transport } from './app-server-client.js';

interface Fake {
  transport: Transport;
  sent: Array<Record<string, unknown>>;
  deliver: (m: unknown) => void;
  fireClose: (info: { code: number | null; signal: string | null }) => void;
}

function fake(): Fake {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  const sent: Array<Record<string, unknown>> = [];
  const transport: Transport = {
    send: (m) => sent.push(m as Record<string, unknown>),
    onMessage: (h) => (onMsg = h),
    onClose: (h) => (onCls = h),
    close: () => {},
  };
  return { transport, sent, deliver: (m) => onMsg?.(m), fireClose: (i) => onCls?.(i) };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('AppServerClient', () => {
  it('correlates a request with its response', async () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    const p = c.request('initialize', { x: 1 });
    expect(f.sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { x: 1 } });
    f.deliver({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects with AppServerError on an error response', async () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    const p = c.request('thread/start');
    f.deliver({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } });
    await expect(p).rejects.toBeInstanceOf(AppServerError);
  });

  it('times out a lost response and ignores a response that arrives later', async () => {
    vi.useFakeTimers();
    try {
      const f = fake();
      const c = new AppServerClient(f.transport, { requestTimeoutMs: 25 });
      const timedOut = c.request('thread/read');
      const capturedError = timedOut.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);
      const error = await capturedError;
      expect(error).toBeInstanceOf(AppServerRequestTimeoutError);
      expect(error).toMatchObject({ method: 'thread/read', timeoutMs: 25 });

      // A fragmented/lost response may eventually arrive. Its expired id must
      // be ignored without affecting subsequent request correlation.
      f.deliver({ jsonrpc: '2.0', id: 1, result: { stale: true } });
      const next = c.request('thread/read');
      f.deliver({ jsonrpc: '2.0', id: 2, result: { fresh: true } });
      await expect(next).resolves.toEqual({ fresh: true });
      c.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes notifications (no id) to the notification handler', () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    const seen: Array<[string, unknown]> = [];
    c.onNotification((m, p) => seen.push([m, p]));
    f.deliver({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: {} } });
    expect(seen).toEqual([['turn/completed', { turn: {} }]]);
  });

  it('answers a server request (id + method) with the handler result', async () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    c.onServerRequest((method) => ({ decision: 'denied', echoed: method }));
    f.deliver({ jsonrpc: '2.0', id: 7, method: 'execApproval', params: {} });
    await tick();
    expect(f.sent.pop()).toEqual({ jsonrpc: '2.0', id: 7, result: { decision: 'denied', echoed: 'execApproval' } });
  });

  it('errors back to the server when a request handler throws', async () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    c.onServerRequest(() => {
      throw new Error('nope');
    });
    f.deliver({ jsonrpc: '2.0', id: 8, method: 'execApproval', params: {} });
    await tick();
    expect(f.sent.pop()).toMatchObject({ jsonrpc: '2.0', id: 8, error: { message: 'nope' } });
  });

  it('rejects pending requests when the transport closes', async () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    const p = c.request('thread/start');
    f.fireClose({ code: 1, signal: null });
    await expect(p).rejects.toThrow();
  });

  it('fans a transport close out to the onClose subscriber', () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    let closed: unknown;
    c.onClose((info) => (closed = info));
    f.fireClose({ code: 0, signal: null });
    expect(closed).toEqual({ code: 0, signal: null });
  });

  it('close() rejects in-flight requests', async () => {
    const f = fake();
    const c = new AppServerClient(f.transport);
    const p = c.request('x');
    c.close();
    await expect(p).rejects.toThrow();
  });
});
