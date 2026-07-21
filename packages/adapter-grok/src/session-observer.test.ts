import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGrokSessionObserver, GrokUpdateNormalizer, type GrokObservedEvent } from './session-observer.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(update: Record<string, unknown>, promptId?: string): unknown {
  return {
    timestamp: 1_784_669_125,
    method:
      update.sessionUpdate === 'turn_completed' || update.sessionUpdate === 'hook_execution'
        ? '_x.ai/session/update'
        : 'session/update',
    params: {
      sessionId: 'grok-session',
      update,
      _meta: promptId ? { promptId, agentTimestampMs: 1_784_669_125_000 } : undefined,
    },
  };
}

function twoTurnRecords(): unknown[] {
  return [
    record({ sessionUpdate: 'hook_execution', event_name: 'session_start' }),
    record({ sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit', prompt_id: 'prompt-1' }),
    record({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first question' } }),
    record({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought' } }, 'prompt-1'),
    record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' } }, 'prompt-1'),
    record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }, 'prompt-1'),
    record({ sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'end_turn' }),
    record({ sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit', prompt_id: 'prompt-2' }),
    record({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second question' } }),
    record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second answer' } }, 'prompt-2'),
    record({ sessionUpdate: 'turn_completed', prompt_id: 'prompt-2', stop_reason: 'end_turn' }),
  ];
}

describe('GrokUpdateNormalizer', () => {
  it('frames two terminal-authored turns with stable, distinct message identities', () => {
    const normalizer = new GrokUpdateNormalizer();
    const events = twoTurnRecords().flatMap((entry) => normalizer.normalize(entry));

    expect(events.filter(({ event }) => event.type === 'turn.started').map(({ event }) => event)).toEqual([
      { type: 'turn.started', turnId: 'prompt-1', prompt: 'first question' },
      { type: 'turn.started', turnId: 'prompt-2', prompt: 'second question' },
    ]);
    const assistant = events
      .filter(({ event }) => event.type === 'assistant.message' && event.final)
      .map(({ event, promptId }) => ({ event, promptId }));
    expect(assistant).toEqual([
      {
        promptId: 'prompt-1',
        event: expect.objectContaining({
          messageId: 'grok-assistant:prompt-1',
          text: 'first answer',
          final: true,
        }),
      },
      {
        promptId: 'prompt-2',
        event: expect.objectContaining({
          messageId: 'grok-assistant:prompt-2',
          text: 'second answer',
          final: true,
        }),
      },
    ]);
    expect(events.filter(({ event }) => event.type === 'turn.completed').map(({ promptId }) => promptId)).toEqual([
      'prompt-1',
      'prompt-2',
    ]);
    expect(events.some(({ event }) => event.type === 'reasoning.summary')).toBe(false);
  });

  it('correlates a user echo even when no user-prompt hook supplies the UUID', () => {
    const normalizer = new GrokUpdateNormalizer();
    expect(
      normalizer.normalize(
        record({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hookless question' },
          _meta: { promptIndex: 0 },
        }),
      ),
    ).toEqual([]);

    const events = normalizer.normalize(
      record(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hookless answer' } },
        'real-prompt',
      ),
    );
    expect(events.map(({ event }) => event)).toEqual([
      { type: 'turn.started', turnId: 'real-prompt', prompt: 'hookless question' },
      expect.objectContaining({
        type: 'assistant.message',
        messageId: 'grok-assistant:real-prompt',
        turnId: 'real-prompt',
        text: 'hookless answer',
      }),
    ]);
    expect(events.map(({ promptId }) => promptId)).toEqual(['real-prompt', 'real-prompt']);
  });
});

describe('createGrokSessionObserver', () => {
  it('tails appended JSONL once and waits for a complete line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-grok-observer-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    const [first, ...rest] = twoTurnRecords();
    const partial = JSON.stringify(first);
    await writeFile(path, partial);

    const observer = createGrokSessionObserver(path, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));

    await observer.poll();
    expect(received).toHaveLength(0);

    await appendFile(path, `\n${rest.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    await observer.poll();
    const firstCount = received.length;
    await observer.poll();
    observer.stop();

    expect(firstCount).toBeGreaterThan(0);
    expect(received).toHaveLength(firstCount);
    expect(received.filter(({ event }) => event.type === 'turn.started')).toHaveLength(2);
    expect(received.filter(({ event }) => event.type === 'turn.completed')).toHaveLength(2);
  });
});
