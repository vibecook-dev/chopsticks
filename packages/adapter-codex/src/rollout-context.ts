/** Bootstrap current Codex context pressure from the tail of a persisted rollout. */

import { open } from 'node:fs/promises';
import type { ContextWindowUpdatedEvent } from '@vibecook/chopsticks-core';

const DEFAULT_TAIL_BYTES = 1024 * 1024;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export async function readLastCodexContextWindow(
  rolloutPath: string,
  maxBytes = DEFAULT_TAIL_BYTES,
): Promise<ContextWindowUpdatedEvent | undefined> {
  let file;
  try {
    file = await open(rolloutPath, 'r');
    const stats = await file.stat();
    const length = Math.min(stats.size, maxBytes);
    if (length <= 0) return undefined;
    const buffer = Buffer.allocUnsafe(length);
    await file.read(buffer, 0, length, stats.size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A tail starting mid-record has an unusable first line; reverse scanning
    // naturally reaches complete recent records before it.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const entry = record(JSON.parse(line));
        const payload = record(entry?.payload);
        if (entry?.type !== 'event_msg' || payload?.type !== 'token_count') continue;
        const info = record(payload.info);
        const last = record(info?.last_token_usage);
        const usedTokens = finiteNumber(last?.total_tokens);
        const capacityTokens = finiteNumber(info?.model_context_window);
        if (usedTokens === undefined || capacityTokens === undefined) continue;
        return { type: 'context-window.updated', usedTokens, capacityTokens };
      } catch {
        // Partial/corrupt tail records do not hide an earlier complete update.
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
