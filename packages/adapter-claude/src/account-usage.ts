import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AccountUsageAvailable,
  AccountUsageBudget,
  AccountUsageFetchResult,
  AccountUsageLimit,
  AccountUsageSnapshot,
  AccountUsageSource,
  AccountUsageWindow,
} from '@vibecook/chopsticks-core';

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** Claude Code's public OAuth client id (embedded in the official CLI). */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Older Claude Code installs used `unknown`; current installs use the macOS username. */
const KEYCHAIN_ACCOUNT_FALLBACKS = ['unknown'] as const;
/** Refresh slightly before the stored expiry so we never ship a near-dead access token. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

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

function findClaudeRefreshToken(value: unknown): string | undefined {
  const preferred = [
    ['claudeAiOauth', 'refreshToken'],
    ['claudeAiOauth', 'refresh_token'],
    ['oauth', 'refreshToken'],
    ['oauth', 'refresh_token'],
    ['refreshToken'],
    ['refresh_token'],
  ] as const;
  for (const path of preferred) {
    const token = valueAt(value, path);
    if (typeof token === 'string' && token.trim()) return token.trim();
  }
  return undefined;
}

function findClaudeAccessTokenExpiresAt(value: unknown): number | undefined {
  const preferred = [
    ['claudeAiOauth', 'expiresAt'],
    ['claudeAiOauth', 'expires_at'],
    ['oauth', 'expiresAt'],
    ['oauth', 'expires_at'],
    ['expiresAt'],
    ['expires_at'],
  ] as const;
  for (const path of preferred) {
    const raw = valueAt(value, path);
    const numeric = finite(raw);
    if (numeric !== undefined && numeric >= 0) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
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

function resolveCredentialsPath(options: ClaudeCredentialOptions): string {
  const env = options.env ?? process.env;
  const configuredPath =
    options.credentialsPath === '~'
      ? homedir()
      : options.credentialsPath?.startsWith('~/')
        ? join(homedir(), options.credentialsPath.slice(2))
        : options.credentialsPath;
  return configuredPath ?? defaultCredentialsPath(env);
}

function keychainAccountCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const preferred = [env.USER, env.LOGNAME, env.USERNAME]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set([...preferred, ...KEYCHAIN_ACCOUNT_FALLBACKS])];
}

async function readKeychainPayloadForAccount(account: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    { timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  return stdout;
}

/**
 * Claude Code may store multiple credential items under the same service name
 * (current installs use the macOS username; older ones used `unknown`). Prefer
 * the freshest document that still contains an access token.
 */
async function defaultKeychainPayload(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ payload: string; account?: string }> {
  let best:
    | {
        payload: string;
        account?: string;
        expiresAt: number;
        rank: number;
      }
    | undefined;

  const consider = (payload: string, account: string | undefined, rank: number): void => {
    if (!payload.trim()) return;
    let document: Record<string, unknown> | undefined;
    try {
      document = rec(JSON.parse(payload));
    } catch {
      return;
    }
    if (!document || !findClaudeAccessToken(document)) return;
    const expiresAt = findClaudeAccessTokenExpiresAt(document) ?? Number.NEGATIVE_INFINITY;
    if (
      !best ||
      expiresAt > best.expiresAt ||
      (expiresAt === best.expiresAt && rank < best.rank)
    ) {
      best = { payload, ...(account ? { account } : {}), expiresAt, rank };
    }
  };

  let rank = 0;
  for (const account of keychainAccountCandidates(env)) {
    try {
      consider(await readKeychainPayloadForAccount(account), account, rank++);
    } catch {
      // Try the next account.
    }
  }
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    consider(stdout, undefined, rank + 100);
  } catch {
    // No unscoped item.
  }

  if (!best) throw new Error('Claude Code credentials were not found in the Keychain');
  return { payload: best.payload, ...(best.account ? { account: best.account } : {}) };
}

async function defaultWriteKeychainPayload(payload: string, account = 'unknown'): Promise<void> {
  await execFileAsync(
    'security',
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', payload],
    { timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
}

export interface ClaudeCredentialOptions {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  /** Defaults to true on macOS after file lookup fails. */
  useKeychain?: boolean;
  /** @returns raw JSON and optional Keychain account used for a later write-back. */
  readKeychainPayload?: () => Promise<string | { payload: string; account?: string }>;
  /** Persist refreshed tokens so Claude Code and chopsticks share one credential store. */
  writeKeychainPayload?: (payload: string, account?: string) => Promise<void>;
  writeCredentialsFile?: (path: string, payload: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Force a refresh even when the access token still looks fresh. */
  forceRefresh?: boolean;
}

type CredentialStore =
  | { kind: 'file'; path: string; document: Record<string, unknown> }
  | { kind: 'keychain'; document: Record<string, unknown>; account?: string };

function accessTokenIsFresh(expiresAt: number | undefined, nowMs: number): boolean {
  if (expiresAt === undefined) return true;
  return expiresAt > nowMs + TOKEN_EXPIRY_SKEW_MS;
}

function applyRefreshedTokens(
  document: Record<string, unknown>,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    refreshTokenExpiresAt?: number;
  },
): Record<string, unknown> {
  const next = { ...document };
  const existing = rec(next.claudeAiOauth) ?? rec(next.oauth) ?? {};
  const updated = {
    ...existing,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.refreshTokenExpiresAt !== undefined
      ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt }
      : {}),
  };
  if (rec(next.claudeAiOauth) || !rec(next.oauth)) next.claudeAiOauth = updated;
  else next.oauth = updated;
  return next;
}

async function loadClaudeCredentialStore(options: ClaudeCredentialOptions): Promise<CredentialStore | undefined> {
  const env = options.env ?? process.env;
  try {
    const path = resolveCredentialsPath(options);
    const raw = await readFile(path, 'utf8');
    const document = rec(JSON.parse(raw));
    if (document && findClaudeAccessToken(document)) return { kind: 'file', path, document };
  } catch {
    // Fall through to Keychain.
  }

  if (!(options.useKeychain ?? process.platform === 'darwin')) return undefined;
  try {
    const read = options.readKeychainPayload ?? ((() => defaultKeychainPayload(options.env ?? process.env)) as () => Promise<
      string | { payload: string; account?: string }
    >);
    const loaded = await read();
    const payload = typeof loaded === 'string' ? loaded : loaded.payload;
    const account = typeof loaded === 'string' ? undefined : loaded.account;
    const document = rec(JSON.parse(payload));
    if (document && findClaudeAccessToken(document)) {
      return { kind: 'keychain', document, ...(account ? { account } : {}) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function persistClaudeCredentialStore(
  store: CredentialStore,
  document: Record<string, unknown>,
  options: ClaudeCredentialOptions,
): Promise<void> {
  const payload = JSON.stringify(document);
  if (store.kind === 'file') {
    if (options.writeCredentialsFile) {
      await options.writeCredentialsFile(store.path, payload);
    } else {
      await writeFile(store.path, payload, 'utf8');
    }
    return;
  }
  if (options.writeKeychainPayload) {
    await options.writeKeychainPayload(payload, store.account);
  } else {
    await defaultWriteKeychainPayload(payload, store.account ?? keychainAccountCandidates(options.env ?? process.env)[0] ?? 'unknown');
  }
}

async function refreshClaudeOAuthTokens(
  refreshToken: string,
  options: ClaudeCredentialOptions,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  refreshTokenExpiresAt?: number;
}> {
  const now = options.now ?? (() => new Date());
  const response = await (options.fetchImpl ?? fetch)(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    throw new Error(`Claude OAuth token refresh failed with HTTP ${response.status}`);
  }
  const body = rec(JSON.parse(await response.text()));
  const accessToken =
    typeof body?.access_token === 'string' && body.access_token.trim()
      ? body.access_token.trim()
      : typeof body?.accessToken === 'string' && body.accessToken.trim()
        ? body.accessToken.trim()
        : undefined;
  if (!accessToken) throw new Error('Claude OAuth token refresh returned no access token');
  const nextRefresh =
    typeof body?.refresh_token === 'string' && body.refresh_token.trim()
      ? body.refresh_token.trim()
      : typeof body?.refreshToken === 'string' && body.refreshToken.trim()
        ? body.refreshToken.trim()
        : undefined;
  const expiresIn = finite(body?.expires_in) ?? finite(body?.expiresIn) ?? 28_800;
  const refreshExpiresIn = finite(body?.refresh_token_expires_in) ?? finite(body?.refreshTokenExpiresIn);
  const nowMs = now().valueOf();
  return {
    accessToken,
    ...(nextRefresh ? { refreshToken: nextRefresh } : {}),
    expiresAt: nowMs + Math.max(0, expiresIn) * 1_000,
    ...(refreshExpiresIn !== undefined
      ? { refreshTokenExpiresAt: nowMs + Math.max(0, refreshExpiresIn) * 1_000 }
      : {}),
  };
}

/**
 * Resolve Claude Code's OAuth access token without returning the credential document.
 * Refreshes and persists expired tokens when a refresh token is available.
 * Lookup/refresh failures collapse to `undefined`; callers surface unauthenticated.
 */
export async function resolveClaudeAccessToken(options: ClaudeCredentialOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_ACCESS_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  const store = await loadClaudeCredentialStore(options);
  if (!store) return undefined;

  const nowMs = (options.now ?? (() => new Date()))().valueOf();
  const accessToken = findClaudeAccessToken(store.document);
  const expiresAt = findClaudeAccessTokenExpiresAt(store.document);
  const refreshToken = findClaudeRefreshToken(store.document);

  if (accessToken && !options.forceRefresh && accessTokenIsFresh(expiresAt, nowMs)) {
    return accessToken;
  }

  if (!refreshToken) {
    // Expired (or force-refresh) without a refresh token: only return a still-fresh access token.
    return accessToken && accessTokenIsFresh(expiresAt, nowMs) ? accessToken : undefined;
  }

  try {
    const tokens = await refreshClaudeOAuthTokens(refreshToken, options);
    const updated = applyRefreshedTokens(store.document, tokens);
    try {
      await persistClaudeCredentialStore(store, updated, options);
    } catch {
      // Still usable for this request even if the credential store could not be updated.
    }
    return tokens.accessToken;
  } catch {
    // Fall back to a non-expired stored access token if refresh fails.
    return accessToken && accessTokenIsFresh(expiresAt, nowMs) ? accessToken : undefined;
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

const DEFAULT_OAUTH_SOURCE: AccountUsageSource = { kind: 'oauth-endpoint', stability: 'experimental' };
const STATUSLINE_SOURCE: AccountUsageSource = { kind: 'native-statusline', stability: 'documented' };

/** Normalize Claude's experimental OAuth usage response, including optional and future quota families. */
export function normalizeClaudeAccountUsage(
  value: unknown,
  fetchedAt = new Date().toISOString(),
  source: AccountUsageSource = DEFAULT_OAUTH_SOURCE,
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
    source,
    limits: normalizedLimits,
  };
}

/**
 * Parse Claude Code status-line `rate_limits` into the shared account-usage shape.
 * Official Claude Code stdin fields after the first Pro/Max API response; no network call.
 */
export function claudeAccountUsageFromStatusLine(
  payload: unknown,
  fetchedAt = new Date().toISOString(),
): AccountUsageAvailable | undefined {
  const body = rec(payload);
  const rateLimits = rec(body?.rate_limits);
  if (!rateLimits) return undefined;
  const snapshot = normalizeClaudeAccountUsage({ rate_limits: rateLimits }, fetchedAt, STATUSLINE_SOURCE);
  if (snapshot.limits.length === 0) return undefined;
  return { status: 'available', snapshot };
}

type ClaudeAccountUsageListener = (result: AccountUsageAvailable) => void;

const statusLineAccountUsageListeners = new Set<ClaudeAccountUsageListener>();
let lastStatusLineAccountUsage: AccountUsageAvailable | undefined;

/** Latest status-line-derived Claude usage, if any process has observed it. */
export function getClaudeStatusLineAccountUsage(): AccountUsageAvailable | undefined {
  return lastStatusLineAccountUsage;
}

/**
 * Subscribe to Claude status-line rate-limit updates. Account-wide (not session-scoped):
 * every live Claude session that emits rate_limits shares this channel.
 */
export function onClaudeAccountUsage(listener: ClaudeAccountUsageListener): () => void {
  statusLineAccountUsageListeners.add(listener);
  return () => {
    statusLineAccountUsageListeners.delete(listener);
  };
}

/**
 * Ingest a Claude status-line payload. When `rate_limits` is present, updates the
 * process-local cache and notifies listeners so hosts can refresh Godview without
 * polling the rate-limited OAuth usage endpoint.
 */
export function observeClaudeStatusLineAccountUsage(
  payload: unknown,
  fetchedAt = new Date().toISOString(),
): AccountUsageAvailable | undefined {
  const next = claudeAccountUsageFromStatusLine(payload, fetchedAt);
  if (!next) return undefined;
  lastStatusLineAccountUsage = next;
  for (const listener of statusLineAccountUsageListeners) {
    try {
      listener(next);
    } catch {
      // Listeners must not break the status-line bridge path.
    }
  }
  return next;
}

/** @internal Test isolation for module-scoped status-line usage state. */
export function resetClaudeAccountUsageObserversForTests(): void {
  lastStatusLineAccountUsage = undefined;
  statusLineAccountUsageListeners.clear();
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

  const resolveToken = async (forceRefresh = false): Promise<string | undefined> => {
    if (options.resolveAccessToken) return options.resolveAccessToken();
    return resolveClaudeAccessToken({ ...options, forceRefresh });
  };

  let token: string | undefined;
  try {
    token = await resolveToken(false);
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

  const fetchUsage = async (accessToken: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await (options.fetchImpl ?? fetch)(options.endpoint ?? CLAUDE_USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'anthropic-beta': CLAUDE_OAUTH_BETA,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let response = await fetchUsage(token);
    if ((response.status === 401 || response.status === 403) && !options.resolveAccessToken) {
      // Access token may have been revoked early; rotate once via the refresh token.
      const refreshed = await resolveToken(true).catch(() => undefined);
      if (refreshed && refreshed !== token) {
        token = refreshed;
        response = await fetchUsage(token);
      }
    }
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
