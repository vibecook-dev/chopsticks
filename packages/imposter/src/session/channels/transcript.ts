/**
 * Transcript channel — the JSONL file the vendor writes and the adapter's
 * transcript observer tails through the spaghetti SDK.
 *
 * The imposter's transcript root is NEVER the vendor's real one (`~/.claude`),
 * so imposted sessions stay out of the user's spaghetti index
 * (draft/IMPOSTER.md §7.3 item 5). Choosing that root is the session's job;
 * this module only writes where it is told.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TranscriptWriter {
  readonly path: string;
  append(record: Record<string, unknown>): void;
  /** Write a line fragment with no trailing newline — the crash-mid-write shape. */
  appendPartial(fragment: string): void;
}

export function createTranscriptWriter(path: string): TranscriptWriter {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '');
  return {
    path,
    append(record) {
      appendFileSync(path, JSON.stringify(record) + '\n');
    },
    appendPartial(fragment) {
      appendFileSync(path, fragment);
    },
  };
}
