import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLastCodexContextWindow } from './rollout-context.js';

describe('readLastCodexContextWindow', () => {
  it('uses last usage rather than the cumulative session total', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-rollout-context-'));
    const path = join(directory, 'rollout.jsonl');
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 5_000_000 },
              last_token_usage: { total_tokens: 50_000 },
              model_context_window: 200_000,
            },
          },
        }),
        '',
      ].join('\n'),
    );

    await expect(readLastCodexContextWindow(path)).resolves.toEqual({
      type: 'context-window.updated',
      usedTokens: 50_000,
      capacityTokens: 200_000,
    });
  });

  it('returns unknown for missing or incomplete rollouts', async () => {
    await expect(readLastCodexContextWindow('/definitely/missing/rollout.jsonl')).resolves.toBeUndefined();
  });
});
