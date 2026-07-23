import type {
  AccountUsageAvailable,
  AccountUsageFailure,
  AccountUsageFetchResult,
} from '@vibecook/chopsticks-core';
import {
  ACCOUNT_USAGE_AGENTS,
  type AccountUsageAgent,
  type AgentAccountUsage,
  type AgentAccountUsageBatch,
} from '../protocol.js';

const DEFAULT_REFRESH_MS: Record<AccountUsageAgent, number> = {
  claude: 5 * 60_000,
  codex: 60_000,
  grok: 15 * 60_000,
};
const MAX_BACKOFF_MS = 30 * 60_000;

export interface AccountUsageMonitorOptions {
  fetchUsage(agent: AccountUsageAgent): Promise<AccountUsageFetchResult>;
  publish(batch: AgentAccountUsageBatch): void;
  refreshMs?: number;
  refreshMsByAgent?: Partial<Record<AccountUsageAgent, number>>;
  tickMs?: number;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export interface AccountUsageMonitor {
  snapshot(): Promise<AgentAccountUsageBatch>;
  refresh(): Promise<AgentAccountUsageBatch>;
  start(): void;
  stop(): void;
}

function unavailable(agent: AccountUsageAgent): AccountUsageFetchResult {
  return {
    status: 'unavailable',
    provider: agent,
    message: `${agent} account usage could not be refreshed`,
    retryable: true,
  };
}

interface ProviderRefreshState {
  entry?: AgentAccountUsage;
  lastAvailable?: AccountUsageAvailable;
  nextRefreshAtMs: number;
  consecutiveFailures: number;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

export function createAccountUsageMonitor(options: AccountUsageMonitorOptions): AccountUsageMonitor {
  const refreshMsByAgent = Object.fromEntries(
    ACCOUNT_USAGE_AGENTS.map((agent) => [
      agent,
      finitePositive(
        options.refreshMs ?? options.refreshMsByAgent?.[agent] ?? DEFAULT_REFRESH_MS[agent],
        `${agent} account usage refresh interval`,
      ),
    ]),
  ) as Record<AccountUsageAgent, number>;
  const tickMs = finitePositive(
    options.tickMs ?? Math.min(...Object.values(refreshMsByAgent)),
    'account usage polling interval',
  );

  let latest: AgentAccountUsageBatch | undefined;
  let inFlight: Promise<AgentAccountUsageBatch> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const states = new Map<AccountUsageAgent, ProviderRefreshState>(
    ACCOUNT_USAGE_AGENTS.map((agent) => [
      agent,
      { nextRefreshAtMs: Number.NEGATIVE_INFINITY, consecutiveFailures: 0 },
    ]),
  );
  const now = options.now ?? (() => new Date());

  const nextRefreshAt = (
    agent: AccountUsageAgent,
    result: AccountUsageFailure,
    state: ProviderRefreshState,
    completedAtMs: number,
  ): number => {
    const providerRetryAt = result.retryAt ? Date.parse(result.retryAt) : Number.NaN;
    if (Number.isFinite(providerRetryAt) && providerRetryAt > completedAtMs) return providerRetryAt;
    const multiplier = result.retryable ? 2 ** Math.min(state.consecutiveFailures, 5) : 1;
    return completedAtMs + Math.min(refreshMsByAgent[agent] * multiplier, MAX_BACKOFF_MS);
  };

  const refresh = (): Promise<AgentAccountUsageBatch> => {
    if (inFlight) return inFlight;
    const startedAtMs = now().valueOf();
    const dueAgents = ACCOUNT_USAGE_AGENTS.filter(
      (agent) => states.get(agent)!.nextRefreshAtMs <= startedAtMs,
    );
    if (dueAgents.length === 0 && latest) return Promise.resolve(latest);

    const request = Promise.all(
      dueAgents.map(async (agent): Promise<[AccountUsageAgent, AccountUsageFetchResult]> => {
        try {
          return [agent, await options.fetchUsage(agent)];
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
          return [agent, unavailable(agent)];
        }
      }),
    ).then((results): AgentAccountUsageBatch => {
      const completedAt = now();
      const completedAtMs = completedAt.valueOf();
      for (const [agent, result] of results) {
        const state = states.get(agent)!;
        if (result.status === 'available') {
          state.lastAvailable = result;
          state.entry = { agent, result };
          state.consecutiveFailures = 0;
          state.nextRefreshAtMs = completedAtMs + refreshMsByAgent[agent];
          continue;
        }

        state.entry = state.lastAvailable
          ? { agent, result: state.lastAvailable, stale: true, refreshFailure: result }
          : { agent, result };
        state.nextRefreshAtMs = nextRefreshAt(agent, result, state, completedAtMs);
        state.consecutiveFailures += 1;
      }
      const entries = ACCOUNT_USAGE_AGENTS.map(
        (agent) => states.get(agent)!.entry ?? { agent, result: unavailable(agent) },
      );
      const batch = {
        refreshedAt: completedAt.toISOString(),
        entries,
      };
      latest = batch;
      try {
        options.publish(batch);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      return batch;
    });
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) inFlight = undefined;
      },
      () => {
        if (inFlight === request) inFlight = undefined;
      },
    );
    return request;
  };

  return {
    snapshot: () => (latest ? Promise.resolve(latest) : refresh()),
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), tickMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
