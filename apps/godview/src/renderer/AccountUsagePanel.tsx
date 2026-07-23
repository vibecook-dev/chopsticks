import { useEffect, useMemo, useState } from 'react';
import { ACCOUNT_USAGE_AGENTS, type AgentAccountUsageBatch } from '../protocol.js';
import { AgentIcon } from './AgentIcon.js';
import { providerAccountUsageView, type AccountUsageMetricView } from './account-usage.js';

function UsageMetric({ metric }: { metric: AccountUsageMetricView }) {
  return (
    <span className="account-usage-metric" title={metric.title}>
      <span className="account-usage-metric-copy">
        <small>{metric.label}</small>
        <strong>{metric.value}</strong>
      </span>
      <span
        className="account-usage-track"
        role="progressbar"
        aria-label={`${metric.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(metric.usedPercent)}
      >
        <i style={{ width: `${metric.usedPercent}%` }} />
      </span>
      <span className="account-usage-reset">{metric.resetLabel ? `↻ ${metric.resetLabel}` : '↻ —'}</span>
    </span>
  );
}

export function AccountUsagePanel() {
  const [batch, setBatch] = useState<AgentAccountUsageBatch>();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const unsubscribe = window.chopsticks.onAccountUsage((next) => {
      if (alive) setBatch(next);
    });
    void window.chopsticks.accountUsage().then(
      (next) => {
        if (alive) setBatch(next);
      },
      () => undefined,
    );
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const entries = useMemo(
    () => new Map(batch?.entries.map((entry) => [entry.agent, entry] as const) ?? []),
    [batch],
  );
  const views = ACCOUNT_USAGE_AGENTS.map((agent) => providerAccountUsageView(agent, entries.get(agent), nowMs));

  return (
    <aside className="account-usage-panel" aria-label="Agent account usage limits">
      <div className="account-usage-providers" aria-live="polite">
        {views.map((view) => (
          <div className={`account-usage-provider is-${view.state}`} key={view.agent}>
            <span className="account-usage-provider-name">
              <span className="account-usage-provider-icon">
                <AgentIcon agent={view.agent} />
              </span>
              <span className="account-usage-provider-label">
                <span>{view.label}</span>
                {view.badgeText ? <small title={view.badgeTitle}>{view.badgeText}</small> : null}
              </span>
            </span>
            {view.metrics.length > 0 ? (
              <span className="account-usage-metrics">
                {view.metrics.map((metric) => (
                  <UsageMetric key={metric.key} metric={metric} />
                ))}
              </span>
            ) : (
              <span className="account-usage-status">{view.statusText}</span>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
