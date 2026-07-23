import type {
  AccountUsageBudget,
  AccountUsageLimit,
  AccountUsageWindow,
} from '@vibecook/chopsticks-core';
import type { AccountUsageAgent, AgentAccountUsage } from '../protocol.js';

export type AccountUsageViewState =
  | 'available'
  | 'loading'
  | 'rate-limited'
  | 'unauthenticated'
  | 'unsupported'
  | 'unavailable';

export interface AccountUsageMetricView {
  key: string;
  label: string;
  usedPercent: number;
  value: string;
  resetLabel?: string;
  title: string;
}

export interface ProviderAccountUsageView {
  agent: AccountUsageAgent;
  label: string;
  state: AccountUsageViewState;
  metrics: readonly AccountUsageMetricView[];
  statusText?: string;
  badgeText?: string;
  badgeTitle?: string;
}

interface WindowCandidate {
  limit: AccountUsageLimit;
  limitIndex: number;
  window: AccountUsageWindow;
  windowIndex: number;
}

const PROVIDER_LABELS: Record<AccountUsageAgent, string> = {
  claude: 'CLAUDE',
  codex: 'CODEX',
  grok: 'GROK',
};

function finitePercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function compactWords(value: string): string {
  return value
    .replace(/^codex[\s_-]*/i, '')
    .replace(/^claude[\s_-]*/i, '')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .toUpperCase();
}

function specializedLimitLabel(limit: AccountUsageLimit): string | undefined {
  const identity = `${limit.id} ${limit.name ?? ''}`;
  if (/\bspark\b/i.test(identity)) return 'SPARK';
  if (/\bmini\b/i.test(identity)) return 'MINI';
  return undefined;
}

function metricLabel(candidate: WindowCandidate): string {
  const { limit, window } = candidate;
  const id = window.id.toLowerCase();
  if (id === 'five_hour' || window.durationMinutes === 300) return '5H';
  if (id === 'seven_day') return '7D';
  if (id.startsWith('seven_day_')) return compactWords(id.slice('seven_day_'.length)).slice(0, 8);
  if (id === 'cinder_cove') return 'FABLE';
  if (window.durationMinutes === 10_080) {
    return specializedLimitLabel(limit) ?? '7D';
  }
  const supplied = compactWords(window.label ?? '');
  if (supplied) return supplied.slice(0, 8);
  return compactWords(window.id).slice(0, 8) || 'LIMIT';
}

function windowRank(candidate: WindowCandidate): number {
  const id = candidate.window.id.toLowerCase();
  const specializedOffset = specializedLimitLabel(candidate.limit) ? 5 : 0;
  const providerOrder = candidate.limitIndex / 100;
  if (id === 'five_hour' || candidate.window.durationMinutes === 300) return specializedOffset + providerOrder;
  if (id.startsWith('seven_day_')) return 40 + specializedOffset + providerOrder;
  if (id === 'seven_day' || candidate.window.durationMinutes === 10_080) {
    return 20 + specializedOffset + providerOrder;
  }
  if (id === 'cinder_cove') return 50 + specializedOffset + providerOrder;
  return 60 + specializedOffset + providerOrder + candidate.windowIndex / 100;
}

export function formatUsageReset(resetsAt: string | undefined, nowMs: number): string | undefined {
  if (!resetsAt) return undefined;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return 'NOW';
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  if (hours < 24) return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  if (days < 7) return hourRemainder ? `${days}d ${hourRemainder}h` : `${days}d`;
  return new Date(resetMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function metricFromWindow(candidate: WindowCandidate, nowMs: number): AccountUsageMetricView | undefined {
  const usedPercent = finitePercent(candidate.window.usedPercent);
  if (usedPercent === undefined) return undefined;
  const resetLabel = formatUsageReset(candidate.window.resetsAt, nowMs);
  const label = metricLabel(candidate);
  return {
    key: `${candidate.limit.id}:${candidate.window.id}`,
    label,
    usedPercent,
    value: `${Math.round(usedPercent)}%`,
    ...(resetLabel ? { resetLabel } : {}),
    title: `${candidate.limit.name ?? candidate.limit.id.toUpperCase()} ${label}: ${usedPercent.toFixed(1)}% used${resetLabel ? `, resets in ${resetLabel}` : ''}`,
  };
}

function metricFromBudget(
  limit: AccountUsageLimit,
  budget: AccountUsageBudget,
  nowMs: number,
): AccountUsageMetricView | undefined {
  const remainingPercent = finitePercent(budget.remainingPercent);
  if (remainingPercent === undefined) return undefined;
  const usedPercent = 100 - remainingPercent;
  const resetLabel = formatUsageReset(budget.resetsAt, nowMs);
  const label = compactWords(limit.name ?? limit.id).includes('CREDIT') ? 'CREDIT' : 'BUDGET';
  return {
    key: `${limit.id}:budget`,
    label,
    usedPercent,
    value: `${Math.round(usedPercent)}%`,
    ...(resetLabel ? { resetLabel } : {}),
    title: `${limit.name ?? limit.id}: ${remainingPercent.toFixed(1)}% remaining${resetLabel ? `, resets in ${resetLabel}` : ''}`,
  };
}

function availableMetrics(entry: AgentAccountUsage, nowMs: number): readonly AccountUsageMetricView[] {
  if (entry.result.status !== 'available') return [];
  const limits = entry.result.snapshot.limits;
  const candidates = limits
    .flatMap((limit, limitIndex) =>
      limit.windows.map((window, windowIndex): WindowCandidate => ({ limit, limitIndex, window, windowIndex })),
    )
    .sort((left, right) => windowRank(left) - windowRank(right));
  const metrics = candidates
    .map((candidate) => metricFromWindow(candidate, nowMs))
    .filter((metric): metric is AccountUsageMetricView => metric !== undefined);

  for (const limit of limits) {
    if (metrics.length >= 3) break;
    const metric = limit.budget ? metricFromBudget(limit, limit.budget, nowMs) : undefined;
    if (metric) metrics.push(metric);
  }
  return metrics.slice(0, 3);
}

export function providerAccountUsageView(
  agent: AccountUsageAgent,
  entry: AgentAccountUsage | undefined,
  nowMs: number,
): ProviderAccountUsageView {
  if (!entry) {
    return { agent, label: PROVIDER_LABELS[agent], state: 'loading', metrics: [], statusText: 'SYNCING' };
  }
  if (entry.result.status === 'available') {
    const metrics = availableMetrics(entry, nowMs);
    const failure = entry.refreshFailure;
    const rateLimited = failure?.code === 'rate-limited';
    const retryLabel = formatUsageReset(failure?.retryAt, nowMs);
    return {
      agent,
      label: PROVIDER_LABELS[agent],
      state: rateLimited ? 'rate-limited' : 'available',
      metrics,
      ...(rateLimited
        ? {
            badgeText: 'RATE LIMITED',
            badgeTitle: retryLabel ? `Retrying in ${retryLabel}` : 'Waiting to retry',
          }
        : {}),
      ...(metrics.length === 0 ? { statusText: 'NO LIMIT DATA' } : {}),
    };
  }
  const rateLimited = entry.result.code === 'rate-limited';
  const retryLabel = formatUsageReset(entry.result.retryAt, nowMs);
  const statusText =
    entry.result.status === 'unauthenticated'
      ? 'SIGN IN REQUIRED'
      : entry.result.status === 'unsupported'
        ? agent === 'grok'
          ? 'WEEKLY · NOT EXPOSED'
          : 'NOT EXPOSED'
        : rateLimited
          ? `RATE LIMITED${retryLabel ? ` · ${retryLabel}` : ''}`
          : 'RETRYING';
  return {
    agent,
    label: PROVIDER_LABELS[agent],
    state: rateLimited ? 'rate-limited' : entry.result.status,
    metrics: [],
    statusText,
  };
}
