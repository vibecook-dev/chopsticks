import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHookEmitter,
  createPasteDecoder,
  createScenarioRunner,
  createTranscriptWriter,
  type PasteOperation,
} from './engine.js';

describe('createPasteDecoder', () => {
  it('decodes a paste followed by Enter as submitted', () => {
    const pastes: PasteOperation[] = [];
    const decoder = createPasteDecoder((operation) => pastes.push(operation));
    decoder.feed('\x1b[200~hello world\x1b[201~\r');
    expect(pastes).toEqual([{ text: 'hello world', submit: true }]);
  });

  it('decodes paste-only (no Enter) after the hold timer', async () => {
    const pastes: PasteOperation[] = [];
    const decoder = createPasteDecoder((operation) => pastes.push(operation), undefined, 5);
    decoder.feed('\x1b[200~staged\x1b[201~');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pastes).toEqual([{ text: 'staged', submit: false }]);
  });

  it('handles pastes split across chunks and Enter in a later chunk', () => {
    const pastes: PasteOperation[] = [];
    const decoder = createPasteDecoder((operation) => pastes.push(operation), undefined, 50);
    decoder.feed('\x1b[200~hel');
    decoder.feed('lo\x1b[201~');
    decoder.feed('\r');
    expect(pastes).toEqual([{ text: 'hello', submit: true }]);
  });

  it('passes plain input through separately', () => {
    const pastes: PasteOperation[] = [];
    const input: string[] = [];
    const decoder = createPasteDecoder(
      (operation) => pastes.push(operation),
      (text) => input.push(text),
      5,
    );
    decoder.feed('ls -la');
    expect(pastes).toEqual([]);
    expect(input.join('')).toBe('ls -la');
  });
});

// ---------------------------------------------------------------------------

describe('createHookEmitter', () => {
  let server: Server;
  let received: Array<{ url: string; headers: unknown; body: string }>;
  let endpoint: string;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('POSTs http handlers with env-resolved bearer and the event name merged in', async () => {
    const emitter = createHookEmitter({
      settings: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'http',
                  url: endpoint,
                  headers: { Authorization: 'Bearer $CHOPSTICKS_HOOK_TOKEN' },
                  allowedEnvVars: ['CHOPSTICKS_HOOK_TOKEN'],
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
      env: { CHOPSTICKS_HOOK_TOKEN: 'sekrit' },
    });
    await emitter.emit('Stop', { session_id: 'abc', stop_hook_active: false });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers).toMatchObject({ authorization: 'Bearer sekrit' });
    expect(JSON.parse(received[0]!.body)).toEqual({
      session_id: 'abc',
      stop_hook_active: false,
      hook_event_name: 'Stop',
    });
  });

  it('delivers the repo curl-forwarder shape as a direct POST (no sh needed)', async () => {
    const command = `sh -c 'curl -s -m 5 -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $CHOPSTICKS_HOOK_TOKEN" --data-binary @- ${endpoint}'`;
    const emitter = createHookEmitter({
      settings: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } },
      env: { CHOPSTICKS_HOOK_TOKEN: 'sekrit' },
    });
    await emitter.emit('SessionStart', { session_id: 'abc', source: 'startup' });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers).toMatchObject({ authorization: 'Bearer sekrit' });
    // The forwarder string ends with a closing quote — the URL must be
    // extracted without it (a real bridge routes strictly on the path).
    expect(received[0]!.url).toBe('/hooks');
  });

  it('drops unwired events without throwing', async () => {
    const dropped: string[] = [];
    const emitter = createHookEmitter({ settings: { hooks: {} }, env: {}, log: (m) => dropped.push(m) });
    await emitter.emit('StopFailure', { session_id: 'abc' });
    expect(received).toHaveLength(0);
    expect(dropped[0]).toContain('StopFailure');
  });

  it('serializes emissions in call order', async () => {
    const emitter = createHookEmitter({
      settings: {
        hooks: { A: [{ hooks: [{ type: 'http', url: endpoint, headers: {}, timeout: 5 }] }] },
      },
      env: {},
    });
    await emitter.emit('A', { n: 1 });
    await emitter.emit('A', { n: 2 });
    expect(received.map((r) => JSON.parse(r.body).n)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------

describe('createTranscriptWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-engine-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends JSONL records and partial fragments', () => {
    const path = join(dir, 'nested', 'session.jsonl');
    const writer = createTranscriptWriter(path);
    writer.append({ type: 'user', text: 'hi' });
    writer.appendPartial('{"type":"assis');
    const content = readFileSync(path, 'utf8');
    expect(content).toBe('{"type":"user","text":"hi"}\n{"type":"assis');
  });
});

// ---------------------------------------------------------------------------

describe('createScenarioRunner', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-engine-'));
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
});
