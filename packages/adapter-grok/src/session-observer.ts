import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentEventConfidence, AgentEventSource } from '@vibecook/chopsticks-core';
import { AcpNotificationNormalizer } from '@vibecook/chopsticks-adapter-acp';

type GrokUpdateMeta = { promptId?: string; agentTimestampMs?: number };

interface GrokUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  messageId?: string;
  toolCallId?: string;
  prompt_id?: string;
  stop_reason?: string;
  event_name?: string;
  reason?: string;
  _meta?: { promptId?: string; promptIndex?: number };
  [key: string]: unknown;
}

interface GrokUpdateRecord {
  timestamp?: number | string;
  method?: string;
  params?: {
    sessionId?: string;
    update?: GrokUpdate;
    _meta?: GrokUpdateMeta;
  };
}

export interface GrokObservedEvent {
  event: AgentEvent;
  promptId?: string;
  timestamp?: string;
  source?: AgentEventSource;
  confidence?: AgentEventConfidence;
  nativeEvent: unknown;
}

export interface GrokSessionObserver {
  onEvent(listener: (event: GrokObservedEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  poll(): Promise<void>;
  stop(): void;
}

function recordTimestamp(record: GrokUpdateRecord): string | undefined {
  const agentMs = record.params?._meta?.agentTimestampMs;
  if (typeof agentMs === 'number' && Number.isFinite(agentMs)) return new Date(agentMs).toISOString();
  const value = typeof record.timestamp === 'string' ? Number(record.timestamp) : record.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
  }
  return undefined;
}

function textContent(update: GrokUpdate): string {
  return update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : '';
}

/**
 * Grok persists the TUI's complete structured event stream here. Unlike the
 * secondary ACP client, this stream includes externally typed user prompts and
 * Grok's turn_completed extension, so it is the authoritative observation
 * surface when Chopsticks adopts an existing terminal.
 */
export function grokUpdatesPath(cwd: string, sessionId: string, grokHome = process.env.GROK_HOME): string {
  return join(grokHome ?? join(homedir(), '.grok'), 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl');
}

/** Stateful translation of persisted Grok updates into stable turn/message events. */
export class GrokUpdateNormalizer {
  private readonly acp = new AcpNotificationNormalizer();
  private readonly assistantByPrompt = new Map<string, string>();
  private readonly assistantMessageIdByPrompt = new Map<string, string>();
  private readonly startedPrompts = new Set<string>();
  private readonly completedPrompts = new Set<string>();
  private readonly reasoningPrompts = new Set<string>();
  private activePromptId: string | undefined;
  private pendingPromptId: string | undefined;
  private pendingUser: { text: string; timestamp?: string; nativeEvent: unknown } | undefined;
  private fallbackPromptCounter = 0;

  normalize(input: unknown): GrokObservedEvent[] {
    const record = input as GrokUpdateRecord;
    const params = record?.params;
    const update = params?.update;
    if (!params || !update || typeof update.sessionUpdate !== 'string') return [];

    const timestamp = recordTimestamp(record);
    const observed = (
      event: AgentEvent,
      promptId = this.promptId(update, params._meta),
      source: AgentEventSource = 'native-transcript',
      confidence: AgentEventConfidence = 'authoritative',
    ): GrokObservedEvent => ({ event, promptId, timestamp, source, confidence, nativeEvent: input });

    if (update.sessionUpdate === 'hook_execution') {
      if (update.event_name === 'session_start') {
        return [observed({ type: 'session.started', nativeSessionId: params.sessionId }, undefined)];
      }
      if (update.event_name === 'user_prompt_submit' && typeof update.prompt_id === 'string') {
        this.pendingPromptId = update.prompt_id;
        this.activePromptId = update.prompt_id;
        return this.materializePendingUser(update.prompt_id);
      }
      if (update.event_name === 'session_end') {
        return [observed({ type: 'session.exited', reason: update.reason as string | undefined }, undefined)];
      }
      return [];
    }

    if (update.sessionUpdate === 'user_message_chunk') {
      const promptId = this.promptId(update, params._meta);
      if (!promptId) {
        // The standard user echo carries only promptIndex. If no Grok hook
        // announced the UUID, hold the text until the first response update,
        // whose top-level _meta.promptId is authoritative.
        this.pendingUser = {
          text: (this.pendingUser?.text ?? '') + textContent(update),
          timestamp: this.pendingUser?.timestamp ?? timestamp,
          nativeEvent: input,
        };
        return [];
      }
      this.activePromptId = promptId;
      this.pendingPromptId = undefined;
      if (this.startedPrompts.has(promptId)) return [];
      this.startedPrompts.add(promptId);
      return [observed({ type: 'turn.started', turnId: promptId, prompt: textContent(update) }, promptId)];
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      const promptId = this.promptId(update, params._meta) ?? this.activePromptId;
      if (!promptId) return [];
      const events = this.materializePendingUser(promptId);
      const type = this.reasoningPrompts.has(promptId) ? 'reasoning.progress' : 'reasoning.started';
      this.reasoningPrompts.add(promptId);
      events.push(observed({ type, reasoningId: promptId }, promptId));
      return events;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      const promptId = this.promptId(update, params._meta) ?? this.activePromptId;
      if (!promptId) return [];
      const events = this.materializePendingUser(promptId);
      this.activePromptId = promptId;
      const text = (this.assistantByPrompt.get(promptId) ?? '') + textContent(update);
      this.assistantByPrompt.set(promptId, text);
      const messageId =
        update.messageId ?? this.assistantMessageIdByPrompt.get(promptId) ?? `grok-assistant:${promptId}`;
      this.assistantMessageIdByPrompt.set(promptId, messageId);
      events.push(
        observed(
          {
            type: 'assistant.message',
            messageId,
            turnId: promptId,
            text,
            final: false,
            displayOnly: false,
          },
          promptId,
        ),
      );
      return events;
    }

    if (update.sessionUpdate === 'turn_completed') {
      const promptId = this.promptId(update, params._meta) ?? this.activePromptId ?? this.newFallbackPromptId(update);
      if (this.completedPrompts.has(promptId)) return [];
      this.completedPrompts.add(promptId);
      const events = this.materializePendingUser(promptId);
      if (this.reasoningPrompts.delete(promptId)) {
        events.push(observed({ type: 'reasoning.completed', reasoningId: promptId }, promptId));
      }
      const assistant = this.assistantByPrompt.get(promptId);
      if (assistant !== undefined) {
        events.push(
          observed(
            {
              type: 'assistant.message',
              messageId: this.assistantMessageIdByPrompt.get(promptId) ?? `grok-assistant:${promptId}`,
              turnId: promptId,
              text: assistant,
              final: true,
              displayOnly: false,
            },
            promptId,
          ),
        );
      }
      events.push(
        observed(
          {
            type: 'turn.completed',
            turnId: promptId,
            stopReason: typeof update.stop_reason === 'string' ? update.stop_reason : undefined,
            lastAssistantMessage: assistant,
          },
          promptId,
        ),
      );
      if (this.activePromptId === promptId) this.activePromptId = undefined;
      return events;
    }

    // Tool updates remain standard ACP shapes. Reuse the shared semantic mapper
    // while retaining Grok's prompt correlation on the surrounding envelope.
    const notification = params as unknown as Parameters<AcpNotificationNormalizer['normalize']>[0];
    return this.acp
      .normalize(notification)
      .events.map((event) => observed(event, this.promptId(update, params._meta) ?? this.activePromptId));
  }

  private promptId(update: GrokUpdate, meta: GrokUpdateMeta | undefined): string | undefined {
    return (
      (typeof update.prompt_id === 'string' ? update.prompt_id : undefined) ??
      (typeof meta?.promptId === 'string' ? meta.promptId : undefined) ??
      (typeof update._meta?.promptId === 'string' ? update._meta.promptId : undefined) ??
      this.pendingPromptId
    );
  }

  private newFallbackPromptId(update: GrokUpdate): string {
    const index = update._meta?.promptIndex;
    return `grok-prompt-${typeof index === 'number' ? index + 1 : ++this.fallbackPromptCounter}`;
  }

  private materializePendingUser(promptId: string): GrokObservedEvent[] {
    const pending = this.pendingUser;
    if (!pending) return [];
    this.pendingUser = undefined;
    this.pendingPromptId = undefined;
    this.activePromptId = promptId;
    if (this.startedPrompts.has(promptId)) return [];
    this.startedPrompts.add(promptId);
    return [
      {
        event: { type: 'turn.started', turnId: promptId, prompt: pending.text },
        promptId,
        timestamp: pending.timestamp,
        source: 'native-transcript',
        confidence: 'authoritative',
        nativeEvent: pending.nativeEvent,
      },
    ];
  }
}

/** Incrementally tails complete JSONL records; partial final writes are retried. */
export function createGrokSessionObserver(
  updatesPath: string,
  options: { pollIntervalMs?: number } = {},
): GrokSessionObserver {
  const normalizer = new GrokUpdateNormalizer();
  const eventListeners = new Set<(event: GrokObservedEvent) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let offset = 0;
  let stopped = false;
  let polling: Promise<void> | undefined;

  const report = (error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of errorListeners) {
      try {
        listener(normalized);
      } catch {
        // Consumer faults stay out of the tail.
      }
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (polling) return polling;
    polling = (async () => {
      try {
        const data = await readFile(updatesPath);
        if (data.length < offset) offset = 0;
        const unread = data.subarray(offset);
        const lastNewline = unread.lastIndexOf(0x0a);
        if (lastNewline < 0) return;
        const complete = unread.subarray(0, lastNewline + 1).toString('utf8');
        offset += lastNewline + 1;
        for (const line of complete.split('\n')) {
          if (!line.trim()) continue;
          try {
            for (const event of normalizer.normalize(JSON.parse(line))) {
              for (const listener of eventListeners) {
                try {
                  listener(event);
                } catch {
                  // One consumer cannot break observation for the others.
                }
              }
            }
          } catch (error) {
            report(new Error(`invalid Grok update record: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error);
      }
    })().finally(() => {
      polling = undefined;
    });
    return polling;
  };

  const interval = setInterval(() => void poll(), options.pollIntervalMs ?? 75);
  interval.unref?.();

  return {
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    poll,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      eventListeners.clear();
      errorListeners.clear();
    },
  };
}
