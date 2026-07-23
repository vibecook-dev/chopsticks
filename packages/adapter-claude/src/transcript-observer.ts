/**
 * Transcript observer (DESIGN §16.8) — authoritative message history from the
 * session's transcript, via spaghetti's scoped tail (`watchSessionTranscript`,
 * spaghetti-sdk ≥0.5.16). No second parser: cold-ingest parity is inherited.
 *
 * Latency model: hook events fire 1:1 with transcript appends, so the driver
 * calls `notifyActivity()` on every bridge envelope and the tail's poll
 * interval is only a fallback. Hooks remain authoritative for LIFECYCLE;
 * the transcript is authoritative for MESSAGE CONTENT (hook MessageDisplay
 * deltas are displayOnly) — consumers prefer `assistantMessageEvent` output
 * over display-sourced text when both exist.
 *
 * Observer failure must never fail the session (§16.8 rules): errors surface
 * on onError and the tail keeps retrying with backoff.
 */

import { watchSessionTranscript } from '@vibecook/spaghetti-sdk';
import type { SessionMessage, SessionTranscriptTail } from '@vibecook/spaghetti-sdk';
import type { AgentEvent, AssistantMessageEvent } from '@vibecook/chopsticks-core';

export interface TranscriptRecordEvent {
  message: SessionMessage;
  msgIndex: number;
  /** True when the transcript was rewritten and indexing restarted. */
  rewrite: boolean;
}

export interface TranscriptObserverOptions {
  /** Fallback cadence; notifyActivity() is the primary signal. Default 1s. */
  pollIntervalMs?: number;
}

export interface TranscriptObserver {
  onRecord(listener: (event: TranscriptRecordEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  /** Low-latency poke — call on every hook envelope for this session. */
  notifyActivity(): Promise<void>;
  stop(): void;
}

export interface TranscriptHistoryProjection {
  event: AgentEvent;
  promptId: string;
  turnId: string;
  timestamp?: string;
  nativeEvent: SessionMessage;
}

const SYNTHETIC_USER_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<task-notification>',
  '<system-reminder>',
  '<ide_opened_file>',
  '<ide_selection>',
] as const;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Claude may prepend one or more synthetic XML blocks to the actual user
 * prompt in the same transcript record. Remove only complete leading blocks;
 * a record containing nothing else remains synthetic.
 */
function stripSyntheticUserPreamble(value: string): string | undefined {
  let remaining = value.trim();
  for (;;) {
    const lower = remaining.toLowerCase();
    const prefix = SYNTHETIC_USER_PREFIXES.find((candidate) => lower.startsWith(candidate));
    if (!prefix) return nonEmptyString(remaining);

    const closing = `</${prefix.slice(1, -1)}>`;
    const closingIndex = lower.indexOf(closing, prefix.length);
    if (closingIndex < 0) return undefined;
    remaining = remaining.slice(closingIndex + closing.length).trimStart();
    if (!remaining) return undefined;
  }
}

function visibleUserPrompt(message: SessionMessage): { turnId: string; text: string; timestamp?: string } | undefined {
  const record = message as {
    type?: string;
    uuid?: string;
    promptId?: string;
    timestamp?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    isCompactSummary?: boolean;
    isVisibleInTranscriptOnly?: boolean;
    sourceToolUseID?: string;
    toolUseResult?: unknown;
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  };
  if (
    record.type !== 'user' ||
    record.isMeta ||
    record.isSidechain ||
    record.isCompactSummary ||
    record.isVisibleInTranscriptOnly ||
    record.sourceToolUseID ||
    record.toolUseResult !== undefined
  ) {
    return undefined;
  }
  const content = record.message?.content;
  const rawText =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
        : undefined;
  const text = rawText === undefined ? undefined : stripSyntheticUserPreamble(rawText);
  if (!text) return undefined;
  const turnId = nonEmptyString(record.promptId) ?? nonEmptyString(record.uuid);
  return turnId ? { turnId, text, timestamp: nonEmptyString(record.timestamp) } : undefined;
}

/**
 * Reconstruct displayable conversation turns from Claude's durable transcript.
 * Tool-result user rows and other synthetic context records stay out of the
 * user-visible conversation. A final prompt with no durable assistant response
 * is projected as interrupted rather than falsely marked successful.
 */
export function projectTranscriptHistory(messages: readonly SessionMessage[]): TranscriptHistoryProjection[] {
  const projected: TranscriptHistoryProjection[] = [];
  let current:
    | {
        turnId: string;
        prompt: string;
        timestamp?: string;
        nativeEvent: SessionMessage;
        assistant: Array<{ event: AssistantMessageEvent; timestamp?: string; nativeEvent: SessionMessage }>;
      }
    | undefined;

  const flush = (boundary: 'next-prompt' | 'transcript-end'): void => {
    if (!current) return;
    const { turnId, prompt, timestamp, nativeEvent, assistant } = current;
    projected.push({
      event: { type: 'turn.started', turnId, prompt },
      promptId: turnId,
      turnId,
      timestamp,
      nativeEvent,
    });
    for (const item of assistant) {
      projected.push({
        event: { ...item.event, turnId },
        promptId: turnId,
        turnId,
        timestamp: item.timestamp,
        nativeEvent: item.nativeEvent,
      });
    }
    const lastAssistant = assistant.at(-1);
    projected.push({
      event:
        lastAssistant || boundary === 'next-prompt'
          ? {
              type: 'turn.completed',
              turnId,
              ...(lastAssistant?.event.text ? { lastAssistantMessage: lastAssistant.event.text } : {}),
            }
          : {
              type: 'turn.failed',
              turnId,
              error: 'interrupted before an assistant response',
            },
      promptId: turnId,
      turnId,
      timestamp: lastAssistant?.timestamp ?? timestamp,
      nativeEvent: lastAssistant?.nativeEvent ?? nativeEvent,
    });
    current = undefined;
  };

  for (const message of messages) {
    const prompt = visibleUserPrompt(message);
    if (prompt) {
      flush('next-prompt');
      current = {
        turnId: prompt.turnId,
        prompt: prompt.text,
        timestamp: prompt.timestamp,
        nativeEvent: message,
        assistant: [],
      };
      continue;
    }
    if (!current) continue;
    const assistant = assistantMessageEvent(message);
    if (!assistant) continue;
    const timestamp = nonEmptyString((message as { timestamp?: string }).timestamp);
    current.assistant.push({ event: assistant, timestamp, nativeEvent: message });
  }
  flush('transcript-end');
  return projected;
}

export function createTranscriptObserver(
  transcriptPath: string,
  options: TranscriptObserverOptions = {},
): TranscriptObserver {
  const tail: SessionTranscriptTail = watchSessionTranscript(transcriptPath, {
    pollIntervalMs: options.pollIntervalMs ?? 1000,
  });
  const recordListeners = new Set<(e: TranscriptRecordEvent) => void>();
  const errorListeners = new Set<(e: Error) => void>();

  tail.onMessage((event) => {
    const record: TranscriptRecordEvent = {
      message: event.message,
      msgIndex: event.msgIndex,
      rewrite: event.rewrite,
    };
    for (const listener of recordListeners) {
      try {
        listener(record);
      } catch {
        // Consumer faults stay out of the tail.
      }
    }
  });
  tail.onError((error) => {
    for (const listener of errorListeners) listener(error);
  });

  return {
    onRecord(listener) {
      recordListeners.add(listener);
      return () => recordListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    notifyActivity: () => tail.poll(),
    stop: () => tail.stop(),
  };
}

/**
 * Authoritative assistant text from a transcript record, or null for
 * non-assistant records. `displayOnly: false` marks it as the transcript
 * (durable) source, ranking above hook MessageDisplay accumulation.
 */
export function assistantMessageEvent(message: SessionMessage): AssistantMessageEvent | null {
  const record = message as {
    type?: string;
    uuid?: string;
    isSidechain?: boolean;
    message?: { id?: string; content?: Array<{ type?: string; text?: string }> };
  };
  if (record.type !== 'assistant' || record.isSidechain || !Array.isArray(record.message?.content)) return null;
  const text = record.message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  if (text.length === 0) return null;
  return {
    type: 'assistant.message',
    messageId: record.message.id ?? record.uuid,
    text,
    final: true,
    displayOnly: false,
  };
}
