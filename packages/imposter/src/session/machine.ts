/**
 * The session lifecycle, as an actual state machine over the op vocabulary
 * (draft/IMPOSTER.md §2, §11).
 *
 * The ops in `persona/types.ts` were always a state machine — a turn cannot end
 * before it starts, a tool cannot finish before it runs, an approval suspends
 * whatever asked for it — but that structure lived only in the shape of the
 * behavior packs. Written down, it becomes something the operator can see and
 * steer by: where the session is now, which ops are organic from here, and what
 * each one would do.
 *
 * Two properties matter more than the graph itself:
 *
 * 1. **Descriptive, never prescriptive.** The machine reports; it does not
 *    gate. Firing an op the current state does not handle leaves the state
 *    alone and marks the op off-model — it does NOT refuse it. That is
 *    deliberate: adversarial scenarios exist precisely to send traffic no
 *    organic turn would produce (`duplicate-out-of-order`, `late-after-exit`),
 *    and a machine that blocked them would delete the imposter's whole reason
 *    for existing. Refusal belongs at the ASM boundary (§7.3 item 3), which
 *    judges payloads, not order.
 *
 * 2. **It advances on the OP, not on the wire.** An op a persona leaves unbound
 *    still happened — codex binds no `session.ready`, and the imposter is
 *    nonetheless ready. So the machine describes what the imposter IS, while
 *    the emitted log describes what it TOLD the client, and the gap between
 *    them is exactly the thing an adapter author needs to see.
 *
 * xstate costs 6 ms and 5.6 MB RSS to import (node 26.5, measured 2026-08-08) —
 * an eighth of Ink's 40 MB, and unlike Ink this is wanted in every mode, so it
 * is a static import rather than a dynamic one.
 */

import { assign, createActor, createMachine, type Actor, type AnyStateMachine } from 'xstate';
import { OP_NAMES, type OpName } from '../persona/types.ts';

/** State ids, flattened — `turn.thinking` rather than `{ turn: 'thinking' }`. */
export type MachineStateId =
  'starting' | 'booting' | 'ready' | 'turn.thinking' | 'turn.tool' | 'turn.approval' | 'ended';

export interface MachineSnapshot {
  state: MachineStateId;
  /** Ops the current state handles — the console's organic trigger set. */
  enabled: OpName[];
  /** Ops applied so far that the state at the time did not handle. */
  offModel: number;
  /** Ops applied so far, off-model included. */
  applied: number;
  /** `usage.refresh` count — the one op that is legal everywhere and moves nothing. */
  heartbeats: number;
}

export interface OpMachine {
  /**
   * Apply one op. Returns whether the current state handled it; an unhandled op
   * still counts as applied, because it still happened.
   */
  send(op: string): { handled: boolean; snapshot: MachineSnapshot };
  snapshot(): MachineSnapshot;
  subscribe(listener: (snapshot: MachineSnapshot) => void): () => void;
  stop(): void;
}

/**
 * `session.end` and `usage.refresh` are handled at the root: both are legal
 * from anywhere, and drawing seven edges for each would bury the flow that
 * actually matters. `describeMachine` reports them as globals instead.
 */
const definition = {
  id: 'imposter-session',
  initial: 'starting',
  context: { heartbeats: 0 },
  on: {
    'session.end': '.ended',
    // Usage refreshes are a heartbeat, not a transition — but xstate's `can()`
    // is false for an event with no effect at all, which would report every
    // refresh as off-model. Counting them is both the fix and the honest
    // model: the op happened, and it moved no lifecycle state.
    'usage.refresh': { actions: assign({ heartbeats: ({ context }) => (context.heartbeats as number) + 1 }) },
  },
  states: {
    /** Process alive, nothing announced. For a served vendor this is the wait for a thread. */
    starting: {
      on: { 'session.start': 'booting' },
    },
    booting: {
      on: {
        'session.ready': 'ready',
        // A vendor with no readiness signal proves readiness by completing a
        // turn — codex binds no `session.ready` on purpose, and its reducer
        // reaches `ready` on the first `turn/completed`. Without this edge every
        // codex turn would read as off-model, which would be a lie about codex
        // rather than a finding about it.
        'turn.start': 'turn',
      },
    },
    ready: {
      on: { 'turn.start': 'turn' },
    },
    turn: {
      initial: 'thinking',
      on: { 'turn.end': 'ready' },
      states: {
        thinking: {
          on: {
            'assistant.delta': 'thinking',
            'tool.start': 'tool',
            'permission.ask': 'approval',
          },
        },
        tool: {
          on: {
            'tool.end': 'thinking',
            'permission.ask': 'approval',
          },
        },
        /**
         * Suspended on a client decision. Both entry orders are evidenced by
         * the scenario packs rather than assumed: claude asks before the tool
         * runs (`PermissionRequest` → `PreToolUse`) and codex asks after it
         * starts (`item/started` → `requestApproval`). Both exits are real too
         * — allowed runs the tool, denied returns to the turn without one,
         * which is why codex's deny is `decline` and not `cancel` (C1d).
         */
        approval: {
          on: {
            'tool.start': 'tool',
            'tool.end': 'thinking',
          },
        },
      },
    },
    /** Nothing leaves. Anything after this is off-model by construction, which is what `late-after-exit` tests. */
    ended: {},
  },
} as const;

function flatten(value: unknown): MachineStateId {
  if (typeof value === 'string') return value as MachineStateId;
  const [parent, child] = Object.entries(value as Record<string, unknown>)[0] ?? [];
  return (child === undefined ? String(parent) : `${String(parent)}.${flatten(child)}`) as MachineStateId;
}

export function createOpMachine(): OpMachine {
  const machine: AnyStateMachine = createMachine(definition);
  const actor: Actor<AnyStateMachine> = createActor(machine);
  const listeners = new Set<(snapshot: MachineSnapshot) => void>();
  let offModel = 0;
  let applied = 0;
  actor.start();

  const snapshot = (): MachineSnapshot => {
    const current = actor.getSnapshot();
    return {
      state: flatten(current.value),
      // `usage.refresh` is handled at the root, so `can()` reports it in every
      // state — correct, and the console shows it as the heartbeat it is.
      enabled: OP_NAMES.filter((op) => current.can({ type: op })),
      offModel,
      applied,
      heartbeats: (current.context as { heartbeats: number }).heartbeats,
    };
  };

  return {
    send(op) {
      const handled = actor.getSnapshot().can({ type: op });
      applied += 1;
      if (!handled) offModel += 1;
      // Sent either way: an off-model op is reported, not swallowed, and one
      // the machine happens not to model must never be lost from the counts.
      actor.send({ type: op });
      const next = snapshot();
      for (const listener of listeners) listener(next);
      return { handled, snapshot: next };
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: () => actor.stop(),
  };
}

// ---------------------------------------------------------------------------
// Serializable description, for anything that draws the machine
// ---------------------------------------------------------------------------

export interface MachineNode {
  id: MachineStateId;
  label: string;
  /** Compound-state container this node sits inside, if any. */
  group?: string;
  /** Grid position, not pixels — the renderer scales it. See the note below. */
  x: number;
  y: number;
}

export interface MachineEdge {
  from: MachineStateId;
  to: MachineStateId;
  op: OpName;
  /** Legal, but not the ordinary route through the graph; renderers dim it. */
  secondary?: boolean;
}

export interface MachineGlobal {
  op: OpName;
  /** Target state, or undefined when the op is a heartbeat that moves nothing. */
  to?: MachineStateId;
  note: string;
}

export interface MachineDescription {
  nodes: MachineNode[];
  edges: MachineEdge[];
  globals: MachineGlobal[];
  groups: Array<{ id: string; label: string }>;
}

/**
 * The picture of the machine, laid out by hand.
 *
 * Positions live here rather than in the renderer because this graph is small,
 * fixed, and worth reading: a generic layout engine would spend a dependency to
 * produce something worse. They are grid coordinates, so the console can scale
 * them to whatever space it has.
 */
export function describeMachine(): MachineDescription {
  return {
    groups: [{ id: 'turn', label: 'turn' }],
    nodes: [
      { id: 'starting', label: 'starting', x: 0, y: 1 },
      { id: 'booting', label: 'booting', x: 1, y: 1 },
      { id: 'ready', label: 'ready', x: 2, y: 1 },
      { id: 'turn.thinking', label: 'thinking', group: 'turn', x: 3.25, y: 0.42 },
      { id: 'turn.tool', label: 'tool', group: 'turn', x: 4.5, y: 0.42 },
      { id: 'turn.approval', label: 'approval', group: 'turn', x: 3.875, y: 1.55 },
      { id: 'ended', label: 'ended', x: 1.5, y: 2.5 },
    ],
    edges: [
      { from: 'starting', to: 'booting', op: 'session.start' },
      { from: 'booting', to: 'ready', op: 'session.ready' },
      { from: 'booting', to: 'turn.thinking', op: 'turn.start', secondary: true },
      { from: 'ready', to: 'turn.thinking', op: 'turn.start' },
      { from: 'turn.thinking', to: 'turn.thinking', op: 'assistant.delta' },
      { from: 'turn.thinking', to: 'turn.tool', op: 'tool.start' },
      { from: 'turn.thinking', to: 'turn.approval', op: 'permission.ask' },
      { from: 'turn.tool', to: 'turn.thinking', op: 'tool.end' },
      { from: 'turn.tool', to: 'turn.approval', op: 'permission.ask' },
      { from: 'turn.approval', to: 'turn.tool', op: 'tool.start' },
      { from: 'turn.approval', to: 'turn.thinking', op: 'tool.end' },
      { from: 'turn.thinking', to: 'ready', op: 'turn.end' },
      // `turn.end` is handled on the compound state, so it is legal from every
      // child. Drawing all three keeps the picture honest; two are dimmed
      // because ending mid-tool or mid-approval is a fault path, not a turn.
      { from: 'turn.tool', to: 'ready', op: 'turn.end', secondary: true },
      { from: 'turn.approval', to: 'ready', op: 'turn.end', secondary: true },
    ],
    globals: [
      { op: 'session.end', to: 'ended', note: 'legal from any state' },
      { op: 'usage.refresh', note: 'heartbeat — changes no state' },
    ],
  };
}
