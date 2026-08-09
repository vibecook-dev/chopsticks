/**
 * The claude persona's scenario pack is executable, schema-valid data.
 *
 * This lived in `adapter-claude` while the stand-in was a per-adapter bin. The
 * scenarios are persona-owned now (draft/IMPOSTER.md §3.1), and validating them
 * through `persona.validate` rather than a hand-rolled schema lookup means the
 * check runs against exactly the model the imposter would refuse them with.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from '../session/channels/transcript.ts';
import { createScenarioRunner, scenarioSteps } from '../session/scenario.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('claude');
const scenarioDir = join(personaDirectory('claude'), 'scenarios');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('claude persona scenarios', () => {
  it('ships the required starter scenarios as executable, schema-valid data', async () => {
    const required = [
      'happy-turn',
      'permission-allow',
      'permission-deny',
      'late-after-exit',
      'duplicate-out-of-order',
      'unknown-event',
      'flood',
      'crash-mid-turn',
      'channel-disconnect',
      'token-usage-refresh',
    ];
    const available = readdirSync(scenarioDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''));
    expect(available).toEqual(expect.arrayContaining(required));

    for (const name of required) {
      const document = JSON.parse(readFileSync(join(scenarioDir, `${name}.json`), 'utf8')) as { name: string };
      expect(document.name).toBe(name);
      const directory = mkdtempSync(join(tmpdir(), `chopsticks-${name}-`));
      temporaryDirectories.push(directory);
      const transcriptPath = join(directory, 'transcript.jsonl');
      const faults: string[] = [];
      const statuslines: Array<Record<string, unknown>> = [];
      const runner = createScenarioRunner({
        emit: async () => {},
        transcript: createTranscriptWriter(transcriptPath),
        statusline: async (payload) => {
          statuslines.push(payload);
        },
        fault: (fault) => {
          faults.push(fault.kind);
        },
        validate: (event, payload) =>
          persona.validate(event, {
            session_id: 'session',
            transcript_path: transcriptPath,
            cwd: directory,
            permission_mode: 'default',
            ...payload,
            hook_event_name: event,
          }),
        bindings: {
          $sessionTitle: 'scenario-test',
          $permissionMode: 'default',
          $sessionId: 'session',
          $transcriptPath: transcriptPath,
          $cwd: directory,
          $vendorVersion: persona.version,
          $modelId: 'claude-imposter',
          $capacityTokens: 200_000,
          $reply: 'imposter: ok',
        },
      });
      await runner.run(scenarioSteps(document), { text: 'test prompt' }, { speed: 100 });
      if (name === 'token-usage-refresh') expect(statuslines).toHaveLength(1);
      if (['flood', 'crash-mid-turn', 'channel-disconnect'].includes(name)) expect(faults).toHaveLength(1);
    }
  });
});
