import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assistantMessageEvent,
  createTranscriptObserver,
  projectTranscriptHistory,
  type TranscriptObserver,
  type TranscriptRecordEvent,
} from './transcript-observer.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000f5';

const assistantLine = (id: string, text: string) =>
  `${JSON.stringify({
    type: 'assistant',
    uuid: `${id}-uuid`,
    timestamp: '2026-07-13T00:00:00.000Z',
    requestId: 'req_1',
    message: {
      model: 'claude-fable-5',
      id,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} },
      ],
      stop_reason: null,
    },
  })}\n`;

let observers: TranscriptObserver[] = [];
afterEach(() => {
  for (const o of observers) o.stop();
  observers = [];
});

function startObserver(path: string) {
  const records: TranscriptRecordEvent[] = [];
  // Long fallback interval: tests use notifyActivity(), the hook-signal path.
  const observer = createTranscriptObserver(path, { pollIntervalMs: 60_000 });
  observer.onRecord((r) => records.push(r));
  observers.push(observer);
  return { observer, records };
}

describe('createTranscriptObserver', () => {
  it('streams transcript records on notifyActivity (the hook-signal path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observer-'));
    const file = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, assistantLine('msg_1', 'first answer'));

    const { observer, records } = startObserver(file);
    await observer.notifyActivity();
    expect(records).toHaveLength(1);
    expect(records[0].msgIndex).toBe(0);

    appendFileSync(file, assistantLine('msg_2', 'second answer'));
    await observer.notifyActivity();
    expect(records).toHaveLength(2);
  });

  it('tolerates a transcript that does not exist yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observer-'));
    const file = join(dir, `${SESSION_ID}.jsonl`);
    const { observer, records } = startObserver(file);
    await observer.notifyActivity();
    expect(records).toHaveLength(0);

    writeFileSync(file, assistantLine('msg_1', 'late'));
    await observer.notifyActivity();
    expect(records).toHaveLength(1);
  });
});

describe('assistantMessageEvent', () => {
  it('extracts authoritative text from assistant records (displayOnly: false)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'observer-'));
    const file = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(file, assistantLine('msg_1', 'the real text'));

    const { observer, records } = startObserver(file);
    await observer.notifyActivity();
    const event = assistantMessageEvent(records[0].message);
    expect(event).toEqual({
      type: 'assistant.message',
      messageId: 'msg_1',
      text: 'the real text',
      final: true,
      displayOnly: false,
    });
  });

  it('returns null for non-assistant records', () => {
    expect(assistantMessageEvent({ type: 'user', message: { content: 'hi' } } as never)).toBeNull();
  });
});

describe('projectTranscriptHistory', () => {
  it('reconstructs completed user/assistant turns and ignores synthetic tool-result rows', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'user-1',
        promptId: 'prompt-1',
        timestamp: '2026-07-13T00:00:00.000Z',
        message: { role: 'user', content: 'First question' },
      },
      JSON.parse(assistantLine('assistant-1', 'First answer')),
      {
        type: 'user',
        uuid: 'tool-result',
        timestamp: '2026-07-13T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'result' }],
        },
      },
      {
        type: 'user',
        uuid: 'synthetic',
        timestamp: '2026-07-13T00:00:02.000Z',
        message: { role: 'user', content: '<system-reminder>internal context</system-reminder>' },
      },
      {
        type: 'assistant',
        uuid: 'sidechain-assistant',
        isSidechain: true,
        message: {
          id: 'sidechain-answer',
          role: 'assistant',
          content: [{ type: 'text', text: 'Internal subagent answer' }],
        },
      },
      {
        type: 'user',
        uuid: 'tool-derived-text',
        sourceToolUseID: 'toolu_x',
        message: { role: 'user', content: [{ type: 'text', text: 'Tool-generated context' }] },
      },
      {
        type: 'user',
        uuid: 'user-2',
        timestamp: '2026-07-13T00:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Second question' }] },
      },
      JSON.parse(assistantLine('assistant-2', 'Second answer')),
    ] as never[];

    expect(projectTranscriptHistory(messages).map(({ event }) => event)).toEqual([
      { type: 'turn.started', turnId: 'prompt-1', prompt: 'First question' },
      {
        type: 'assistant.message',
        messageId: 'assistant-1',
        turnId: 'prompt-1',
        text: 'First answer',
        final: true,
        displayOnly: false,
      },
      { type: 'turn.completed', turnId: 'prompt-1', lastAssistantMessage: 'First answer' },
      { type: 'turn.started', turnId: 'user-2', prompt: 'Second question' },
      {
        type: 'assistant.message',
        messageId: 'assistant-2',
        turnId: 'user-2',
        text: 'Second answer',
        final: true,
        displayOnly: false,
      },
      { type: 'turn.completed', turnId: 'user-2', lastAssistantMessage: 'Second answer' },
    ]);
  });

  it('preserves a real prompt after one or more leading synthetic blocks', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'user-with-preamble',
        timestamp: '2026-07-13T00:00:00.000Z',
        message: {
          role: 'user',
          content:
            '<system-reminder>internal context</system-reminder>\n' +
            '<ide_opened_file>/work/repo/file.ts</ide_opened_file>\n' +
            'Explain this implementation',
        },
      },
      JSON.parse(assistantLine('assistant-with-preamble', 'It works like this')),
    ] as never[];

    expect(projectTranscriptHistory(messages).map(({ event }) => event)).toEqual([
      {
        type: 'turn.started',
        turnId: 'user-with-preamble',
        prompt: 'Explain this implementation',
      },
      {
        type: 'assistant.message',
        messageId: 'assistant-with-preamble',
        turnId: 'user-with-preamble',
        text: 'It works like this',
        final: true,
        displayOnly: false,
      },
      {
        type: 'turn.completed',
        turnId: 'user-with-preamble',
        lastAssistantMessage: 'It works like this',
      },
    ]);
  });

  it('marks a final prompt without an assistant response as interrupted', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'interrupted-user',
        timestamp: '2026-07-13T00:00:00.000Z',
        message: { role: 'user', content: 'This turn was interrupted' },
      },
    ] as never[];

    expect(projectTranscriptHistory(messages).map(({ event }) => event)).toEqual([
      {
        type: 'turn.started',
        turnId: 'interrupted-user',
        prompt: 'This turn was interrupted',
      },
      {
        type: 'turn.failed',
        turnId: 'interrupted-user',
        error: 'interrupted before an assistant response',
      },
    ]);
  });
});
