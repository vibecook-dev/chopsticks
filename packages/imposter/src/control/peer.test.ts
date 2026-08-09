import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPeer, type Peer } from './peer.ts';
import { ControlError, INTERNAL_ERROR, PARSE_ERROR, REFUSED } from './protocol.ts';

/**
 * An in-memory duplex pair. The real transport is a unix socket, but framing,
 * correlation, and shutdown are stream-generic — `client.test.ts` covers the
 * socket itself.
 */
class Pipe extends Duplex {
  other!: Pipe;

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.other.push(chunk);
    callback();
  }

  override _final(callback: () => void): void {
    this.other.push(null);
    callback();
  }
}

function duplexPair(): [Pipe, Pipe] {
  const left = new Pipe();
  const right = new Pipe();
  left.other = right;
  right.other = left;
  return [left, right];
}

interface Wired {
  left: Peer;
  right: Peer;
  leftStream: Pipe;
  rightStream: Pipe;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
}

function wire(handle?: (method: string, params: Record<string, unknown>) => unknown): Wired {
  const [leftStream, rightStream] = duplexPair();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const record = (method: string, params: Record<string, unknown>): unknown => {
    calls.push({ method, params });
    return handle ? handle(method, params) : { echoed: params };
  };
  return {
    leftStream,
    rightStream,
    calls,
    left: createPeer(leftStream, { handle: record }),
    right: createPeer(rightStream, { handle: record }),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('control peer', () => {
  it('correlates requests and responses in both directions', async () => {
    const { left, right } = wire();
    await expect(left.request('trigger', { event: 'Notification' })).resolves.toEqual({
      echoed: { event: 'Notification' },
    });
    await expect(right.request('state')).resolves.toEqual({ echoed: {} });
    left.close();
    right.close();
  });

  it('delivers notifications without answering them', async () => {
    const { left, right, calls } = wire();
    expect(left.notify('session.emitted', { sequence: 1 })).toBe(true);
    await settle();
    expect(calls).toEqual([{ method: 'session.emitted', params: { sequence: 1 } }]);
    left.close();
    right.close();
  });

  it('preserves a ControlError code and hides an unexpected throw', async () => {
    const { left, right } = wire((method) => {
      if (method === 'refuse') throw new ControlError(REFUSED, 'off-model payload');
      throw new TypeError('handler bug');
    });
    await expect(left.request('refuse')).rejects.toMatchObject({ code: REFUSED, message: 'off-model payload' });
    // A handler bug must not take the connection down, and must not leak.
    await expect(left.request('boom')).rejects.toMatchObject({ code: INTERNAL_ERROR });
    expect(left.closed).toBe(false);
    left.close();
    right.close();
  });

  it('answers an unparseable line and keeps reading', async () => {
    const { left, right, rightStream } = wire();
    const replies: unknown[] = [];
    rightStream.on('data', (chunk: string) => replies.push(chunk));
    rightStream.write('not json at all\n');
    await settle();
    expect(String(replies.join(''))).toContain(String(PARSE_ERROR));
    expect(left.closed).toBe(false);
    await expect(right.request('state')).resolves.toBeTruthy();
    left.close();
    right.close();
  });

  it('destroys a connection that oversizes a single message', async () => {
    const { left, right, rightStream } = wire();
    const pendingBefore = left.request('state', {}, { timeoutMs: 2000 });
    rightStream.write('x'.repeat(1024 * 1024 + 8));
    await expect(pendingBefore).rejects.toBeInstanceOf(Error);
    expect(left.closed).toBe(true);
    right.close();
  });

  it('rejects in-flight requests when the peer closes', async () => {
    const { left, right } = wire(() => new Promise(() => {}));
    const inFlight = left.request('scenario.run', {}, { timeoutMs: 5000 });
    left.close();
    await expect(inFlight).rejects.toMatchObject({ code: INTERNAL_ERROR });
    right.close();
  });

  it('rejects a request that outlives its deadline', async () => {
    const { left, right } = wire(() => new Promise(() => {}));
    await expect(left.request('scenario.run', {}, { timeoutMs: 20 })).rejects.toThrow('timed out');
    left.close();
    right.close();
  });

  it('reports a closed peer instead of writing into a dead socket', async () => {
    const { left, right } = wire();
    left.close();
    expect(left.notify('session.emitted')).toBe(false);
    await expect(left.request('state')).rejects.toMatchObject({ code: INTERNAL_ERROR });
    right.close();
  });
});
