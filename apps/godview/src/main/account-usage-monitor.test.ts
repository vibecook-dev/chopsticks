import { describe, expect, it, vi } from 'vitest';
import type { AccountUsageFetchResult } from '@vibecook/chopsticks-core';
import { createAccountUsageMonitor } from './account-usage-monitor.js';

const available = (provider: string): AccountUsageFetchResult => ({
  status: 'available',
  snapshot: {
    provider,
    fetchedAt: '2026-07-23T20:00:00.000Z',
    scope: 'subscription',
    source: { kind: 'native-protocol', stability: 'documented' },
    limits: [],
  },
});

describe('createAccountUsageMonitor', () => {
  it('coalesces refreshes, preserves provider order, and publishes one batch', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchUsage = vi.fn(async (agent: 'claude' | 'codex' | 'grok') => {
      await gate;
      return available(agent);
    });
    const publish = vi.fn();
    const monitor = createAccountUsageMonitor({
      fetchUsage,
      publish,
      now: () => new Date('2026-07-23T20:01:00.000Z'),
    });

    const first = monitor.refresh();
    const second = monitor.refresh();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(3));
    release?.();

    const batch = await first;
    expect(batch.refreshedAt).toBe('2026-07-23T20:01:00.000Z');
    expect(batch.entries.map((entry) => entry.agent)).toEqual(['claude', 'codex', 'grok']);
    expect(publish).toHaveBeenCalledOnce();
    await expect(monitor.snapshot()).resolves.toBe(batch);
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it('keeps a complete batch when one provider rejects', async () => {
    const onError = vi.fn();
    const monitor = createAccountUsageMonitor({
      fetchUsage: async (agent) => {
        if (agent === 'codex') throw new Error('private native detail');
        return available(agent);
      },
      publish: () => undefined,
      onError,
    });

    const batch = await monitor.refresh();
    expect(batch.entries).toHaveLength(3);
    expect(batch.entries.find((entry) => entry.agent === 'codex')?.result).toEqual({
      status: 'unavailable',
      provider: 'codex',
      message: 'codex account usage could not be refreshed',
      retryable: true,
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('polls at the configured interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const fetchUsage = vi.fn(async (agent: 'claude' | 'codex' | 'grok') => available(agent));
      const publish = vi.fn();
      const monitor = createAccountUsageMonitor({ fetchUsage, publish, refreshMs: 1_000 });

      monitor.start();
      await monitor.snapshot();
      expect(fetchUsage).toHaveBeenCalledTimes(3);
      expect(publish).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchUsage).toHaveBeenCalledTimes(6);
      expect(publish).toHaveBeenCalledTimes(2);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchUsage).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the last good snapshot and honors provider Retry-After', async () => {
    let nowMs = Date.parse('2026-07-23T20:00:00.000Z');
    let claudeCalls = 0;
    const fetchUsage = vi.fn(async (agent: 'claude' | 'codex' | 'grok'): Promise<AccountUsageFetchResult> => {
      if (agent !== 'claude' || claudeCalls++ === 0) return available(agent);
      return {
        status: 'unavailable',
        provider: 'claude',
        message: 'Claude account usage request failed with HTTP 429',
        retryable: true,
        code: 'rate-limited',
        retryAt: '2026-07-23T20:10:00.000Z',
      };
    });
    const monitor = createAccountUsageMonitor({
      fetchUsage,
      publish: () => undefined,
      refreshMs: 1_000,
      now: () => new Date(nowMs),
    });

    await monitor.refresh();
    nowMs += 1_000;
    const rateLimited = await monitor.refresh();
    expect(rateLimited.entries.find((entry) => entry.agent === 'claude')).toMatchObject({
      stale: true,
      result: { status: 'available' },
      refreshFailure: {
        status: 'unavailable',
        retryAt: '2026-07-23T20:10:00.000Z',
      },
    });

    fetchUsage.mockClear();
    nowMs += 1_000;
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([agent]) => agent)).toEqual(['codex', 'grok']);

    fetchUsage.mockClear();
    nowMs = Date.parse('2026-07-23T20:10:00.000Z');
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([agent]) => agent)).toEqual(['claude', 'codex', 'grok']);
  });

  it('ingests status-line Claude usage and defers OAuth polling', async () => {
    let nowMs = Date.parse('2026-07-23T20:00:00.000Z');
    const fetchUsage = vi.fn(async (agent: 'claude' | 'codex' | 'grok') => available(agent));
    const publish = vi.fn();
    const monitor = createAccountUsageMonitor({
      fetchUsage,
      publish,
      refreshMs: 1_000,
      now: () => new Date(nowMs),
    });

    await monitor.refresh();
    fetchUsage.mockClear();
    publish.mockClear();

    const statusLine: AccountUsageFetchResult = {
      status: 'available',
      snapshot: {
        provider: 'claude',
        fetchedAt: '2026-07-23T20:00:30.000Z',
        scope: 'subscription',
        source: { kind: 'native-statusline', stability: 'documented' },
        limits: [
          {
            id: 'claude-subscription',
            windows: [{ id: 'five_hour', label: '5-hour', durationMinutes: 300, usedPercent: 12 }],
          },
        ],
      },
    };

    nowMs = Date.parse('2026-07-23T20:00:30.000Z');
    const batch = monitor.ingest('claude', statusLine);
    expect(batch.entries.find((entry) => entry.agent === 'claude')?.result).toEqual(statusLine);
    expect(publish).toHaveBeenCalledOnce();

    fetchUsage.mockClear();
    nowMs = Date.parse('2026-07-23T20:10:00.000Z');
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([agent]) => agent)).toEqual(['codex', 'grok']);

    fetchUsage.mockClear();
    nowMs = Date.parse('2026-07-23T20:30:30.000Z');
    await monitor.refresh();
    expect(fetchUsage.mock.calls.map(([agent]) => agent)).toEqual(['claude', 'codex', 'grok']);
  });
});
