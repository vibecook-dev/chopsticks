/**
 * The codex persona's scenario pack is executable, schema-valid data — the
 * same guard `scenarios.claude.test.ts` puts on the hook family.
 *
 * Codex needs one thing claude does not: approvals are SERVER REQUESTS, not
 * notifications, so the pack is only faithful if the runner can express that.
 * A scenario that emitted an approval as a notification would be scripting
 * traffic the vendor never produces, and no adapter would ever reply to it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from '../session/channels/transcript.ts';
import { createScenarioRunner, scenarioSteps } from '../session/scenario.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('codex');
const scenarioDir = join(personaDirectory('codex'), 'scenarios');
const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

const REQUIRED = [
  'permission-allow',
  'permission-deny',
  'unknown-event',
  'flood',
  'crash-mid-turn',
  'channel-disconnect',
  'token-usage-refresh',
];

describe('codex persona scenarios', () => {
  it('ships the starter set as executable, schema-valid data', async () => {
    const available = readdirSync(scenarioDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''));
    expect(available).toEqual(expect.arrayContaining(REQUIRED));

    for (const name of REQUIRED) {
      const document = JSON.parse(readFileSync(join(scenarioDir, `${name}.json`), 'utf8')) as { name: string };
      expect(document.name).toBe(name);
      const directory = mkdtempSync(join(tmpdir(), `chopsticks-codex-${name}-`));
      temporaries.push(directory);

      const notified: string[] = [];
      const requested: string[] = [];
      const faults: string[] = [];
      const runner = createScenarioRunner({
        emit: async (event) => void notified.push(event),
        request: async (event) => {
          requested.push(event);
          return { decision: 'accept' };
        },
        transcript: createTranscriptWriter(join(directory, 'unused.jsonl')),
        fault: (fault) => void faults.push(fault.kind),
        validate: (event, payload) => persona.validate(event, payload),
        bindings: {
          $threadId: 'a0000000-0000-4000-8000-000000000001',
          $threadCwd: directory,
          $cwd: directory,
          $vendorVersion: persona.version,
        },
      });
      await runner.run(scenarioSteps(document), { text: 'test prompt' }, { speed: 100 });

      if (name.startsWith('permission-')) {
        // The decisive assertion: it went out as a REQUEST.
        expect(requested, `${name} must issue a server request`).toEqual(['item/commandExecution/requestApproval']);
      }
      if (['flood', 'crash-mid-turn', 'channel-disconnect'].includes(name)) {
        expect(faults, `${name} must raise a fault`).toHaveLength(1);
      }
    }
  });

  it('binds every scenario event to a method the ASM actually declares', () => {
    // `unknown-event` is the deliberate exception: ADR-008 retention is only
    // testable with a name the model has never seen.
    const modelled = new Set(persona.model.events.map((event) => event.event));
    const unmodelled = new Set<string>();
    for (const file of readdirSync(scenarioDir).filter((name) => name.endsWith('.json'))) {
      const document = JSON.parse(readFileSync(join(scenarioDir, file), 'utf8')) as { then?: unknown[] };
      for (const step of document.then ?? []) {
        const emit = (step as { do?: { emit?: { event?: string } } }).do?.emit;
        if (emit?.event && !modelled.has(emit.event)) unmodelled.add(`${file}:${emit.event}`);
      }
    }
    expect([...unmodelled]).toEqual(['unknown-event.json:thread/somethingTheModelHasNeverSeen']);
  });
});
