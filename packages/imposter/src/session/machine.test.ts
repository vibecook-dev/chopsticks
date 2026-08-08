/**
 * The machine is only worth showing an operator if the picture and the
 * behaviour cannot disagree, so the last test here walks every state and every
 * op and holds the two against each other. Everything above it is the shape of
 * a real turn, taken from the personas that ship.
 */
import { describe, expect, it } from 'vitest';
import { OP_NAMES } from '../persona/types.ts';
import { createOpMachine, describeMachine, type MachineStateId } from './machine.ts';

const run = (ops: readonly string[]): ReturnType<typeof createOpMachine> => {
  const machine = createOpMachine();
  for (const op of ops) machine.send(op);
  return machine;
};

describe('the op lifecycle machine', () => {
  it('walks a claude turn from boot to ready with nothing off-model', () => {
    // personas/claude/persona.json boot + behavior/happy-turn.json ops.
    const machine = run([
      'session.start',
      'session.ready',
      'usage.refresh',
      'turn.start',
      'assistant.delta',
      'turn.end',
    ]);
    expect(machine.snapshot().state).toBe('ready');
    expect(machine.snapshot().offModel).toBe(0);
    expect(machine.snapshot().applied).toBe(6);
  });

  it('reaches ready for a vendor that never announces readiness', () => {
    // Codex binds no `session.ready`; its reducer reaches ready on the first
    // completed turn, and the machine has to agree or every codex turn reads
    // as off-model.
    const machine = run(['session.start', 'turn.start', 'assistant.delta', 'turn.end']);
    expect(machine.snapshot().state).toBe('ready');
    expect(machine.snapshot().offModel).toBe(0);
  });

  it('suspends on an approval in both orders the personas actually use', () => {
    // claude: ask, then run the tool.
    const claude = run(['session.start', 'session.ready', 'turn.start', 'permission.ask']);
    expect(claude.snapshot().state).toBe('turn.approval');
    expect(claude.send('tool.start').snapshot.state).toBe('turn.tool');

    // codex: start the tool, then ask about it.
    const codex = run(['session.start', 'turn.start', 'tool.start', 'permission.ask']);
    expect(codex.snapshot().state).toBe('turn.approval');
    expect(codex.send('tool.end').snapshot.state).toBe('turn.thinking');
  });

  it('reports an out-of-order op without refusing it', () => {
    const machine = run(['session.start', 'session.ready']);
    const { handled, snapshot } = machine.send('tool.end');
    expect(handled).toBe(false);
    // Still counted, still applied, state untouched: adversarial scenarios
    // exist to send exactly this, so the machine reports rather than gates.
    expect(snapshot.state).toBe('ready');
    expect(snapshot.offModel).toBe(1);
    expect(snapshot.applied).toBe(3);
  });

  it('treats everything after session.end as off-model', () => {
    // What `late-after-exit` scripts.
    const machine = run(['session.start', 'session.ready', 'session.end']);
    expect(machine.snapshot().state).toBe('ended');
    expect(machine.send('turn.start').handled).toBe(false);
    expect(machine.snapshot().state).toBe('ended');
  });

  it('offers the ops the current state handles', () => {
    const machine = run(['session.start', 'session.ready']);
    // `usage.refresh` and `session.end` are handled at the root, so they are
    // enabled everywhere — that is what makes them globals in the picture.
    expect(machine.snapshot().enabled).toEqual(['session.end', 'turn.start', 'usage.refresh']);
    expect(run(['session.start']).snapshot().enabled).toContain('session.ready');
  });

  it('notifies subscribers on every op', () => {
    const machine = createOpMachine();
    const seen: string[] = [];
    const off = machine.subscribe((snapshot) => seen.push(snapshot.state));
    machine.send('session.start');
    machine.send('session.ready');
    off();
    machine.send('turn.start');
    expect(seen).toEqual(['booting', 'ready']);
  });
});

describe('the machine description', () => {
  const description = describeMachine();
  const states = description.nodes.map((node) => node.id);

  /** Shortest op sequence into a state, walked over the described edges. */
  function pathTo(target: MachineStateId): string[] {
    const queue: Array<{ state: MachineStateId; ops: string[] }> = [{ state: 'starting', ops: [] }];
    const seen = new Set<MachineStateId>(['starting']);
    while (queue.length > 0) {
      const { state, ops } = queue.shift()!;
      if (state === target) return ops;
      for (const edge of description.edges) {
        if (edge.from !== state || seen.has(edge.to)) continue;
        seen.add(edge.to);
        queue.push({ state: edge.to, ops: [...ops, edge.op] });
      }
    }
    const global = description.globals.find((entry) => entry.to === target);
    if (global) return [global.op];
    throw new Error(`no described path reaches ${target}`);
  }

  it('describes a node for every state and no state twice', () => {
    expect(new Set(states).size).toBe(states.length);
    expect(states).toContain('starting');
    expect(states).toContain('ended');
  });

  it('places grouped nodes inside a declared group', () => {
    const groups = new Set(description.groups.map((group) => group.id));
    for (const node of description.nodes) {
      if (node.group) expect(groups.has(node.group), `${node.id} is in an undeclared group`).toBe(true);
    }
    expect(description.nodes.filter((node) => node.group === 'turn')).toHaveLength(3);
  });

  it('matches the machine edge for edge, in both directions', () => {
    // The picture is the operator's model of the imposter. If it can drift from
    // the machine, it is worse than no picture at all — so every described edge
    // must be a real transition, and every real transition must be described.
    const described = new Set(description.edges.map((edge) => `${edge.from} -${edge.op}-> ${edge.to}`));
    const globals = new Map(description.globals.map((entry) => [entry.op, entry.to]));
    const actual = new Set<string>();

    for (const state of states) {
      for (const op of OP_NAMES) {
        const machine = run(pathTo(state));
        expect(machine.snapshot().state, `pathTo(${state}) did not arrive`).toBe(state);
        const { handled, snapshot } = machine.send(op);
        if (!handled) continue;
        if (globals.has(op)) {
          // A global either lands where it says or changes nothing at all.
          expect(snapshot.state).toBe(globals.get(op) ?? state);
          continue;
        }
        actual.add(`${state} -${op}-> ${snapshot.state}`);
      }
    }

    expect([...actual].sort()).toEqual([...described].sort());
  });

  it('gives every op a place in the picture', () => {
    const drawn = new Set([...description.edges.map((edge) => edge.op), ...description.globals.map((g) => g.op)]);
    expect([...OP_NAMES].filter((op) => !drawn.has(op))).toEqual([]);
  });
});
