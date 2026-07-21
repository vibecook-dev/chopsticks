import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Matter from 'matter-js';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import { liveAgentView, type LiveAgentView } from './agent-status.js';
import { radiusForStatus, type SwarmParameters } from './swarm-parameters.js';

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
  body: Matter.Body;
  currentRadius: number;
  targetRadius: number;
  pointerId?: number;
  pointerStartX: number;
  pointerStartY: number;
  dragConstraint?: Matter.Constraint;
  dragged: boolean;
}

interface PhysicsWorld {
  engine: Matter.Engine;
  walls: [Matter.Body, Matter.Body, Matter.Body, Matter.Body];
}

const PHYSICAL_GAP = 4;
const DRAG_STIFFNESS = 0.2;
const WALL_THICKNESS = 5000;

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
  parameters: SwarmParameters;
  activeSessionId?: string;
  onSelect: (agent: LiveAgentView) => void;
}

export function AgentSwarm({ agents, paneColors, parameters, activeSessionId, onSelect }: AgentSwarmProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRefs = useRef(new Map<string, HTMLButtonElement>());
  const bodiesRef = useRef(new Map<string, PhysicsBody>());
  const worldRef = useRef<PhysicsWorld | undefined>(undefined);
  const parametersRef = useRef(parameters);

  useEffect(() => {
    parametersRef.current = parameters;
    const world = worldRef.current;
    if (!world) return;
    for (const wrapper of bodiesRef.current.values()) {
      wrapper.body.restitution = parameters.restitution;
      wrapper.body.frictionAir = parameters.frictionAir;
    }
    for (const wall of world.walls) wall.restitution = parameters.restitution;
  }, [parameters]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let width = container.clientWidth;
    let height = container.clientHeight;
    const engine = Matter.Engine.create();
    engine.gravity.x = 0;
    engine.gravity.y = 0;
    const wallOptions = { isStatic: true, restitution: parametersRef.current.restitution };
    const walls: [Matter.Body, Matter.Body, Matter.Body, Matter.Body] = [
      Matter.Bodies.rectangle(width / 2, height + WALL_THICKNESS / 2, 10000, WALL_THICKNESS, wallOptions),
      Matter.Bodies.rectangle(width / 2, -WALL_THICKNESS / 2, 10000, WALL_THICKNESS, wallOptions),
      Matter.Bodies.rectangle(-WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, 10000, wallOptions),
      Matter.Bodies.rectangle(width + WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, 10000, wallOptions),
    ];
    Matter.Composite.add(engine.world, walls);
    worldRef.current = { engine, walls };

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        width = entry.contentRect.width;
        height = entry.contentRect.height;
        Matter.Body.setPosition(walls[0], { x: width / 2, y: height + WALL_THICKNESS / 2 });
        Matter.Body.setPosition(walls[1], { x: width / 2, y: -WALL_THICKNESS / 2 });
        Matter.Body.setPosition(walls[2], { x: -WALL_THICKNESS / 2, y: height / 2 });
        Matter.Body.setPosition(walls[3], { x: width + WALL_THICKNESS / 2, y: height / 2 });
      }
    });
    resizeObserver.observe(container);

    let frame = 0;
    let previousTime = performance.now();
    const render = (time: number): void => {
      const delta = Math.min(1000 / 30, Math.max(1000 / 120, time - previousTime));
      previousTime = time;
      const currentParameters = parametersRef.current;
      for (const wrapper of bodiesRef.current.values()) {
        const { body } = wrapper;
        if (!wrapper.dragConstraint) {
          Matter.Body.applyForce(body, body.position, {
            x: (width / 2 - body.position.x) * currentParameters.gravityPull,
            y: (height / 2 - body.position.y) * currentParameters.gravityPull,
          });
        }
        if (Math.abs(wrapper.targetRadius - wrapper.currentRadius) > 0.5) {
          const scale = (wrapper.targetRadius + PHYSICAL_GAP) / (wrapper.currentRadius + PHYSICAL_GAP);
          Matter.Body.scale(body, scale, scale);
          wrapper.currentRadius = wrapper.targetRadius;
        }
      }

      Matter.Engine.update(engine, delta);

      for (const [id, wrapper] of bodiesRef.current) {
        const element = elementRefs.current.get(id);
        if (!element) continue;
        const radius = wrapper.currentRadius;
        element.style.width = `${radius * 2}px`;
        element.style.height = `${radius * 2}px`;
        element.style.transform = `translate3d(${wrapper.body.position.x - radius}px, ${wrapper.body.position.y - radius}px, 0)`;
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      bodiesRef.current.clear();
      Matter.Engine.clear(engine);
      Matter.Composite.clear(engine.world, false, true);
      worldRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const world = worldRef.current;
    const container = containerRef.current;
    if (!world || !container) return;
    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 180);
    const ids = new Set(agents.map((agent) => agent.id));
    for (const [id, wrapper] of bodiesRef.current) {
      if (ids.has(id)) continue;
      if (wrapper.dragConstraint) Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
      Matter.Composite.remove(world.engine.world, wrapper.body);
      bodiesRef.current.delete(id);
    }
    for (const agent of agents) {
      const targetRadius = radiusForStatus(parameters, agent.status);
      const existing = bodiesRef.current.get(agent.id);
      if (existing) {
        existing.targetRadius = targetRadius;
        continue;
      }
      const body = Matter.Bodies.circle(
        width / 2 + (Math.random() - 0.5) * width * 0.5,
        height / 2 + (Math.random() - 0.5) * height * 0.5,
        targetRadius + PHYSICAL_GAP,
        {
          restitution: parameters.restitution,
          frictionAir: parameters.frictionAir,
          friction: 0.1,
        },
      );
      bodiesRef.current.set(agent.id, {
        body,
        currentRadius: targetRadius,
        targetRadius,
        pointerStartX: 0,
        pointerStartY: 0,
        dragged: false,
      });
      Matter.Composite.add(world.engine.world, body);
    }
  }, [agents, parameters.radiusIdle, parameters.radiusWaiting, parameters.radiusWorking]);

  const moveBody = (event: ReactPointerEvent<HTMLButtonElement>, id: string): void => {
    const wrapper = bodiesRef.current.get(id);
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!wrapper || !bounds || wrapper.pointerId !== event.pointerId || !wrapper.dragConstraint) return;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    if (Math.hypot(x - wrapper.pointerStartX, y - wrapper.pointerStartY) >= 5) wrapper.dragged = true;
    wrapper.dragConstraint.pointA.x = x;
    wrapper.dragConstraint.pointA.y = y;
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
              const wrapper = bodiesRef.current.get(agent.id);
              const world = worldRef.current;
              const bounds = containerRef.current?.getBoundingClientRect();
              if (!wrapper || !world || !bounds) return;
              const x = event.clientX - bounds.left;
              const y = event.clientY - bounds.top;
              if (wrapper.dragConstraint) Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
              wrapper.dragConstraint = Matter.Constraint.create({
                pointA: { x, y },
                bodyB: wrapper.body,
                pointB: { x: x - wrapper.body.position.x, y: y - wrapper.body.position.y },
                stiffness: DRAG_STIFFNESS,
                render: { visible: false },
              });
              Matter.Composite.add(world.engine.world, wrapper.dragConstraint);
              event.currentTarget.setPointerCapture(event.pointerId);
              wrapper.pointerId = event.pointerId;
              wrapper.pointerStartX = x;
              wrapper.pointerStartY = y;
              wrapper.dragged = false;
              event.preventDefault();
            }}
            onPointerMove={(event) => moveBody(event, agent.id)}
            onPointerUp={(event) => {
              const wrapper = bodiesRef.current.get(agent.id);
              const world = worldRef.current;
              if (!wrapper) return;
              moveBody(event, agent.id);
              if (world && wrapper.dragConstraint) Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
              delete wrapper.dragConstraint;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              wrapper.pointerId = undefined;
            }}
            onPointerCancel={() => {
              const wrapper = bodiesRef.current.get(agent.id);
              const world = worldRef.current;
              if (!wrapper) return;
              if (world && wrapper.dragConstraint) Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
              delete wrapper.dragConstraint;
              wrapper.pointerId = undefined;
            }}
            onClick={() => {
              const wrapper = bodiesRef.current.get(agent.id);
              if (wrapper?.dragged) {
                wrapper.dragged = false;
                return;
              }
              onSelect(agent);
              if (wrapper) {
                Matter.Body.applyForce(wrapper.body, wrapper.body.position, {
                  x: (Math.random() - 0.5) * 0.003,
                  y: (Math.random() - 0.5) * 0.003,
                });
              }
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
