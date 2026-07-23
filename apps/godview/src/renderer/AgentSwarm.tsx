import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import Matter from 'matter-js';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentSessionInfo, AgentStateMessage } from '../protocol.js';
import { AgentIcon } from './AgentIcon.js';
import { liveAgentView, type LiveAgentView } from './agent-status.js';
import type { PaneAttachment } from './pane-attachments.js';
import { radiusForStatus, type SwarmParameters } from './swarm-parameters.js';

interface AgentRecord {
  info: AgentSessionInfo;
  state?: AgentStateMessage;
}

export interface UnassignedAgentView {
  id: string;
  session: SessionSummary;
  cwd?: string;
  status: 'idle';
  project: string;
  provider: '';
  detail: string;
  color: string;
  spawnPosition: { x: number; y: number };
}

export type AgentBubbleView = LiveAgentView | UnassignedAgentView;

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
const SPAWN_DURATION_MS = 720;
const SPAWN_CLEARANCE = 12;
const SPAWN_CANDIDATES = 40;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const LONG_PRESS_DURATION_MS = 520;
const LONG_PRESS_MOVE_TOLERANCE = 8;

function animateSpawn(element: HTMLButtonElement): void {
  if (
    typeof element.animate !== 'function' ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  ) {
    return;
  }

  const animation = element.animate(
    [
      { transform: 'scale(0)', opacity: 0, offset: 0, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      { transform: 'scale(1.2)', opacity: 1, offset: 0.52, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      { transform: 'scale(0.96)', opacity: 1, offset: 0.72, easing: 'ease-out' },
      { transform: 'scale(1.035)', opacity: 1, offset: 0.88, easing: 'ease-in-out' },
      { transform: 'scale(1)', opacity: 1, offset: 1 },
    ],
    { duration: SPAWN_DURATION_MS, fill: 'both' },
  );

  void animation.finished.then(
    () => animation.cancel(),
    () => undefined,
  );
}

function findSpawnPosition(
  width: number,
  height: number,
  radius: number,
  existingBodies: Iterable<PhysicsBody>,
): Matter.Vector {
  const bodies = [...existingBodies];
  const center = { x: width / 2, y: height / 2 };
  if (bodies.length === 0) return center;

  const collisionRadius = radius + PHYSICAL_GAP;
  const horizontalReach = Math.max(0, Math.min(width * 0.28, width / 2 - collisionRadius - SPAWN_CLEARANCE));
  const verticalReach = Math.max(0, Math.min(height * 0.28, height / 2 - collisionRadius - SPAWN_CLEARANCE));
  const phase = Math.random() * Math.PI * 2;
  let bestPosition = center;
  let bestClearance = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < SPAWN_CANDIDATES; index += 1) {
    const progress = index === 0 ? 0 : Math.sqrt(index / (SPAWN_CANDIDATES - 1));
    const angle = phase + index * GOLDEN_ANGLE;
    const candidate = {
      x: center.x + Math.cos(angle) * horizontalReach * progress,
      y: center.y + Math.sin(angle) * verticalReach * progress,
    };
    let clearance = Number.POSITIVE_INFINITY;
    for (const wrapper of bodies) {
      const distance = Math.hypot(candidate.x - wrapper.body.position.x, candidate.y - wrapper.body.position.y);
      clearance = Math.min(
        clearance,
        distance - (collisionRadius + wrapper.currentRadius + PHYSICAL_GAP + SPAWN_CLEARANCE),
      );
    }
    if (clearance > bestClearance) {
      bestPosition = candidate;
      bestClearance = clearance;
    }
    if (clearance >= 0) return candidate;
  }

  return bestPosition;
}

function isLiveAgent(agent: AgentBubbleView): agent is LiveAgentView {
  return 'info' in agent;
}

function clampSpawnPosition(width: number, height: number, radius: number, position: Matter.Vector): Matter.Vector {
  const margin = radius + PHYSICAL_GAP;
  return {
    x: Math.min(Math.max(position.x, margin), Math.max(margin, width - margin)),
    y: Math.min(Math.max(position.y, margin), Math.max(margin, height - margin)),
  };
}

interface AgentSwarmProps {
  agents: readonly AgentBubbleView[];
  paneAttachments: ReadonlyMap<string, PaneAttachment>;
  parameters: SwarmParameters;
  activeSessionId?: string;
  onSelect: (agent: AgentBubbleView) => void;
  onCreateAt: (position: { x: number; y: number }) => void | Promise<void>;
}

interface PendingLongPress {
  pointerId: number;
  clientX: number;
  clientY: number;
  position: { x: number; y: number };
}

export function AgentSwarm({
  agents,
  paneAttachments,
  parameters,
  activeSessionId,
  onSelect,
  onCreateAt,
}: AgentSwarmProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRefs = useRef(new Map<string, HTMLDivElement>());
  const bubbleRefs = useRef(new Map<string, HTMLButtonElement>());
  const bodiesRef = useRef(new Map<string, PhysicsBody>());
  const spawnedIdsRef = useRef(new Set<string>());
  const longPressRef = useRef<PendingLongPress | undefined>(undefined);
  const longPressTimerRef = useRef<number | undefined>(undefined);
  const worldRef = useRef<PhysicsWorld | undefined>(undefined);
  const parametersRef = useRef(parameters);
  const [longPressPosition, setLongPressPosition] = useState<{ x: number; y: number }>();

  const cancelLongPress = (): void => {
    if (longPressTimerRef.current !== undefined) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = undefined;
    longPressRef.current = undefined;
    setLongPressPosition(undefined);
  };

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== undefined) window.clearTimeout(longPressTimerRef.current);
    },
    [],
  );

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
        const bubble = bubbleRefs.current.get(id);
        if (!element || !bubble) continue;
        const radius = wrapper.currentRadius;
        element.style.width = `${radius * 2}px`;
        element.style.height = `${radius * 2}px`;
        element.style.transform = `translate3d(${wrapper.body.position.x - radius}px, ${wrapper.body.position.y - radius}px, 0)`;
        if (!spawnedIdsRef.current.has(id)) {
          spawnedIdsRef.current.add(id);
          animateSpawn(bubble);
          element.style.visibility = '';
        }
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
      spawnedIdsRef.current.delete(id);
    }
    for (const agent of agents) {
      const targetRadius = radiusForStatus(parameters, agent.status);
      const existing = bodiesRef.current.get(agent.id);
      if (existing) {
        existing.targetRadius = targetRadius;
        continue;
      }
      const spawnPosition =
        'spawnPosition' in agent
          ? clampSpawnPosition(width, height, targetRadius, agent.spawnPosition)
          : findSpawnPosition(width, height, targetRadius, bodiesRef.current.values());
      const body = Matter.Bodies.circle(spawnPosition.x, spawnPosition.y, targetRadius + PHYSICAL_GAP, {
        restitution: parameters.restitution,
        frictionAir: parameters.frictionAir,
        friction: 0.1,
      });
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
    <section
      ref={containerRef}
      className="godview-swarm"
      aria-label="Running agent status field"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const pending = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          position: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        };
        cancelLongPress();
        longPressRef.current = pending;
        setLongPressPosition(pending.position);
        event.currentTarget.setPointerCapture(event.pointerId);
        longPressTimerRef.current = window.setTimeout(() => {
          if (longPressRef.current !== pending) return;
          longPressTimerRef.current = undefined;
          longPressRef.current = undefined;
          setLongPressPosition(undefined);
          void onCreateAt(pending.position);
        }, LONG_PRESS_DURATION_MS);
      }}
      onPointerMove={(event) => {
        const pending = longPressRef.current;
        if (!pending || pending.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) > LONG_PRESS_MOVE_TOLERANCE) {
          cancelLongPress();
        }
      }}
      onPointerUp={(event) => {
        if (longPressRef.current?.pointerId === event.pointerId) cancelLongPress();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        if (longPressRef.current?.pointerId === event.pointerId) cancelLongPress();
      }}
    >
      <div className="godview-swarm-grid" aria-hidden="true" />
      {longPressPosition ? (
        <span
          className="godview-long-press-indicator"
          style={{ left: longPressPosition.x, top: longPressPosition.y }}
          aria-hidden="true"
        />
      ) : null}
      {agents.length === 0 ? (
        <div className="godview-swarm-empty">
          <span>NO ACTIVE AGENTS</span>
          <small>Launch Claude, Codex, or Grok from a terminal pane.</small>
        </div>
      ) : null}
      {agents.map((agent) => {
        const liveAgent = isLiveAgent(agent);
        const sessionId = liveAgent ? agent.info.session.id : agent.session.id;
        const attachment = paneAttachments.get(sessionId);
        const linkedColor = attachment?.primary;
        const style = { '--agent-color': linkedColor ?? agent.color } as CSSProperties;
        const active = activeSessionId === sessionId;
        const contextWindow = liveAgent ? agent.state?.state.contextWindow : undefined;
        const contextPercent = contextWindow ? Math.floor(contextWindow.usedPercent) : undefined;
        const contextLabel =
          contextPercent === undefined ? 'CTX:--%' : `CTX:${contextPercent.toString().padStart(2, '0')}%`;
        return (
          <div
            key={agent.id}
            className={`agent-bubble-positioner is-${agent.status}`}
            ref={(element) => {
              if (element) {
                elementRefs.current.set(agent.id, element);
                if (!spawnedIdsRef.current.has(agent.id)) element.style.visibility = 'hidden';
              } else {
                elementRefs.current.delete(agent.id);
              }
            }}
          >
            <button
              ref={(element) => {
                if (element) bubbleRefs.current.set(agent.id, element);
                else bubbleRefs.current.delete(agent.id);
              }}
              type="button"
              className={`agent-bubble is-${agent.status}${liveAgent ? '' : ' is-unassigned'}${linkedColor ? ' is-linked' : ''}${active ? ' is-active' : ''}`}
              style={style}
              aria-current={active ? 'true' : undefined}
              aria-label={
                liveAgent
                  ? `${agent.project}, ${agent.model ?? agent.provider}, ${agent.status}: ${agent.detail}, ${contextLabel}`
                  : `${agent.project}, unassigned terminal`
              }
              title={liveAgent ? `${agent.project} · ${agent.model ?? agent.provider} · ${agent.detail}` : agent.detail}
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
                if (world && wrapper.dragConstraint)
                  Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
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
                if (world && wrapper.dragConstraint)
                  Matter.Composite.remove(world.engine.world, wrapper.dragConstraint);
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
              {liveAgent && contextWindow ? (
                <span
                  className="agent-bubble-context-fill"
                  style={{ height: `${contextWindow.usedPercent}%` }}
                  aria-hidden="true"
                />
              ) : null}
              {attachment?.mirrors.length ? (
                <span className="agent-bubble-mirror-rings" aria-hidden="true">
                  {attachment.mirrors.map((color, index) => (
                    <i key={`${color}-${index}`} style={{ inset: `${4 + index * 3}px`, borderColor: color }} />
                  ))}
                </span>
              ) : null}
              {liveAgent ? (
                <span className="agent-bubble-glyph" aria-hidden="true">
                  <AgentIcon agent={agent.info.agent} />
                </span>
              ) : null}
              <span className="agent-bubble-copy">
                {liveAgent && agent.branch ? <span className="agent-bubble-branch">{agent.branch}</span> : null}
                <strong>{agent.project}</strong>
                {liveAgent ? <span className="agent-bubble-provider">{agent.model ?? agent.provider}</span> : null}
              </span>
              {liveAgent ? <span className="agent-bubble-context">{contextLabel}</span> : null}
            </button>
          </div>
        );
      })}
    </section>
  );
}
