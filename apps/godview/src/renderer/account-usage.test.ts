import { describe, expect, it } from 'vitest';
import type { AccountUsageFetchResult } from '@vibecook/chopsticks-core';
import type { AgentAccountUsage } from '../protocol.js';
import { formatUsageReset, providerAccountUsageView } from './account-usage.js';

const NOW = Date.parse('2026-07-23T20:00:00.000Z');

function entry(agent: AgentAccountUsage['agent'], result: AccountUsageFetchResult): AgentAccountUsage {
  return { agent, result };
}

describe('account usage display model', () => {
  it('prioritizes Claude five-hour, weekly, and model-specific windows', () => {
    const view = providerAccountUsageView(
      'claude',
      entry('claude', {
        status: 'available',
        snapshot: {
          provider: 'claude',
          fetchedAt: '2026-07-23T20:00:00.000Z',
          scope: 'subscription',
          source: { kind: 'oauth-endpoint', stability: 'experimental' },
          limits: [
            {
              id: 'claude-subscription',
              windows: [
                {
                  id: 'seven_day_opus',
                  durationMinutes: 10_080,
                  usedPercent: 56,
                  resetsAt: '2026-07-25T20:00:00.000Z',
                },
                {
                  id: 'seven_day',
                  durationMinutes: 10_080,
                  usedPercent: 34,
                  resetsAt: '2026-07-26T20:00:00.000Z',
                },
                {
                  id: 'five_hour',
                  durationMinutes: 300,
                  usedPercent: 12.5,
                  resetsAt: '2026-07-23T21:30:00.000Z',
                },
              ],
            },
          ],
        },
      }),
      NOW,
    );

    expect(view.metrics.map(({ label, value, resetLabel }) => ({ label, value, resetLabel }))).toEqual([
      { label: '5H', value: '13%', resetLabel: '1h 30m' },
      { label: '7D', value: '34%', resetLabel: '3d' },
      { label: 'OPUS', value: '56%', resetLabel: '2d' },
    ]);
  });

  it('distinguishes Codex weekly buckets and fills an allocation-only account', () => {
    const view = providerAccountUsageView(
      'codex',
      entry('codex', {
        status: 'available',
        snapshot: {
          provider: 'codex',
          fetchedAt: '2026-07-23T20:00:00.000Z',
          scope: 'workspace',
          source: { kind: 'native-protocol', stability: 'documented' },
          limits: [
            {
              id: 'codex_spark',
              name: 'GPT-5.3-Codex-Spark',
              windows: [{ id: 'primary', durationMinutes: 10_080, usedPercent: 7 }],
            },
            {
              id: 'codex',
              windows: [
                { id: 'primary', durationMinutes: 300, usedPercent: 18 },
                { id: 'secondary', durationMinutes: 10_080, usedPercent: 42 },
              ],
            },
          ],
        },
      }),
      NOW,
    );
    expect(view.metrics.map((metric) => metric.label)).toEqual(['5H', '7D', 'SPARK']);

    const budget = providerAccountUsageView(
      'codex',
      entry('codex', {
        status: 'available',
        snapshot: {
          provider: 'codex',
          fetchedAt: '2026-07-23T20:00:00.000Z',
          scope: 'workspace',
          source: { kind: 'native-protocol', stability: 'documented' },
          limits: [
            {
              id: 'workspace',
              name: 'Workspace allocation',
              windows: [],
              budget: { remainingPercent: 20 },
            },
          ],
        },
      }),
      NOW,
    );
    expect(budget.metrics[0]).toMatchObject({ label: 'BUDGET', usedPercent: 80, value: '80%' });
  });

  it('shows actionable failure states without leaking adapter messages', () => {
    const unsupported = providerAccountUsageView(
      'grok',
      entry('grok', {
        status: 'unsupported',
        provider: 'grok',
        message: 'private implementation detail',
        retryable: false,
      }),
      NOW,
    );
    expect(unsupported).toMatchObject({ state: 'unsupported', statusText: 'WEEKLY · NOT EXPOSED' });

    const unauthenticated = providerAccountUsageView(
      'claude',
      entry('claude', {
        status: 'unauthenticated',
        provider: 'claude',
        message: 'private credential path',
        retryable: false,
      }),
      NOW,
    );
    expect(unauthenticated.statusText).toBe('SIGN IN REQUIRED');
    expect(JSON.stringify(unauthenticated)).not.toContain('private');

    const rateLimited = providerAccountUsageView(
      'claude',
      entry('claude', {
        status: 'unavailable',
        provider: 'claude',
        message: 'Claude account usage request failed with HTTP 429',
        retryable: true,
        code: 'rate-limited',
        retryAt: '2026-07-23T20:47:00.000Z',
      }),
      NOW,
    );
    expect(rateLimited).toMatchObject({ state: 'rate-limited', statusText: 'RATE LIMITED · 47m' });
  });

  it('keeps stale metrics visible while a provider is rate-limited', () => {
    const stale = providerAccountUsageView(
      'claude',
      {
        agent: 'claude',
        stale: true,
        result: {
          status: 'available',
          snapshot: {
            provider: 'claude',
            fetchedAt: '2026-07-23T19:55:00.000Z',
            scope: 'subscription',
            source: { kind: 'oauth-endpoint', stability: 'experimental' },
            limits: [
              {
                id: 'claude-subscription',
                windows: [{ id: 'five_hour', durationMinutes: 300, usedPercent: 25 }],
              },
            ],
          },
        },
        refreshFailure: {
          status: 'unavailable',
          provider: 'claude',
          message: 'Claude account usage request failed with HTTP 429',
          retryable: true,
          code: 'rate-limited',
          retryAt: '2026-07-23T20:47:00.000Z',
        },
      },
      NOW,
    );

    expect(stale).toMatchObject({
      state: 'rate-limited',
      badgeText: 'RATE LIMITED',
      badgeTitle: 'Retrying in 47m',
      metrics: [{ label: '5H', value: '25%' }],
    });
  });

  it('formats reset countdowns compactly', () => {
    expect(formatUsageReset('2026-07-23T20:00:30.000Z', NOW)).toBe('1m');
    expect(formatUsageReset('2026-07-24T21:00:00.000Z', NOW)).toBe('1d 1h');
    expect(formatUsageReset('invalid', NOW)).toBeUndefined();
  });
});
