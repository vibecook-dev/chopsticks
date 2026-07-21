import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import { bubbleRadius, liveAgentView, type LiveAgentView } from './agent-status.js';

interface AgentRecord {
  info: AgentSessionInfo;
  state?: AgentStateMessage;
}

export function useLiveAgentViews(): readonly LiveAgentView[] {
  const [records, setRecords] = useState(() => new Map<string, AgentRecord>());

  useEffect(() => {
    let alive = true;
    const remember = (info: AgentSessionInfo): void => {
      setRecords((current) => {
        const next = new Map(current);
        next.set(info.runtimeSessionId, { ...next.get(info.runtimeSessionId), info });
        return next;
      });
    };
    const forget = (runtimeSessionId: string): void => {
      setRecords((current) => {
        if (!current.has(runtimeSessionId)) return current;
        const next = new Map(current);
        next.delete(runtimeSessionId);
        return next;
      });
    };
    const updateState = (state: AgentStateMessage): void => {
      setRecords((current) => {
        const existing = current.get(state.runtimeSessionId);
        if (!existing) return current;
        return new Map(current).set(state.runtimeSessionId, { ...existing, state });
      });
    };

    const unsubscribeSession = window.chopsticks.onAgentSession(remember);
    const unsubscribeState = window.chopsticks.onAgentState(updateState);
    const unsubscribeRemoved = window.chopsticks.onAgentRemoved(forget);
    const unsubscribeFinal = window.chopsticks.onWorkspaceFinal((event) => forget(event.runtimeSessionId));

    void window.chopsticks.listAgentSessions().then((snapshots) => {
      if (!alive) return;
      const next = new Map<string, AgentRecord>();
      for (const snapshot of snapshots) {
        if (snapshot.final || snapshot.info.session.exited) continue;
        next.set(snapshot.info.runtimeSessionId, { info: snapshot.info, state: snapshot.state });
      }
      setRecords(next);
    });

    return () => {
      alive = false;
      unsubscribeSession();
      unsubscribeState();
      unsubscribeRemoved();
      unsubscribeFinal();
    };
  }, []);

  return useMemo(
    () =>
      [...records.values()]
        .map(({ info, state }) => liveAgentView(info, state))
        .filter((agent): agent is LiveAgentView => Boolean(agent))
        .sort((left, right) => left.info.session.createdAtMs - right.info.session.createdAtMs),
    [records],
  );
}

interface PhysicsBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  targetRadius: number;
  pointerId?: number;
  pointerStartX: number;
  pointerStartY: number;
  dragged: boolean;
}

function numberSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(31, hash) + value.charCodeAt(index);
  return Math.abs(hash);
}

function providerGlyph(agent: AgentSessionInfo['agent']): string {
  switch (agent) {
    case 'claude':
      return 'C';
    case 'codex':
      return '⌘';
    case 'grok':
      return 'G';
    case 'acp':
      return 'A';
  }
}

interface AgentSwarmProps {
  agents: readonly LiveAgentView[];
  paneColors: ReadonlyMap<string, string>;
  activeSessionId?: string;
  onSelect: (agent: LiveAgentView) => void;
}

export function AgentSwarm({ agents, paneColors, activeSessionId, onSelect }: AgentSwarmProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRefs = useRef(new Map<string, HTMLButtonElement>());
  const bodiesRef = useRef(new Map<string, PhysicsBody>());

  useEffect(() => {
    const container = containerRef.current;
    const width = Math.max(container?.clientWidth ?? 0, 320);
    const height = Math.max(container?.clientHeight ?? 0, 180);
    const ids = new Set(agents.map((agent) => agent.id));
    for (const id of bodiesRef.current.keys()) {
      if (!ids.has(id)) bodiesRef.current.delete(id);
    }
    for (const agent of agents) {
      const targetRadius = bubbleRadius(agent.status);
      const existing = bodiesRef.current.get(agent.id);
      if (existing) {
        existing.targetRadius = targetRadius;
        continue;
      }
      const seed = numberSeed(agent.id);
      const angle = ((seed % 360) * Math.PI) / 180;
      const spread = Math.min(width, height) * (0.12 + ((seed % 29) / 100));
      bodiesRef.current.set(agent.id, {
        x: width / 2 + Math.cos(angle) * spread,
        y: height / 2 + Math.sin(angle) * spread,
        vx: ((seed % 17) - 8) * 0.08,
        vy: (((seed >> 4) % 17) - 8) * 0.08,
        radius: targetRadius,
        targetRadius,
        pointerStartX: 0,
        pointerStartY: 0,
        dragged: false,
      });
    }
  }, [agents]);

  useEffect(() => {
    let frame = 0;
    let previousTime = performance.now();
    const render = (time: number): void => {
      const container = containerRef.current;
      if (!container) {
        frame = window.requestAnimationFrame(render);
        return;
      }
      const width = container.clientWidth;
      const height = container.clientHeight;
      const step = Math.min(2, Math.max(0.2, (time - previousTime) / 16.67));
      previousTime = time;
      const bodies = [...bodiesRef.current.entries()];

      for (const [, body] of bodies) {
        body.radius += (body.targetRadius - body.radius) * Math.min(1, 0.14 * step);
        if (body.pointerId === undefined) {
          body.vx += (width / 2 - body.x) * 0.00016 * step;
          body.vy += (height / 2 - body.y) * 0.00016 * step;
          const damping = 0.975 ** step;
          body.vx *= damping;
          body.vy *= damping;
          body.x += body.vx * step;
          body.y += body.vy * step;
        }
      }

      for (let leftIndex = 0; leftIndex < bodies.length; leftIndex += 1) {
        const left = bodies[leftIndex]![1];
        for (let rightIndex = leftIndex + 1; rightIndex < bodies.length; rightIndex += 1) {
          const right = bodies[rightIndex]![1];
          const dx = right.x - left.x;
          const dy = right.y - left.y;
          const distance = Math.max(0.001, Math.hypot(dx, dy));
          const minimum = left.radius + right.radius + 8;
          if (distance >= minimum) continue;
          const nx = dx / distance;
          const ny = dy / distance;
          const correction = (minimum - distance) / 2;
          if (left.pointerId === undefined) {
            left.x -= nx * correction;
            left.y -= ny * correction;
          }
          if (right.pointerId === undefined) {
            right.x += nx * correction;
            right.y += ny * correction;
          }
          const relativeVelocity = (right.vx - left.vx) * nx + (right.vy - left.vy) * ny;
          if (relativeVelocity < 0) {
            const impulse = relativeVelocity * 0.45;
            left.vx += nx * impulse;
            left.vy += ny * impulse;
            right.vx -= nx * impulse;
            right.vy -= ny * impulse;
          }
        }
      }

      for (const [id, body] of bodies) {
        const radius = body.radius;
        if (body.pointerId === undefined) {
          if (body.x < radius) {
            body.x = radius;
            body.vx = Math.abs(body.vx) * 0.2;
          } else if (body.x > width - radius) {
            body.x = width - radius;
            body.vx = -Math.abs(body.vx) * 0.2;
          }
          if (body.y < radius) {
            body.y = radius;
            body.vy = Math.abs(body.vy) * 0.2;
          } else if (body.y > height - radius) {
            body.y = height - radius;
            body.vy = -Math.abs(body.vy) * 0.2;
          }
        }
        const element = elementRefs.current.get(id);
        if (!element) continue;
        element.style.width = `${radius * 2}px`;
        element.style.height = `${radius * 2}px`;
        element.style.transform = `translate3d(${body.x - radius}px, ${body.y - radius}px, 0)`;
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  const moveBody = (event: ReactPointerEvent<HTMLButtonElement>, id: string): void => {
    const body = bodiesRef.current.get(id);
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!body || !bounds || body.pointerId !== event.pointerId) return;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (Math.hypot(x - body.pointerStartX, y - body.pointerStartY) > 4) body.dragged = true;
    body.x = x;
    body.y = y;
    body.vx = 0;
    body.vy = 0;
  };

  return (
    <section ref={containerRef} className="godview-swarm" aria-label="Running agent status field">
      <div className="godview-swarm-grid" aria-hidden="true" />
      {agents.length === 0 ? (
        <div className="godview-swarm-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch Claude, Codex, or Grok from a terminal pane.</small>
        </div>
      ) : null}
      {agents.map((agent) => {
        const sessionId = agent.info.session.id;
        const linkedColor = paneColors.get(sessionId);
        const style = { '--agent-color': linkedColor ?? agent.color } as CSSProperties;
        const active = activeSessionId === sessionId;
        return (
          <button
            key={agent.id}
            ref={(element) => {
              if (element) elementRefs.current.set(agent.id, element);
              else elementRefs.current.delete(agent.id);
            }}
            type="button"
            className={`agent-bubble is-${agent.status}${linkedColor ? ' is-linked' : ''}${active ? ' is-active' : ''}`}
            style={style}
            aria-current={active ? 'true' : undefined}
            aria-label={`${agent.project}, ${agent.provider}, ${agent.status}: ${agent.detail}`}
            title={`${agent.project} · ${agent.provider} · ${agent.detail}`}
            onPointerDown={(event) => {
              const body = bodiesRef.current.get(agent.id);
              const bounds = containerRef.current?.getBoundingClientRect();
              if (!body || !bounds) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              body.pointerId = event.pointerId;
              body.pointerStartX = event.clientX - bounds.left;
              body.pointerStartY = event.clientY - bounds.top;
              body.dragged = false;
            }}
            onPointerMove={(event) => moveBody(event, agent.id)}
            onPointerUp={(event) => {
              const body = bodiesRef.current.get(agent.id);
              if (!body) return;
              moveBody(event, agent.id);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              body.pointerId = undefined;
              body.vx += (Math.random() - 0.5) * 0.6;
              body.vy += (Math.random() - 0.5) * 0.6;
            }}
            onPointerCancel={() => {
              const body = bodiesRef.current.get(agent.id);
              if (body) body.pointerId = undefined;
            }}
            onClick={() => {
              const body = bodiesRef.current.get(agent.id);
              if (body?.dragged) {
                body.dragged = false;
                return;
              }
              onSelect(agent);
            }}
          >
            <span className="agent-bubble-glyph" aria-hidden="true">
              {providerGlyph(agent.info.agent)}
            </span>
            <span className="agent-bubble-copy">
              {agent.branch ? <span className="agent-bubble-branch">{agent.branch}</span> : null}
              <strong>{agent.project}</strong>
              <span className="agent-bubble-provider">{agent.provider}</span>
            </span>
            <span className="agent-bubble-status">{agent.status}</span>
          </button>
        );
      })}
    </section>
  );
}
