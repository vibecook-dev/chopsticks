import { describe, expect, it } from 'vitest';
import { LatestValueQueue } from './latest-value-queue.js';

describe('LatestValueQueue', () => {
  it('keeps only the newest pending value for each key', () => {
    const queue = new LatestValueQueue<string, { id: string; revision: number }>();
    queue.enqueue('a', { id: 'a', revision: 1 });
    queue.enqueue('a', { id: 'a', revision: 2 });
    queue.enqueue('b', { id: 'b', revision: 1 });

    expect(queue.take()?.values).toEqual([
      { id: 'a', revision: 2 },
      { id: 'b', revision: 1 },
    ]);
  });

  it('stays bounded when a producer greatly outruns an unacknowledged consumer', () => {
    const queue = new LatestValueQueue<string, number>();
    for (let revision = 0; revision < 100_000; revision += 1) queue.enqueue('agent', revision);
    const inFlight = queue.take()!;
    for (let revision = 100_000; revision < 200_000; revision += 1) queue.enqueue('agent', revision);

    expect(inFlight.values).toEqual([99_999]);
    expect(queue.hasInFlight).toBe(true);
    expect(queue.pendingSize).toBe(1);
    expect(queue.acknowledge(inFlight.sequence)).toBe(true);
    expect(queue.take()?.values).toEqual([199_999]);
  });

  it('allows only one in-flight batch and releases the next batch after acknowledgement', () => {
    const queue = new LatestValueQueue<string, number>();
    queue.enqueue('a', 1);
    const first = queue.take()!;
    queue.enqueue('a', 2);
    queue.enqueue('a', 3);

    expect(queue.take()).toBeUndefined();
    expect(queue.acknowledge(first.sequence + 1)).toBe(false);
    expect(queue.acknowledge(first.sequence)).toBe(true);
    expect(queue.take()?.values).toEqual([3]);
  });

  it('retries interrupted values without replacing newer pending values', () => {
    const queue = new LatestValueQueue<string, number>();
    queue.enqueue('a', 1);
    queue.enqueue('b', 1);
    queue.take();
    queue.enqueue('a', 2);

    queue.retryInFlight();

    expect(queue.take()?.values).toEqual([2, 1]);
  });

  it('discards a finished key from pending delivery', () => {
    const queue = new LatestValueQueue<string, number>();
    queue.enqueue('finished', 1);
    queue.enqueue('live', 2);

    expect(queue.delete('finished')).toBe(true);
    expect(queue.take()?.values).toEqual([2]);
  });
});
