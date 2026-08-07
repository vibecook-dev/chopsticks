import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  diffModelVsReport,
  loadModel,
  validatePayload,
  type PayloadSchema,
  type SurfaceModel,
} from './model.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chopsticks-asm-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validatePayload', () => {
  const schema: PayloadSchema = {
    type: 'object',
    required: ['session_id', 'prompt'],
    properties: {
      session_id: { type: 'string' },
      prompt: { type: 'string' },
      background_tasks: { type: 'array' },
      effort: { type: 'object' },
      stop_hook_active: { type: 'boolean' },
    },
  };

  it('accepts a payload satisfying the schema', () => {
    expect(validatePayload(schema, { session_id: 'x', prompt: 'hi' })).toEqual([]);
  });

  it('flags missing required fields', () => {
    expect(validatePayload(schema, { session_id: 'x' })).toEqual(['missing required field "prompt"']);
  });

  it('flags top-level type mismatches, arrays as arrays, null as null', () => {
    const violations = validatePayload(schema, {
      session_id: 'x',
      prompt: 'hi',
      background_tasks: {},
      effort: null,
      stop_hook_active: 'yes',
    });
    expect(violations).toEqual([
      'field "background_tasks" is object, expected array',
      'field "effort" is null, expected object',
      'field "stop_hook_active" is string, expected boolean',
    ]);
  });

  it('rejects non-object payloads', () => {
    expect(validatePayload(schema, [1, 2])).toEqual(['payload is array, expected object']);
    expect(validatePayload(schema, 'x')).toEqual(['payload is string, expected object']);
  });

  it('enforces enums when present', () => {
    const withEnum: PayloadSchema = {
      type: 'object',
      properties: { level: { type: 'string', enum: ['high', 'low'] } },
    };
    expect(validatePayload(withEnum, { level: 'high' })).toEqual([]);
    expect(validatePayload(withEnum, { level: 'xhigh' })).toEqual(['field "level" value not in enum']);
  });
});

// ---------------------------------------------------------------------------

function writeModel(modelDir: string, events: Record<string, unknown>[]): void {
  mkdirSync(join(modelDir, 'events'), { recursive: true });
  writeFileSync(
    join(modelDir, 'manifest.json'),
    JSON.stringify({ asmVersion: 1, vendor: 'fake', vendorVersion: '1.0.0', generatedAt: '2026-08-07' }),
  );
  writeFileSync(join(modelDir, 'detection.json'), JSON.stringify({ executables: ['fake'] }));
  writeFileSync(join(modelDir, 'channels.json'), JSON.stringify({ channels: { hook: { kind: 'hook-http' } } }));
  for (const event of events) {
    writeFileSync(join(modelDir, 'events', `${event.event as string}.json`), JSON.stringify(event));
  }
}

function eventFile(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    surface: 'fake',
    surfaceVersion: '1.0.0',
    channel: 'hook',
    confidence: 'verified-headless',
    fixture: 'captures/fake.jsonl',
    firstSeen: '1.0.0',
    lastVerified: '1.0.0',
    ...overrides,
  };
}

describe('loadModel', () => {
  it('loads a model dir with events sorted by name', () => {
    writeModel(dir, [eventFile({ event: 'Stop' }), eventFile({ event: 'SessionStart' })]);
    const model = loadModel(dir);
    expect(model.manifest.vendor).toBe('fake');
    expect(model.events.map((event) => event.event)).toEqual(['SessionStart', 'Stop']);
  });

  it('throws on a malformed event file', () => {
    writeModel(dir, [{ event: 'Broken' }]);
    expect(() => loadModel(dir)).toThrow(/missing required field/);
  });

  it('throws on an unsupported asmVersion', () => {
    writeModel(dir, [eventFile({ event: 'Stop' })]);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ asmVersion: 99, vendor: 'fake', vendorVersion: '1.0.0', generatedAt: '2026-08-07' }),
    );
    expect(() => loadModel(dir)).toThrow(/asmVersion/);
  });

  it('rejects cross-document identity and channel drift', () => {
    writeModel(dir, [eventFile({ event: 'Stop', surfaceVersion: '2.0.0' })]);
    expect(() => loadModel(dir)).toThrow(/surface identity/);

    writeModel(dir, [eventFile({ event: 'Stop', channel: 'transcript' })]);
    expect(() => loadModel(dir)).toThrow(/unknown channel/);
  });

  it('rejects malformed payload schemas before they reach an audit', () => {
    writeModel(dir, [
      eventFile({
        event: 'Stop',
        payloadSchema: { type: 'object', required: ['session_id'], properties: {} },
      }),
    ]);
    expect(() => loadModel(dir)).toThrow(/required payload field "session_id"/);
  });

  it('rejects unknown confidence values and incomplete verification evidence', () => {
    writeModel(dir, [eventFile({ event: 'Stop', confidence: 'probably-verified' })]);
    expect(() => loadModel(dir)).toThrow(/confidence must be/);

    writeModel(dir, [eventFile({ event: 'Stop', lastVerified: undefined })]);
    expect(() => loadModel(dir)).toThrow(/fixture, firstSeen, and lastVerified/);
  });
});

// ---------------------------------------------------------------------------

function writeCaptures(capturesDir: string, files: Record<string, object[]>): void {
  for (const [name, lines] of Object.entries(files)) {
    const path = join(capturesDir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }
}

describe('buildReport', () => {
  it('counts events and field presence across nested capture dirs', () => {
    writeCaptures(dir, {
      'headless/Stop.jsonl': [
        { hook_event_name: 'Stop', session_id: 'a', stop_hook_active: false },
        { hook_event_name: 'Stop', session_id: 'b', stop_hook_active: true, extra: 1 },
      ],
      'interactive/Notification.jsonl': [{ hook_event_name: 'Notification', session_id: 'a', message: 'm' }],
    });
    const report = buildReport(dir);
    expect(report.unparsedLines).toBe(0);
    expect(report.events.map((event) => event.event)).toEqual(['Notification', 'Stop']);
    const stop = report.events[1]!;
    expect(stop.count).toBe(2);
    expect(stop.fields).toEqual({ extra: 1, hook_event_name: 2, session_id: 2, stop_hook_active: 2 });
  });

  it('falls back to the file basename', () => {
    writeCaptures(dir, { 'Custom.jsonl': [{ no_event_name: true }] });
    const report = buildReport(dir);
    expect(report.events[0]!.event).toBe('Custom');
  });

  it('records invalid JSON and envelopes without retaining payload values', () => {
    writeFileSync(join(dir, 'Broken.jsonl'), '{not json}\n42\n');
    const report = buildReport(dir);
    expect(report.unparsedLines).toBe(2);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['invalid-json', 'invalid-envelope']);
    expect(JSON.stringify(report.issues)).not.toContain('{not json}');
  });

  it('flags empty or misplaced event names in fixture files', () => {
    writeCaptures(dir, {
      'Stop.jsonl': [{ hook_event_name: '' }, { hook_event_name: 'Notification' }],
    });
    const report = buildReport(dir);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['invalid-envelope', 'invalid-envelope']);
    expect(report.issues[1]!.message).toContain('fixture filename "Stop"');
  });
});

// ---------------------------------------------------------------------------

describe('diffModelVsReport', () => {
  function modelWith(events: Record<string, unknown>[]): SurfaceModel {
    writeModel(dir, events);
    return loadModel(dir);
  }

  it('is clean when model and captures agree', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          required: ['session_id'],
          properties: {
            session_id: { type: 'string' },
            stop_hook_active: { type: 'boolean' },
            hook_event_name: { type: 'string' },
          },
        },
      }),
      eventFile({ event: 'Speculative', confidence: 'unverified' }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, {
      'Stop.jsonl': [{ hook_event_name: 'Stop', session_id: 'a', stop_hook_active: false }],
    });
    expect(diffModelVsReport(model, buildReport(capturesDir))).toEqual([]);
  });

  it('flags observed-unmodeled events', () => {
    const model = modelWith([eventFile({ event: 'Stop' })]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, { 'NewEvent.jsonl': [{ hook_event_name: 'NewEvent', x: 1 }] });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    const unmodeled = drift.filter((entry) => entry.kind === 'observed-unmodeled');
    expect(unmodeled).toHaveLength(1);
    expect(unmodeled[0]!.event).toBe('NewEvent');
  });

  it('flags unobserved-verified but not unobserved-unverified', () => {
    const model = modelWith([
      eventFile({ event: 'Stop' }),
      eventFile({ event: 'Speculative', confidence: 'unverified' }),
    ]);
    const capturesDir = join(dir, 'captures');
    mkdirSync(capturesDir, { recursive: true });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    expect(drift.map((entry) => entry.kind)).toEqual(['unobserved-verified']);
    expect(drift[0]!.event).toBe('Stop');
  });

  it('flags required fields missing from some captured lines', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          required: ['session_id'],
          properties: { session_id: { type: 'string' }, hook_event_name: { type: 'string' } },
        },
      }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, {
      'Stop.jsonl': [{ hook_event_name: 'Stop', session_id: 'a' }, { hook_event_name: 'Stop' }],
    });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    expect(drift.map((entry) => entry.kind)).toEqual(['schema-mismatch']);
    expect(drift[0]!.message).toContain('1/2');
  });

  it('flags captured fields the schema does not model', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          properties: { session_id: { type: 'string' }, hook_event_name: { type: 'string' } },
        },
      }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, { 'Stop.jsonl': [{ hook_event_name: 'Stop', session_id: 'a', brand_new: 1 }] });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    expect(drift.map((entry) => entry.kind)).toEqual(['unmodeled-field']);
    expect(drift[0]!.message).toContain('brand_new');
  });

  it('validates the type and enum of every captured payload', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          properties: {
            hook_event_name: { type: 'string', enum: ['Stop'] },
            session_id: { type: 'string' },
            mode: { type: 'string', enum: ['default', 'plan'] },
          },
        },
      }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, {
      'Stop.jsonl': [
        { hook_event_name: 'Stop', session_id: 42, mode: 'surprise' },
        { hook_event_name: 'NotStop', session_id: 'a' },
      ],
    });
    const report = buildReport(capturesDir, model);
    const drift = diffModelVsReport(model, report);
    expect(report.validatedAgainst).toEqual({ vendor: 'fake', vendorVersion: '1.0.0' });
    expect(drift.some((entry) => entry.kind === 'schema-mismatch' && entry.message.includes('expected string'))).toBe(
      true,
    );
    expect(drift.some((entry) => entry.kind === 'schema-mismatch' && entry.message.includes('not in enum'))).toBe(true);
    expect(drift.some((entry) => entry.kind === 'observed-unmodeled' && entry.event === 'NotStop')).toBe(true);
  });

  it('fails drift when any capture line is malformed', () => {
    const model = modelWith([eventFile({ event: 'Stop' })]);
    const capturesDir = join(dir, 'captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, 'Stop.jsonl'), '{broken}\n');
    const drift = diffModelVsReport(model, buildReport(capturesDir, model));
    expect(drift.some((entry) => entry.kind === 'invalid-capture')).toBe(true);
  });
});
