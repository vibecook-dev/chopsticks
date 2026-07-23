import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_OAUTH_BETA,
  CLAUDE_USAGE_ENDPOINT,
  fetchClaudeAccountUsageWithDependencies,
  findClaudeAccessToken,
  normalizeClaudeAccountUsage,
  resolveClaudeAccessToken,
} from './account-usage.js';
import * as publicApi from './index.js';

describe('Claude account usage', () => {
  it('finds tokens in current and fallback credential layouts', () => {
    expect(findClaudeAccessToken({ claudeAiOauth: { accessToken: ' current-token ' } })).toBe('current-token');
    expect(findClaudeAccessToken({ nested: { access_token: 'fallback-token' } })).toBe('fallback-token');
    expect(findClaudeAccessToken({ apiKey: 'not-an-oauth-token' })).toBeUndefined();
  });

  it('prefers an environment token without consulting Keychain', async () => {
    const readKeychainPayload = vi.fn(async () => JSON.stringify({ accessToken: 'keychain-token' }));
    await expect(
      resolveClaudeAccessToken({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
        readKeychainPayload,
      }),
    ).resolves.toBe('env-token');
    expect(readKeychainPayload).not.toHaveBeenCalled();
  });

  it('reads file credentials and falls back to an injected Keychain reader', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-claude-credentials-'));
    const credentialsPath = join(directory, '.credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }), 'utf8');

    await expect(
      resolveClaudeAccessToken({
        env: {},
        credentialsPath,
        useKeychain: false,
      }),
    ).resolves.toBe('file-token');

    await expect(
      resolveClaudeAccessToken({
        env: {},
        credentialsPath: join(directory, 'missing.json'),
        useKeychain: true,
        readKeychainPayload: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }),
      }),
    ).resolves.toBe('keychain-token');
  });

  it('normalizes five-hour, weekly, and model-specific weekly windows', () => {
    const snapshot = normalizeClaudeAccountUsage(
      {
        five_hour: { utilization: 12.5, resets_at: 1_800_000_000 },
        rate_limits: {
          seven_day: { used_percentage: 34, resets_at: '2027-01-22T08:00:00Z' },
          seven_day_opus: { utilization: 56, resets_at: 1_800_604_800 },
          unrelated: { note: 'not a quota window' },
        },
      },
      '2026-07-23T00:00:00.000Z',
    );

    expect(snapshot).toEqual({
      provider: 'claude',
      fetchedAt: '2026-07-23T00:00:00.000Z',
      scope: 'subscription',
      source: { kind: 'oauth-endpoint', stability: 'experimental' },
      limits: [
        {
          id: 'claude-subscription',
          windows: [
            {
              id: 'five_hour',
              label: '5-hour',
              durationMinutes: 300,
              usedPercent: 12.5,
              resetsAt: '2027-01-15T08:00:00.000Z',
            },
            {
              id: 'seven_day',
              label: '7-day',
              durationMinutes: 10_080,
              usedPercent: 34,
              resetsAt: '2027-01-22T08:00:00.000Z',
            },
            {
              id: 'seven_day_opus',
              label: '7-day opus',
              durationMinutes: 10_080,
              usedPercent: 56,
              resetsAt: '2027-01-22T08:00:00.000Z',
            },
          ],
        },
      ],
    });
  });

  it('preserves current optional, overage, and structured credit limits', () => {
    const snapshot = normalizeClaudeAccountUsage(
      {
        five_hour: { utilization: 12, resets_at: 1_800_000_000 },
        cinder_cove: { utilization: 22, resets_at: 1_800_604_800 },
        extra_usage: {
          is_enabled: true,
          state: 'enabled',
          monthly_limit: '100.00',
          used_credits: '25.00',
          utilization: 25,
          resets_at: 1_800_604_800,
        },
        limits: [
          {
            id: 'cowork_credit',
            name: 'Claude Code and Cowork credit',
            limit: '50.00',
            used: '10.00',
            remaining_percent: 80,
            expires_at: 1_800_604_800,
          },
        ],
      },
      '2026-07-23T00:00:00.000Z',
    );

    expect(snapshot.limits).toEqual([
      {
        id: 'claude-subscription',
        windows: [
          {
            id: 'five_hour',
            label: '5-hour',
            durationMinutes: 300,
            usedPercent: 12,
            resetsAt: '2027-01-15T08:00:00.000Z',
          },
          {
            id: 'cinder_cove',
            label: 'Fable 5',
            usedPercent: 22,
            resetsAt: '2027-01-22T08:00:00.000Z',
          },
        ],
      },
      {
        id: 'extra_usage',
        name: 'Usage credits',
        enabled: true,
        status: 'enabled',
        windows: [
          {
            id: 'extra_usage',
            label: 'Usage credits',
            usedPercent: 25,
            resetsAt: '2027-01-22T08:00:00.000Z',
          },
        ],
        budget: {
          limit: '100.00',
          used: '25.00',
          resetsAt: '2027-01-22T08:00:00.000Z',
        },
      },
      {
        id: 'cowork_credit',
        name: 'Claude Code and Cowork credit',
        windows: [],
        budget: {
          limit: '50.00',
          used: '10.00',
          remainingPercent: 80,
          resetsAt: '2027-01-22T08:00:00.000Z',
        },
      },
    ]);
  });

  it('does not publish credential resolvers or dependency-injection hooks', () => {
    expect(publicApi).not.toHaveProperty('findClaudeAccessToken');
    expect(publicApi).not.toHaveProperty('resolveClaudeAccessToken');
    expect(publicApi).not.toHaveProperty('fetchClaudeAccountUsageWithDependencies');
  });

  it('sends the required OAuth headers and never returns the credential', async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = url;
      requestInit = init;
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: 1_800_000_000 },
          seven_day: { utilization: 20, resets_at: 1_800_604_800 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await fetchClaudeAccountUsageWithDependencies({
      resolveAccessToken: async () => 'super-secret-token',
      fetchImpl,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(requestUrl).toBe(CLAUDE_USAGE_ENDPOINT);
    expect(new Headers(requestInit?.headers).get('authorization')).toBe('Bearer super-secret-token');
    expect(new Headers(requestInit?.headers).get('anthropic-beta')).toBe(CLAUDE_OAUTH_BETA);
    expect(result.status).toBe('available');
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('returns typed auth and transient failures', async () => {
    await expect(
      fetchClaudeAccountUsageWithDependencies({ resolveAccessToken: async () => undefined }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'claude',
      message: 'Claude Code OAuth credentials were not found',
      retryable: false,
    });

    await expect(
      fetchClaudeAccountUsageWithDependencies({
        resolveAccessToken: async () => 'expired',
        fetchImpl: vi.fn(async () => new Response('', { status: 401 })) as typeof fetch,
      }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      provider: 'claude',
      message: 'Claude Code OAuth credentials were rejected',
      retryable: false,
    });

    await expect(
      fetchClaudeAccountUsageWithDependencies({
        resolveAccessToken: async () => 'valid',
        fetchImpl: vi.fn(
          async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
        ) as typeof fetch,
        now: () => new Date('2026-07-23T20:00:00.000Z'),
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude account usage request failed with HTTP 429',
      retryable: true,
      code: 'rate-limited',
      retryAt: '2026-07-23T20:02:00.000Z',
    });
  });

  it('returns unavailable for a successful but unrecognized payload', async () => {
    await expect(
      fetchClaudeAccountUsageWithDependencies({
        resolveAccessToken: async () => 'valid',
        fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude returned no recognized account usage limits',
      retryable: true,
    });
  });
});
