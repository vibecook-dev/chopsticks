import { useMemo, type CSSProperties } from 'react';
import { AgentIcon } from '../../AgentIcon.js';
import type { AgentVisualStatus } from '../../agent-status.js';
import type { AgentMonitorProps, MonitorAgent } from '../../monitor/types.js';
import { normalizeListParameters } from './list-parameters.js';

/**
 * The deliberately boring view, and the reason it exists: a non-spatial reading
 * of the same `MonitorAgent[]` the swarm renders. It ignores `spawnHint`, takes
 * no position when it opens a terminal, and orders by attention rather than by
 * launch time — proof that presentation choices belong to the view.
 */
const STATUS_ORDER: Record<AgentVisualStatus, number> = { waiting: 0, working: 1, idle: 2 };

function compareAgents(left: MonitorAgent, right: MonitorAgent): number {
  // Agents outrank unclaimed terminals, then the ones asking for something.
  if (Boolean(left.agent) !== Boolean(right.agent)) return left.agent ? -1 : 1;
  const byStatus = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
  return byStatus !== 0 ? byStatus : left.session.createdAtMs - right.session.createdAtMs;
}

export function AgentList({ agents, parameters, actions }: AgentMonitorProps) {
  const { rowHeight, projectWidth } = normalizeListParameters(parameters);
  const ordered = useMemo(() => [...agents].sort(compareAgents), [agents]);
  const style = {
    '--list-row-height': `${rowHeight}px`,
    '--list-project-width': `${projectWidth}px`,
  } as CSSProperties;

  return (
    <section className="godview-list" style={style} aria-label="Running agent list">
      <div className="godview-list-toolbar">
        <span className="godview-list-count">{ordered.length} SESSIONS</span>
        <button type="button" className="godview-list-new" onClick={() => void actions.createAt()}>
          ＋ TERMINAL
        </button>
      </div>
      {ordered.length === 0 ? (
        <div className="godview-list-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch Claude, Codex, or Grok from a terminal pane.</small>
        </div>
      ) : (
        <ul className="godview-list-rows">
          {ordered.map((agent) => {
            const facet = agent.agent;
            const contextPercent = facet?.contextWindow ? Math.floor(facet.contextWindow.usedPercent) : undefined;
            const rowStyle = { '--agent-color': agent.attachment?.primary ?? agent.color } as CSSProperties;
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className={`godview-list-row is-${agent.status}${agent.active ? ' is-active' : ''}${
                    agent.attachment ? ' is-linked' : ''
                  }`}
                  style={rowStyle}
                  aria-current={agent.active ? 'true' : undefined}
                  onClick={() => actions.select(agent)}
                >
                  <span className="godview-list-status" aria-label={agent.status} />
                  <span className="godview-list-project">
                    <strong>{agent.project}</strong>
                    {facet?.branch ? <small>{facet.branch}</small> : null}
                  </span>
                  <span className="godview-list-agent">
                    {facet ? (
                      <>
                        <i aria-hidden="true">
                          <AgentIcon agent={facet.kind} />
                        </i>
                        {facet.model ?? facet.provider}
                      </>
                    ) : (
                      <span className="godview-list-terminal">terminal</span>
                    )}
                  </span>
                  <span className="godview-list-detail">{agent.detail}</span>
                  <span className="godview-list-context">
                    {contextPercent === undefined ? '—' : `${contextPercent}%`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
