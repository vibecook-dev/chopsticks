import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AccountUsageBudget,
  AccountUsageFetchResult,
  AccountUsageLimit,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from '@vibecook/chopsticks-core';

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

const execFileAsync = promisify(execFile);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const part of path) {
    value = rec(value)?.[part];
  }
  return value;
}

/** Find a Claude Code OAuth access token in known credential layouts. */
export function findClaudeAccessToken(value: unknown): string | undefined {
  const preferred = [
    ['claudeAiOauth', 'accessToken'],
    ['claudeAiOauth', 'access_token'],
    ['oauth', 'accessToken'],
    ['oauth', 'access_token'],
    ['accessToken'],
    ['access_token'],
    ['oauth_access_token'],
  ] as const;
  for (const path of preferred) {
    const token = valueAt(value, path);
    if (typeof token === 'string' && token.trim()) return token.trim();
  }

  const accepted = new Set(['accessToken', 'access_token', 'oauth_access_token']);
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = rec(queue.shift());
    if (!current) continue;
    for (const [key, child] of Object.entries(current)) {
      if (accepted.has(key) && typeof child === 'string' && child.trim()) return child.trim();
      if (rec(child)) queue.push(child);
    }
  }
  return undefined;
}

function defaultCredentialsPath(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.split(',')
    .map((part) => part.trim())
    .find(Boolean);
  const directory =
    configured === '~' ? homedir() : configured?.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  return join(directory || join(homedir(), '.claude'), '.credentials.json');
}

async function defaultKeychainPayload(): Promise<string> {
  const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

export interface ClaudeCredentialOptions {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  /** Defaults to true on macOS after file lookup fails. */
  useKeychain?: boolean;
  readKeychainPayload?: () => Promise<string>;
}

/**
 * Resolve Claude Code's OAuth token without returning its credential document.
 * All lookup failures collapse to `undefined`; callers surface unauthenticated.
 */
export async function resolveClaudeAccessToken(options: ClaudeCredentialOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_ACCESS_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  try {
    const configuredPath =
      options.credentialsPath === '~'
        ? homedir()
        : options.credentialsPath?.startsWith('~/')
          ? join(homedir(), options.credentialsPath.slice(2))
          : options.credentialsPath;
    const raw = await readFile(configuredPath ?? defaultCredentialsPath(env), 'utf8');
    const token = findClaudeAccessToken(JSON.parse(raw));
    if (token) return token;
  } catch {
    // Claude installations vary between file and Keychain storage.
  }

  if (!(options.useKeychain ?? process.platform === 'darwin')) return undefined;
  try {
    const raw = await (options.readKeychainPayload ?? defaultKeychainPayload)();
    return findClaudeAccessToken(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function isoTimestamp(value: unknown): string | undefined {
  let millis: number | undefined;
  const numeric = finite(value);
  if (numeric !== undefined && numeric >= 0) {
    millis = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  } else if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) millis = parsed;
  }
  if (millis === undefined) return undefined;
  const date = new Date(millis);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function retryAtFromHeader(value: string | null, now: Date): string | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  const millis =
    Number.isFinite(seconds) && seconds >= 0 ? now.valueOf() + seconds * 1_000 : Date.parse(header);
  if (!Number.isFinite(millis)) return undefined;
  return new Date(millis).toISOString();
}

function firstFinite(window: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finite(window[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(window: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = window[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstBoolean(window: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = window[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function firstScalar(window: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = window[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstTimestamp(window: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = isoTimestamp(window[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function windowLabel(id: string): string {
  if (id === 'five_hour') return '5-hour';
  if (id === 'seven_day') return '7-day';
  if (id === 'cinder_cove') return 'Fable 5';
  if (id === 'extra_usage') return 'Usage credits';
  if (id === 'overage') return 'Overage';
  if (id.startsWith('seven_day_')) return `7-day ${id.slice('seven_day_'.length).replaceAll('_', ' ')}`;
  return id.replaceAll('_', ' ');
}

function windowDurationMinutes(id: string): number | undefined {
  if (id === 'five_hour') return 300;
  if (id === 'seven_day' || id.startsWith('seven_day_')) return 10_080;
  return undefined;
}

function normalizeWindow(id: string, value: unknown): AccountUsageWindow | undefined {
  const window = rec(value);
  if (!window) return undefined;
  const usedPercent = firstFinite(window, [
    'utilization',
    'used_percentage',
    'usage_percentage',
    'percentage',
    'percent',
  ]);
  const resetsAt = firstTimestamp(window, ['resets_at', 'reset_at', 'reset_time', 'expires_at', 'expiry']);
  if ((usedPercent === undefined || usedPercent < 0) && resetsAt === undefined) return undefined;
  const durationMinutes = windowDurationMinutes(id);
  return {
    id,
    label: windowLabel(id),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(usedPercent !== undefined && usedPercent >= 0 ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function normalizeBudget(value: unknown): AccountUsageBudget | undefined {
  const budget = rec(value);
  if (!budget) return undefined;
  const limit = firstScalar(budget, ['monthly_limit', 'limit', 'allowed', 'quota']);
  const used = firstScalar(budget, ['used_credits', 'used', 'usage', 'consumed']);
  const reportedRemainingPercent = firstFinite(budget, ['remaining_percentage', 'remaining_percent']);
  const remainingPercent =
    reportedRemainingPercent !== undefined && reportedRemainingPercent >= 0 ? reportedRemainingPercent : undefined;
  const resetsAt = firstTimestamp(budget, [
    'resets_at',
    'reset_at',
    'reset_time',
    'overage_resets_at',
    'expires_at',
    'expiry',
  ]);
  const reached = firstBoolean(budget, ['reached', 'is_exhausted', 'out_of_credits', 'limit_reached']);
  if (
    limit === undefined &&
    used === undefined &&
    remainingPercent === undefined &&
    resetsAt === undefined &&
    reached === undefined
  ) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(reached !== undefined ? { reached } : {}),
  };
}

function hasBudgetState(value: unknown): boolean {
  const budget = rec(value);
  if (!budget) return false;
  return (
    firstScalar(budget, ['monthly_limit', 'limit', 'allowed', 'quota', 'used_credits', 'used', 'usage', 'consumed']) !==
      undefined ||
    firstFinite(budget, ['remaining_percentage', 'remaining_percent']) !== undefined ||
    firstBoolean(budget, ['reached', 'is_exhausted', 'out_of_credits', 'limit_reached']) !== undefined
  );
}

function normalizeAuxiliaryLimit(id: string, value: unknown): AccountUsageLimit | undefined {
  const limit = rec(value);
  if (!limit) return undefined;
  const window = normalizeWindow(id, limit);
  const budget = normalizeBudget(limit);
  const enabled = firstBoolean(limit, ['is_enabled', 'enabled']);
  const status = firstString(limit, ['status', 'state', 'disabled_reason', 'overage_disabled_reason']);
  if (!window && !budget && enabled === undefined && status === undefined) return undefined;
  const name = firstString(limit, ['display_name', 'label', 'name']) ?? windowLabel(id);
  return {
    id,
    name,
    windows: window?.usedPercent !== undefined ? [window] : [],
    ...(enabled !== undefined ? { enabled } : {}),
    ...(status ? { status } : {}),
    ...(budget ? { budget } : {}),
  };
}

function limitEntryId(value: unknown, fallback: string): string {
  const limit = rec(value);
  if (!limit) return fallback;
  return firstString(limit, ['id', 'type', 'rate_limit_type', 'key']) ?? fallback;
}

/** Normalize Claude's experimental OAuth usage response, including optional and future quota families. */
export function normalizeClaudeAccountUsage(
  value: unknown,
  fetchedAt = new Date().toISOString(),
): AccountUsageSnapshot {
  const response = rec(value) ?? {};
  const windows = new Map<string, AccountUsageWindow>();
  const auxiliaryLimits = new Map<string, AccountUsageLimit>();

  const addWindow = (id: string, candidate: unknown): void => {
    const window = normalizeWindow(id, candidate);
    if (window && !auxiliaryLimits.has(id)) windows.set(id, window);
  };
  const addAuxiliary = (id: string, candidate: unknown): boolean => {
    const limit = normalizeAuxiliaryLimit(id, candidate);
    if (!limit) return false;
    windows.delete(id);
    auxiliaryLimits.set(id, limit);
    return true;
  };
  const addStructuredEntry = (id: string, candidate: unknown): void => {
    const normalizedId = limitEntryId(candidate, id);
    const record = rec(candidate);
    const hasAuxiliaryState =
      hasBudgetState(record) ||
      firstBoolean(record ?? {}, ['is_enabled', 'enabled']) !== undefined ||
      firstString(record ?? {}, ['status', 'state', 'disabled_reason', 'overage_disabled_reason']) !== undefined;
    if (hasAuxiliaryState && addAuxiliary(normalizedId, candidate)) return;
    addWindow(normalizedId, candidate);
  };

  for (const [id, candidate] of Object.entries(response)) {
    if (id === 'extra_usage' || id === 'overage') {
      addAuxiliary(id, candidate);
      continue;
    }
    if (id !== 'rate_limits' && id !== 'limits') addWindow(id, candidate);
  }

  const rateLimits = rec(response.rate_limits);
  if (rateLimits) {
    for (const [id, candidate] of Object.entries(rateLimits)) addWindow(id, candidate);
  }

  const limits = response.limits;
  if (Array.isArray(limits)) {
    limits.forEach((candidate, index) => addStructuredEntry(`limit_${index + 1}`, candidate));
  } else {
    const limitMap = rec(limits);
    if (limitMap) {
      const isSingleLimit =
        normalizeWindow('limits', limitMap) !== undefined ||
        normalizeBudget(limitMap) !== undefined ||
        firstBoolean(limitMap, ['is_enabled', 'enabled']) !== undefined;
      if (isSingleLimit) addStructuredEntry('limits', limitMap);
      else {
        for (const [id, candidate] of Object.entries(limitMap)) addStructuredEntry(id, candidate);
      }
    }
  }

  const normalizedLimits: AccountUsageLimit[] = [];
  if (windows.size > 0) {
    normalizedLimits.push({
      id: 'claude-subscription',
      windows: [...windows.values()],
    });
  }
  normalizedLimits.push(...auxiliaryLimits.values());

  return {
    provider: 'claude',
    fetchedAt,
    scope: 'subscription',
    source: { kind: 'oauth-endpoint', stability: 'experimental' },
    limits: normalizedLimits,
  };
}

export interface FetchClaudeAccountUsageOptions {
  timeoutMs?: number;
}

/** @internal Dependency-injection surface for adapter tests; intentionally omitted from the package barrel. */
export interface FetchClaudeAccountUsageDependencies extends FetchClaudeAccountUsageOptions, ClaudeCredentialOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  resolveAccessToken?: () => Promise<string | undefined>;
  now?: () => Date;
}

/** @internal Use `fetchClaudeAccountUsage` outside adapter tests. */
export async function fetchClaudeAccountUsageWithDependencies(
  options: FetchClaudeAccountUsageDependencies = {},
): Promise<AccountUsageFetchResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude account usage timeout must be positive',
      retryable: false,
    };
  }

  let token: string | undefined;
  try {
    token = await (options.resolveAccessToken ? options.resolveAccessToken() : resolveClaudeAccessToken(options));
  } catch {
    return {
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude Code OAuth credentials could not be read',
      retryable: true,
    };
  }
  if (!token) {
    return {
      status: 'unauthenticated',
      provider: 'claude',
      message: 'Claude Code OAuth credentials were not found',
      retryable: false,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? CLAUDE_USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'unauthenticated',
        provider: 'claude',
        message: 'Claude Code OAuth credentials were rejected',
        retryable: false,
      };
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAt = retryable
        ? retryAtFromHeader(response.headers.get('retry-after'), (options.now ?? (() => new Date()))())
        : undefined;
      return {
        status: 'unavailable',
        provider: 'claude',
        message: `Claude account usage request failed with HTTP ${response.status}`,
        retryable,
        ...(response.status === 429 ? { code: 'rate-limited' as const } : {}),
        ...(retryAt ? { retryAt } : {}),
      };
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        status: 'unavailable',
        provider: 'claude',
        message: 'Claude account usage returned invalid JSON',
        retryable: true,
      };
    }
    const snapshot = normalizeClaudeAccountUsage(body, (options.now ?? (() => new Date()))().toISOString());
    if (snapshot.limits.length === 0) {
      return {
        status: 'unavailable',
        provider: 'claude',
        message: 'Claude returned no recognized account usage limits',
        retryable: true,
      };
    }
    return { status: 'available', snapshot };
  } catch {
    return {
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude account usage request could not be completed',
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch Claude account quota data without exposing credential-bearing dependency seams. */
export async function fetchClaudeAccountUsage(
  options: FetchClaudeAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  return fetchClaudeAccountUsageWithDependencies({
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
