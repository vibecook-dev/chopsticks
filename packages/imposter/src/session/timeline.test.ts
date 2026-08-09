import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPersona } from '../persona/load.ts';
import { createTranscriptWriter } from './channels/transcript.ts';
import { createOpTimeline, type PresentationFrame } from './timeline.ts';

describe('createOpTimeline', () => {
  let dir: string;
  let hooks: Array<[string, Record<string, unknown>]>;
  let frames: PresentationFrame[];
  let statuslineCalls: number;

  const build = (bindings: Record<string, unknown> = {}) => {
    const transcript = createTranscriptWriter(join(dir, 't.jsonl'));
    return createOpTimeline({
      persona: loadPersona('claude'),
      emitHook: async (event, payload) => {
        hooks.push([event, payload]);
      },
      transcript,
      statusline: async () => {
        statuslineCalls += 1;
      },
      present: (frame) => frames.push(frame),
      bindings: { $sessionTitle: 'test', $permissionMode: 'default', $claudeMdPath: '/tmp/CLAUDE.md', ...bindings },
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-timeline-'));
    hooks = [];
    frames = [];
    statuslineCalls = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fans one op out to BOTH projections (IMPOSTER.md §2)', async () => {
    const timeline = build();
    await timeline.run({ op: 'turn.start', with: { text: 'refactor the parser' } });
    // Semantic projection: the hook, carrying the op's argument.
    expect(hooks.map(([event]) => event)).toEqual(['UserPromptSubmit']);
    expect(hooks[0]![1]).toMatchObject({ prompt: 'refactor the parser' });
    // Presentation projection: exactly one frame, for the same op.
    expect(frames.map((frame) => frame.op)).toEqual(['turn.start']);
    // ...and the same op fans to the transcript too, per claude's ops.json.
    const record = JSON.parse(readFileSync(join(dir, 't.jsonl'), 'utf8').trim());
    expect(record).toMatchObject({ type: 'user', message: { content: 'refactor the parser' } });
  });

  it('presents exactly one frame per op, so the screen cannot claim a turn the wire never saw', async () => {
    const timeline = build();
    const ops = [
      { op: 'turn.start', with: { text: 'go' } },
      { op: 'tool.start', with: { tool: 'Bash', input: { command: 'ls' } } },
      { op: 'tool.end', with: { tool: 'Bash', input: { command: 'ls' }, output: { ok: true } } },
      { op: 'turn.end', with: { text: 'done' } },
    ];
    await timeline.runAll(ops);
    expect(frames.map((frame) => frame.op)).toEqual(ops.map((op) => op.op));
    expect(hooks.map(([event]) => event)).toEqual(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
  });

  it('correlates $uuid:prompt across the ops of one turn, and separates turns', async () => {
    const timeline = build();
    timeline.beginTurn();
    await timeline.run({ op: 'turn.start', with: { text: 'first' } });
    await timeline.run({ op: 'turn.end', with: { text: 'ok' } });
    const firstTurn = hooks.map(([, payload]) => payload.prompt_id);
    expect(firstTurn[0]).toBe(firstTurn[1]); // one prompt_id through the turn

    hooks = [];
    timeline.beginTurn();
    await timeline.run({ op: 'turn.start', with: { text: 'second' } });
    expect(hooks[0]![1].prompt_id).not.toBe(firstTurn[0]); // a new turn is a new id
  });

  it('routes usage.refresh to the statusline channel', async () => {
    const timeline = build();
    await timeline.run({ op: 'usage.refresh' });
    expect(statuslineCalls).toBe(1);
    expect(hooks).toEqual([]);
  });

  it('logs an unbound op rather than crashing the imposted process', async () => {
    const logged: string[] = [];
    const timeline = createOpTimeline({
      persona: loadPersona('claude'),
      emitHook: async () => {},
      transcript: createTranscriptWriter(join(dir, 't.jsonl')),
      log: (message) => logged.push(message),
    });
    await expect(timeline.run({ op: 'assistant.reasoning' })).resolves.toBeUndefined();
    expect(logged.join('\n')).toContain('assistant.reasoning');
  });

  it('runs the persona boot sequence end to end', async () => {
    const persona = loadPersona('claude');
    const timeline = build();
    await timeline.runAll(persona.document.boot);
    // session.ready -> InstructionsLoaded is the driver's boot-finished signal.
    expect(hooks.map(([event]) => event)).toEqual(['SessionStart', 'InstructionsLoaded']);
    expect(statuslineCalls).toBe(1);
  });
});
