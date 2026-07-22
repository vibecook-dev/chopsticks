import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeContextWindowEvent, resolveClaudeStatusLine } from './statusline.js';

describe('claudeContextWindowEvent', () => {
  it('uses Claude input + cache usage and excludes output tokens', () => {
    expect(
      claudeContextWindowEvent({
        model: { id: 'claude-fable-5' },
        context_window: {
          context_window_size: 200_000,
          current_usage: {
            input_tokens: 8_500,
            output_tokens: 99_999,
            cache_creation_input_tokens: 5_000,
            cache_read_input_tokens: 2_000,
          },
        },
      }),
    ).toEqual({
      type: 'context-window.updated',
      usedTokens: 15_500,
      capacityTokens: 200_000,
      modelId: 'claude-fable-5',
    });
  });

  it('invalidates the previous value when Claude reports null after startup/compaction', () => {
    expect(claudeContextWindowEvent({ context_window: { context_window_size: 200_000, current_usage: null } })).toEqual(
      { type: 'context-window.invalidated', reason: 'provider-reset' },
    );
  });
});

describe('resolveClaudeStatusLine', () => {
  it('applies user, project, and local precedence without modifying any settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-claude-statusline-'));
    const home = join(directory, 'home');
    const project = join(directory, 'project');
    const nested = join(project, 'packages', 'app');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(project, '.claude'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'user-line', padding: 1 } }),
    );
    await writeFile(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'project-line', refreshInterval: 2 } }),
    );

    await expect(resolveClaudeStatusLine(nested, { home })).resolves.toEqual({
      type: 'command',
      command: 'project-line',
      padding: undefined,
      refreshInterval: 2,
      hideVimModeIndicator: undefined,
    });
  });
});
