import { describe, expect, it } from 'vitest';
import { createEnvelopeStamper, type AgentEvent } from '@vibecook/chopsticks-core';
import { AgentConversationProjector } from './conversation.js';

function project(events: AgentEvent[]) {
  const stamper = createEnvelopeStamper();
  const projector = new AgentConversationProjector();
  for (const event of events) {
    projector.consume(
      stamper.next({
        sessionId: 's',
        turnId: 'turn-1',
        timestamp: '2026-07-15T00:00:00.000Z',
        monotonicTime: 0,
        source: 'native-hook',
        confidence: 'authoritative',
        event,
      }),
    );
  }
  return projector.snapshot();
}

describe('AgentConversationProjector', () => {
  it('updates streaming Markdown in place instead of creating delta rows', () => {
    const snapshot = project([
      { type: 'turn.started', turnId: 'turn-1', prompt: 'Explain this' },
      { type: 'assistant.message', messageId: 'm1', text: '**par', final: false },
      { type: 'assistant.message', messageId: 'm1', text: '**paragraph**', final: true },
    ]);
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[1]).toMatchObject({ kind: 'assistant', markdown: '**paragraph**', streaming: false });
    expect(snapshot.responding).toBe(false);
  });

  it('projects explicit reasoning separately from tools and summaries', () => {
    const snapshot = project([
      { type: 'reasoning.started', reasoningId: 'r1' },
      { type: 'reasoning.summary', reasoningId: 'r1', text: 'Considered two approaches.', final: false },
      {
        type: 'tool.started',
        toolCallId: 't1',
        tool: 'command',
        presentation: { kind: 'command', title: 'Running command', detail: 'pnpm test' },
      },
      { type: 'tool.completed', toolCallId: 't1', tool: 'command' },
      { type: 'reasoning.completed', reasoningId: 'r1' },
    ]);
    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'activity', activity: 'reasoning', status: 'completed' }),
        expect.objectContaining({ kind: 'activity', activity: 'command', status: 'completed', detail: 'pnpm test' }),
      ]),
    );
  });

  it('tracks permission and delegated work as independent activities', () => {
    const snapshot = project([
      { type: 'permission.requested', requestId: 'p1', tool: 'Bash', presentation: 'native-tui' },
      { type: 'subagent.started', subagentId: 'a1', agentType: 'reviewer' },
      { type: 'permission.resolved', requestId: 'p1', outcome: 'allowed' },
      { type: 'subagent.stopped', subagentId: 'a1' },
    ]);
    expect(snapshot.items.filter((item) => item.kind === 'activity').map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('keeps terminal-authored turns as separate user and assistant rows', () => {
    const stamper = createEnvelopeStamper();
    const projector = new AgentConversationProjector();
    const consume = (promptId: string, event: AgentEvent): void => {
      projector.consume(
        stamper.next({
          sessionId: 'grok-session',
          promptId,
          turnId: promptId,
          timestamp: '2026-07-21T00:00:00.000Z',
          monotonicTime: 0,
          source: 'native-transcript',
          confidence: 'authoritative',
          event,
        }),
      );
    };

    consume('prompt-1', { type: 'turn.started', turnId: 'prompt-1', prompt: 'first question' });
    consume('prompt-1', {
      type: 'assistant.message',
      messageId: 'grok-assistant:prompt-1',
      text: 'first answer',
      final: false,
    });
    consume('prompt-1', { type: 'turn.completed', turnId: 'prompt-1' });
    consume('prompt-2', { type: 'turn.started', turnId: 'prompt-2', prompt: 'second question' });
    consume('prompt-2', {
      type: 'assistant.message',
      messageId: 'grok-assistant:prompt-2',
      text: 'second answer',
      final: false,
    });
    consume('prompt-2', { type: 'turn.completed', turnId: 'prompt-2' });

    expect(projector.snapshot()).toMatchObject({
      responding: false,
      items: [
        { kind: 'user', turnId: 'prompt-1', text: 'first question' },
        { kind: 'assistant', turnId: 'prompt-1', markdown: 'first answer', streaming: false },
        { kind: 'user', turnId: 'prompt-2', text: 'second question' },
        { kind: 'assistant', turnId: 'prompt-2', markdown: 'second answer', streaming: false },
      ],
    });
  });
});
