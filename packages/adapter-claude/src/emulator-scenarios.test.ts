import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createScenarioRunner, createTranscriptWriter, type ScenarioStep } from '@vibecook/chopsticks-emulator/engine';
import { loadModel, validatePayload } from '@vibecook/chopsticks-surface';

const adapterRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const scenarioDir = join(adapterRoot, 'surface', 'emulator', 'scenarios');
const model = loadModel(join(adapterRoot, 'surface', 'model', 'claude@2.1.207'));
const schemas = new Map(model.events.map((event) => [event.event, event.payloadSchema]));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Claude emulator scenarios', () => {
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
      const document = JSON.parse(readFileSync(join(scenarioDir, `${name}.json`), 'utf8')) as {
        name: string;
        steps?: ScenarioStep[];
        then?: ScenarioStep[];
      };
      expect(document.name).toBe(name);
      const directory = mkdtempSync(join(tmpdir(), `chopsticks-${name}-`));
      temporaryDirectories.push(directory);
      const faults: string[] = [];
      const statuslines: Array<Record<string, unknown>> = [];
      const runner = createScenarioRunner({
        emit: async () => {},
        transcript: createTranscriptWriter(join(directory, 'transcript.jsonl')),
        statusline: async (payload) => {
          statuslines.push(payload);
        },
        fault: (fault) => {
          faults.push(fault.kind);
        },
        validate: (event, payload) => {
          const schema = schemas.get(event);
          return schema
            ? validatePayload(schema, {
                session_id: 'session',
                transcript_path: join(directory, 'transcript.jsonl'),
                cwd: directory,
                permission_mode: 'default',
                ...payload,
                hook_event_name: event,
              })
            : [];
        },
        bindings: {
          $sessionTitle: 'scenario-test',
          $permissionMode: 'default',
          $sessionId: 'session',
          $transcriptPath: join(directory, 'transcript.jsonl'),
          $cwd: directory,
          $vendorVersion: model.manifest.vendorVersion,
          $modelId: 'claude-emulator',
          $capacityTokens: 200_000,
          $reply: 'emulator: ok',
        },
      });
      await runner.run(document.steps ?? document.then ?? [], { text: 'test prompt' }, { speed: 100 });
      if (name === 'token-usage-refresh') expect(statuslines).toHaveLength(1);
      if (['flood', 'crash-mid-turn', 'channel-disconnect'].includes(name)) expect(faults).toHaveLength(1);
    }
  });
});
