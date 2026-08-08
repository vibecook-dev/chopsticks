import { describe, expect, it } from 'vitest';
import type { SurfaceModel } from '@vibecook/chopsticks-surface';
import {
  defaultSocketPath,
  defaultTokenPath,
  httpStatusForCode,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  NOT_FOUND,
  paletteFromModel,
  parseFault,
  parseHello,
  parseScenarioControl,
  parseScenarioRun,
  parseTrigger,
  REFUSED,
} from './protocol.ts';

const hello = {
  token: 'secret',
  vendor: 'claude',
  version: '2.1.207',
  sessionId: 'd0ffe3f0-0000-4000-8000-000000000000',
  pid: 4242,
  cwd: '/work',
  channels: ['hook', 'hook', 'transcript'],
  palette: [{ event: 'Notification', fields: ['message', 'message', 'prompt_id'] }],
};

describe('control protocol', () => {
  it('parses a hello and collapses duplicate channels and fields', () => {
    const parsed = parseHello(hello);
    expect(parsed.channels).toEqual(['hook', 'transcript']);
    expect(parsed.palette[0]!.fields).toEqual(['message', 'prompt_id']);
  });

  it('refuses a hello with an unusable pid or a multi-line field', () => {
    expect(() => parseHello({ ...hello, pid: 0 })).toThrow(/pid/);
    expect(() => parseHello({ ...hello, vendor: 'cla\nude' })).toThrow(/vendor/);
  });

  it('defaults a trigger payload to an empty object but not to a non-object', () => {
    expect(parseTrigger({ event: 'Stop' })).toEqual({ event: 'Stop', with: {} });
    expect(() => parseTrigger({ event: 'Stop', with: [] })).toThrow(/must be an object/);
    expect(() => parseTrigger({})).toThrow(/event/);
  });

  it('requires exactly one of scenario name or script', () => {
    expect(() => parseScenarioRun({})).toThrow(/exactly one/);
    expect(() => parseScenarioRun({ name: 'flood', script: [] })).toThrow(/exactly one/);
    expect(parseScenarioRun({ name: 'flood' })).toMatchObject({ name: 'flood', mode: 'play', speed: 1 });
  });

  it('bounds scenario mode and speed', () => {
    expect(() => parseScenarioRun({ name: 'flood', mode: 'rewind' })).toThrow(/play\|pause\|step/);
    expect(() => parseScenarioRun({ name: 'flood', speed: 0 })).toThrow(/speed/);
    expect(() => parseScenarioRun({ name: 'flood', speed: 101 })).toThrow(/speed/);
    expect(parseScenarioRun({ name: 'flood', mode: 'pause', speed: 4 })).toMatchObject({ mode: 'pause', speed: 4 });
  });

  it('accepts only the three scenario control actions', () => {
    expect(parseScenarioControl({ action: 'step' })).toEqual({ action: 'step' });
    expect(() => parseScenarioControl({ action: 'rewind' })).toThrow(/pause\|step\|resume/);
  });

  it('checks channel-drop against the session live channels', () => {
    expect(() => parseFault({ kind: 'channel-drop' }, ['hook'])).toThrow(/channel-drop/);
    expect(() => parseFault({ kind: 'channel-drop', channel: 'smoke' }, ['hook'])).toThrow(/channel-drop/);
    expect(parseFault({ kind: 'channel-drop', channel: 'hook' }, ['hook'])).toMatchObject({ channel: 'hook' });
  });

  it('bounds a flood count and rejects an unknown fault kind', () => {
    expect(() => parseFault({ kind: 'meltdown' })).toThrow(/fault kind/);
    expect(() => parseFault({ kind: 'flood', count: 10_001 })).toThrow(/count/);
    expect(parseFault({ kind: 'flood', count: 250, event: 'Notification' })).toMatchObject({ count: 250 });
  });

  it('maps JSON-RPC codes onto the statuses the console already expects', () => {
    expect(httpStatusForCode(REFUSED)).toBe(422);
    expect(httpStatusForCode(NOT_FOUND)).toBe(404);
    expect(httpStatusForCode(METHOD_NOT_FOUND)).toBe(404);
    expect(httpStatusForCode(INVALID_PARAMS)).toBe(400);
    expect(httpStatusForCode(-1)).toBe(500);
  });

  it('derives the palette from the model, sorted and schema-driven', () => {
    const model = {
      events: [
        { event: 'Stop', payloadSchema: { type: 'object', properties: { stop_hook_active: {}, prompt_id: {} } } },
        { event: 'Bare' },
      ],
    } as unknown as SurfaceModel;
    expect(paletteFromModel(model)).toEqual([
      { event: 'Stop', fields: ['prompt_id', 'stop_hook_active'] },
      { event: 'Bare', fields: [] },
    ]);
  });

  it('honours the socket and token overrides so tests never touch the real home', () => {
    expect(defaultSocketPath({ CHOPSTICKS_IMPOSTER_SOCKET: '/tmp/p/x.sock' })).toBe('/tmp/p/x.sock');
    expect(defaultTokenPath({ CHOPSTICKS_IMPOSTER_TOKEN_FILE: '/tmp/p/x.token' })).toBe('/tmp/p/x.token');
    expect(defaultSocketPath({})).toMatch(/imposter\.sock$|chopsticks-imposter$/);
  });
});
