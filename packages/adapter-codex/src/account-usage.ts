import type {
  AccountUsageBudget,
  AccountUsageCredits,
  AccountUsageFetchResult,
  AccountUsageLimit,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from '@vibecook/chopsticks-core';
import { AppServerClient, AppServerError, spawnAppServerTransport, type Transport } from './app-server-client.js';

const CLIENT_INFO = { name: 'chopsticks-account-usage', version: '0.1.3' } as const; // x-release-please-version

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function unixSecondsIso(value: unknown): string | undefined {
  const seconds = finite(value);
  if (seconds === undefined || seconds < 0) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function normalizeWindow(id: 'primary' | 'secondary', value: unknown): AccountUsageWindow | undefined {
  const window = rec(value);
  if (!window) return undefined;
  const usedPercent = finite(window.usedPercent);
  if (usedPercent === undefined || usedPercent < 0) return undefined;

  const duration = finite(window.windowDurationMins);
  const resetsAt = unixSecondsIso(window.resetsAt);
  return {
    id,
    usedPercent,
    ...(duration !== undefined && duration > 0 ? { durationMinutes: duration } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function normalizeCredits(value: unknown): AccountUsageCredits | undefined {
  const credits = rec(value);
  if (!credits) return undefined;
  const balance = str(credits.balance);
  const hasCredits = typeof credits.hasCredits === 'boolean' ? credits.hasCredits : undefined;
  const unlimited = typeof credits.unlimited === 'boolean' ? credits.unlimited : undefined;
  if (balance === undefined && hasCredits === undefined && unlimited === undefined) return undefined;
  return {
    ...(balance !== undefined ? { balance } : {}),
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
  };
}

function normalizeBudget(value: unknown, reachedValue: unknown): AccountUsageBudget | undefined {
  const budget = rec(value);
  const limit = str(budget?.limit);
  const used = str(budget?.used);
  const reportedRemainingPercent = finite(budget?.remainingPercent);
  const remainingPercent =
    reportedRemainingPercent !== undefined && reportedRemainingPercent >= 0 ? reportedRemainingPercent : undefined;
  const resetsAt = unixSecondsIso(budget?.resetsAt);
  const reached = typeof reachedValue === 'boolean' ? reachedValue : undefined;
  const hasBudgetValues =
    limit !== undefined || used !== undefined || remainingPercent !== undefined || resetsAt !== undefined;
  if (!hasBudgetValues && reached !== true) return undefined;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(reached !== undefined ? { reached } : {}),
  };
}

function normalizeLimit(fallbackId: string, value: unknown): AccountUsageLimit | undefined {
  const limit = rec(value);
  if (!limit) return undefined;
  const id = str(limit.limitId) ?? fallbackId;
  const windows = [normalizeWindow('primary', limit.primary), normalizeWindow('secondary', limit.secondary)].filter(
    (window): window is AccountUsageWindow => window !== undefined,
  );

  const credits = normalizeCredits(limit.credits);
  const budget = normalizeBudget(limit.individualLimit, limit.spendControlReached);
  const name = str(limit.limitName);
  const plan = str(limit.planType);
  const reached = str(limit.rateLimitReachedType);
  if (windows.length === 0 && !credits && !budget && !reached) return undefined;
  return {
    id,
    windows,
    ...(name ? { name } : {}),
    ...(plan ? { plan } : {}),
    ...(reached ? { reached } : {}),
    ...(credits ? { credits } : {}),
    ...(budget ? { budget } : {}),
  };
}

/** Normalize the documented `account/rateLimits/read` response. */
export function normalizeCodexAccountUsage(value: unknown, fetchedAt = new Date().toISOString()): AccountUsageSnapshot {
  const response = rec(value) ?? {};
  const byId = rec(response.rateLimitsByLimitId);
  const candidates =
    byId && Object.keys(byId).length > 0 ? Object.entries(byId) : [['codex', response.rateLimits] as const];
  const limits = candidates
    .map(([id, limit]) => normalizeLimit(id, limit))
    .filter((limit): limit is AccountUsageLimit => limit !== undefined);

  const resetCredits = rec(response.rateLimitResetCredits);
  const resetCreditsAvailable = finite(resetCredits?.availableCount);
  const credits =
    resetCreditsAvailable !== undefined && resetCreditsAvailable >= 0 ? { resetCreditsAvailable } : undefined;

  return {
    provider: 'codex',
    fetchedAt,
    scope: limits.some((limit) => limit.budget || limit.reached?.startsWith('workspace_'))
      ? 'workspace'
      : 'subscription',
    source: { kind: 'native-protocol', stability: 'documented' },
    limits,
    ...(credits ? { credits } : {}),
  };
}

export interface FetchCodexAccountUsageOptions {
  /** One-shot transport override for tests or embedded app-server routing. It is closed after the fetch. */
  transport?: Transport;
  executable?: string;
  requestTimeoutMs?: number;
  now?: () => Date;
}

function codexFailure(error: unknown): AccountUsageFetchResult {
  if (error instanceof RangeError && /timeout/i.test(error.message)) {
    return {
      status: 'unavailable',
      provider: 'codex',
      message: 'Codex account usage timeout must be positive',
      retryable: false,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const unauthenticated =
    (error instanceof AppServerError || error instanceof Error) &&
    /(auth|unauthori[sz]ed|not logged in|login required|credential)/i.test(message);
  return {
    status: unauthenticated ? 'unauthenticated' : 'unavailable',
    provider: 'codex',
    message: unauthenticated
      ? 'Codex is not authenticated with a supported account'
      : 'Codex account usage is unavailable',
    retryable: !unauthenticated,
  };
}

/** Fetch account-wide Codex quota data through the documented app-server API. */
export async function fetchCodexAccountUsage(
  options: FetchCodexAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
  ) {
    options.transport?.close();
    return codexFailure(new RangeError('app-server request timeout must be positive'));
  }

  let transport: Transport | undefined;
  let client: AppServerClient | undefined;
  try {
    transport =
      options.transport ??
      spawnAppServerTransport({
        executable: options.executable,
      });
    client = new AppServerClient(transport, { requestTimeoutMs: options.requestTimeoutMs });
    await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
    client.notify('initialized');
    const response = await client.request('account/rateLimits/read');
    const snapshot = normalizeCodexAccountUsage(response, (options.now ?? (() => new Date()))().toISOString());
    if (snapshot.limits.length === 0) {
      return {
        status: 'unavailable',
        provider: 'codex',
        message: 'Codex returned no account rate-limit buckets',
        retryable: true,
      };
    }
    return { status: 'available', snapshot };
  } catch (error) {
    return codexFailure(error);
  } finally {
    if (client) client.close();
    else transport?.close();
  }
}
