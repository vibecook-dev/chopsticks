import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from './channels/transcript.ts';
import { createScenarioGate, createScenarioRunner } from './scenario.ts';

describe('createScenarioRunner', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-imposter-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('substitutes stimulus, named uuids, $now, and bindings; keeps order', async () => {
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const writer = createTranscriptWriter(join(dir, 't.jsonl'));
    const runner = createScenarioRunner({
      emit: async (event, payload) => {
        emitted.push([event, payload]);
      },
      transcript: writer,
      bindings: { $reply: 'done!' },
    });
    await runner.run(
      [
        { emit: { event: 'UserPromptSubmit', with: { prompt: '$stimulus.text', prompt_id: '$uuid:p' } } },
        { transcript: { record: { type: 'assistant', ts: '$now', text: '$reply' } } },
        { delay: { ms: 1 } },
        { emit: { event: 'Stop', with: { prompt_id: '$uuid:p', last_assistant_message: '$reply' } } },
      ],
      { text: 'hello' },
    );
    const [, promptPayload] = emitted[0]!;
    const [, stopPayload] = emitted[1]!;
    expect(promptPayload).toMatchObject({ prompt: 'hello' });
    expect(stopPayload).toMatchObject({ last_assistant_message: 'done!' });
    expect(stopPayload.prompt_id).toBe(promptPayload.prompt_id); // named uuid reused
    const lines = readFileSync(join(dir, 't.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'assistant', text: 'done!' });
  });

  it('fails the run when validation rejects the payload', async () => {
    const runner = createScenarioRunner({
      emit: async () => {},
      transcript: createTranscriptWriter(join(dir, 't.jsonl')),
      validate: (event) => (event === 'Stop' ? ['missing required field "prompt_id"'] : []),
    });
    await expect(runner.run([{ emit: { event: 'Stop', with: {} } }])).rejects.toThrow(/off-model/);
  });

  it('validates against the payload AFTER template substitution', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const runner = createScenarioRunner({
      emit: async () => {},
      transcript: createTranscriptWriter(join(dir, 't.jsonl')),
      validate: (_event, payload) => {
        seen.push(payload);
        return [];
      },
    });
    await runner.run([{ emit: { event: 'UserPromptSubmit', with: { prompt: '$stimulus.text' } } }], { text: 'real' });
    expect(seen[0]).toMatchObject({ prompt: 'real' });
  });

  it('runs documented at/do timelines and rejects out-of-order timestamps', async () => {
    const emitted: string[] = [];
    const runner = createScenarioRunner({
      emit: async (event) => {
        emitted.push(event);
      },
      transcript: createTranscriptWriter(join(dir, 't.jsonl')),
    });
    await runner.run([
      { at: 0, do: { emit: { event: 'First' } } },
      { at: 0, do: { emit: { event: 'Second', afterMs: 0 } } },
    ]);
    expect(emitted).toEqual(['First', 'Second']);
    await expect(
      runner.run(
        [
          { at: 2, do: { emit: { event: 'First' } } },
          { at: 1, do: { emit: { event: 'Second' } } },
        ],
        undefined,
        { speed: 100 },
      ),
    ).rejects.toThrow(/timeline/);
  });

  it('rejects empty and multi-action scenario steps', async () => {
    const emitted: string[] = [];
    const runner = createScenarioRunner({
      emit: async (event) => {
        emitted.push(event);
      },
      transcript: createTranscriptWriter(join(dir, 't.jsonl')),
    });
    await expect(runner.run([{}])).rejects.toThrow(/exactly one action/);
    await expect(runner.run([{ delay: { ms: 0 }, emit: { event: 'Stop' } }])).rejects.toThrow(/exactly one action/);
    await expect(runner.run([{ delay: { ms: 300_001 } }])).rejects.toThrow(/scenario delay/);
    await expect(runner.run([{ fault: { kind: 'flood', count: 10_001 } }])).rejects.toThrow(/fault count/);
    await expect(runner.run([{ emit: { event: 'Stop', with: [] as never } }])).rejects.toThrow(/emit.with/);
    // The whole script validates before ANY side effect: a bad step at the end
    // must prevent the good step at the front from emitting (§7.3 item 2).
    await expect(runner.run([{ emit: { event: 'MustNotEmit' } }, { delay: { ms: 300_001 } }])).rejects.toThrow(
      /scenario delay/,
    );
    expect(emitted).toEqual([]);
  });

  it('crash fault writes the partial line then crashes', async () => {
    const crashes: number[] = [];
    const runner = createScenarioRunner({
      emit: async () => {},
      transcript: createTranscriptWriter(join(dir, 't.jsonl')),
      crash: (code) => crashes.push(code),
    });
    await runner.run([
      { emit: { event: 'PreToolUse', with: { tool_name: 'Bash' } } },
      { fault: { kind: 'crash', exitCode: 137, partialTranscriptLine: '{"type":"assis' } },
    ]);
    expect(crashes).toEqual([137]);
    expect(readFileSync(join(dir, 't.jsonl'), 'utf8')).toBe('{"type":"assis');
  });

  it('prepares without touching a channel, so a paused run can answer immediately', () => {
    const emitted: string[] = [];
    const runner = createScenarioRunner({
      emit: async (event) => void emitted.push(event),
      transcript: createTranscriptWriter(join(dir, 't.jsonl')),
    });
    const prepared = runner.prepare([{ emit: { event: 'Stop' } }, { emit: { event: 'Stop' } }]);
    expect(prepared.steps).toBe(2);
    expect(emitted).toEqual([]);
  });
});

describe('createScenarioGate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-imposter-gate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  const gatedRunner = (emitted: string[], dir: string) =>
    createScenarioRunner({
      emit: async (event) => void emitted.push(event),
      transcript: createTranscriptWriter(join(dir, 'gate.jsonl')),
    });

  it('holds a paused scenario and releases exactly one step at a time', async () => {
    const emitted: string[] = [];
    const gate = createScenarioGate('pause');
    const steps = [{ emit: { event: 'a' } }, { emit: { event: 'b' } }, { emit: { event: 'c' } }];
    const done = gatedRunner(emitted, dir).run(steps, {}, { gate });

    await settle();
    expect(emitted).toEqual([]);

    gate.step();
    await settle();
    expect(emitted).toEqual(['a']);

    gate.step();
    await settle();
    expect(emitted).toEqual(['a', 'b']);

    gate.resume();
    await done;
    expect(emitted).toEqual(['a', 'b', 'c']);
  });

  it('pauses a running scenario mid-flight and resumes it', async () => {
    const emitted: string[] = [];
    const gate = createScenarioGate('play');
    const steps = [{ emit: { event: 'a' } }, { delay: { ms: 20 } }, { emit: { event: 'b' } }];
    const done = gatedRunner(emitted, dir).run(steps, {}, { gate });

    gate.pause();
    await settle();
    expect(emitted).toEqual(['a']);
    expect(gate.paused).toBe(true);

    gate.resume();
    await done;
    expect(emitted).toEqual(['a', 'b']);
  });

  it('banks a step that arrives before the runner reaches the gate', async () => {
    const gate = createScenarioGate('pause');
    gate.step();
    gate.step();
    await expect(gate.wait()).resolves.toBeUndefined();
    await expect(gate.wait()).resolves.toBeUndefined();
    let third = false;
    void gate.wait().then(() => (third = true));
    await settle();
    expect(third).toBe(false);
  });
});
