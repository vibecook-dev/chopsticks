import { describe, expect, it } from 'vitest';
import { fetchCodexAccountUsage, normalizeCodexAccountUsage } from './account-usage.js';
import type { Transport } from './app-server-client.js';

const fixture = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    },
    codex_spark: {
      limitId: 'codex_spark',
      limitName: 'Codex Spark',
      primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
      secondary: null,
    },
  },
  rateLimitResetCredits: { availableCount: 2, credits: null },
};

function scriptedTransport(respond: (message: Record<string, unknown>) => unknown): {
  transport: Transport;
  sent: Array<Record<string, unknown>>;
  closed: () => boolean;
} {
  let onMessage: ((message: unknown) => void) | undefined;
  let isClosed = false;
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    closed: () => isClosed,
    transport: {
      send(message) {
        const request = message as Record<string, unknown>;
        sent.push(request);
        if (request.id === undefined) return;
        const reply = respond(request);
        queueMicrotask(() => onMessage?.(reply));
      },
      onMessage(handler) {
        onMessage = handler;
      },
      onClose() {},
      close() {
        isClosed = true;
      },
    },
  };
}

describe('Codex account usage', () => {
  it('normalizes every metered bucket and labels windows by reported duration', () => {
    const snapshot = normalizeCodexAccountUsage(fixture, '2026-07-23T00:00:00.000Z');

    expect(snapshot).toEqual({
      provider: 'codex',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'native-protocol', stability: 'documented' },
      credits: { resetCreditsAvailable: 2 },
      limits: [
        {
          id: 'codex',
          plan: 'plus',
          credits: { balance: '12.50', hasCredits: true, unlimited: false },
          windows: [
            {
              id: 'primary',
              usedPercent: 25,
              durationMinutes: 300,
              resetsAt: '2027-01-15T08:00:00.000Z',
            },
            {
              id: 'secondary',
              usedPercent: 40,
              durationMinutes: 10_080,
              resetsAt: '2027-01-22T08:00:00.000Z',
            },
          ],
        },
        {
          id: 'codex_spark',
          name: 'Codex Spark',
          windows: [
            {
              id: 'primary',
              usedPercent: 7,
              durationMinutes: 10_080,
              resetsAt: '2027-01-22T08:00:00.000Z',
            },
          ],
        },
      ],
    });
  });

  it('falls back to the backward-compatible single bucket and tolerates missing metadata', () => {
    const snapshot = normalizeCodexAccountUsage({
      rateLimits: {
        limitId: null,
        primary: { usedPercent: 6, windowDurationMins: 10_080, resetsAt: null },
        secondary: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    });

    expect(snapshot.limits).toEqual([
      {
        id: 'codex',
        windows: [{ id: 'primary', usedPercent: 6, durationMinutes: 10_080 }],
      },
    ]);
  });

  it('preserves workspace spend-control limits even when rolling windows are absent', () => {
    const snapshot = normalizeCodexAccountUsage(
      {
        rateLimits: {
          limitId: 'workspace',
          limitName: 'Workspace allocation',
          primary: null,
          secondary: null,
          credits: null,
          individualLimit: {
            limit: '100.00',
            used: '80.00',
            remainingPercent: 20,
            resetsAt: 1_800_604_800,
          },
          spendControlReached: true,
          planType: 'team',
          rateLimitReachedType: 'workspace_member_usage_limit_reached',
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
      '2026-07-23T00:00:00.000Z',
    );

    expect(snapshot.scope).toBe('workspace');
    expect(snapshot.limits).toEqual([
      {
        id: 'workspace',
        name: 'Workspace allocation',
        plan: 'team',
        reached: 'workspace_member_usage_limit_reached',
        windows: [],
        budget: {
          limit: '100.00',
          used: '80.00',
          remainingPercent: 20,
          resetsAt: '2027-01-22T08:00:00.000Z',
          reached: true,
        },
      },
    ]);
  });

  it('does not treat bucket metadata without quota data as usable account usage', () => {
    expect(
      normalizeCodexAccountUsage({
        rateLimits: { limitId: 'codex', planType: 'plus', primary: null, secondary: null },
      }).limits,
    ).toEqual([]);
  });

  it('performs initialize then the documented read and closes its one-shot transport', async () => {
    const scripted = scriptedTransport((message) => {
      if (message.method === 'initialize') return { id: message.id, result: {} };
      if (message.method === 'account/rateLimits/read') return { id: message.id, result: fixture };
      throw new Error(`unexpected method: ${String(message.method)}`);
    });

    const result = await fetchCodexAccountUsage({
      transport: scripted.transport,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(result.status).toBe('available');
    expect(scripted.sent.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);
    expect(scripted.closed()).toBe(true);
  });

  it('returns a typed unauthenticated result without exposing the native error body', async () => {
    const scripted = scriptedTransport((message) => ({
      id: message.id,
      ...(message.method === 'initialize'
        ? { result: {} }
        : { error: { code: -32_000, message: 'Login required: secret native detail' } }),
    }));

    await expect(fetchCodexAccountUsage({ transport: scripted.transport })).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'codex',
      message: 'Codex is not authenticated with a supported account',
      retryable: false,
    });
  });

  it('returns a typed configuration failure and closes the transport when client construction fails', async () => {
    const scripted = scriptedTransport(() => {
      throw new Error('request should not be sent');
    });

    await expect(
      fetchCodexAccountUsage({
        transport: scripted.transport,
        requestTimeoutMs: 0,
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'codex',
      message: 'Codex account usage timeout must be positive',
      retryable: false,
    });
    expect(scripted.sent).toEqual([]);
    expect(scripted.closed()).toBe(true);
  });
});
