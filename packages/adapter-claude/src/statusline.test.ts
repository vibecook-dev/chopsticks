import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeContextWindowEvent, claudeEnvironmentEvent, resolveClaudeStatusLine } from './statusline.js';

describe('claudeEnvironmentEvent', () => {
  it('extracts the live workspace cwd and human-facing model card', () => {
    expect(
      claudeEnvironmentEvent({
        cwd: '/old',
        workspace: { current_dir: '/repo/packages/app' },
        model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      }),
    ).toEqual({
      type: 'session.environment.updated',
      currentCwd: '/repo/packages/app',
      model: { id: 'claude-opus-4-6', displayName: 'Opus 4.6', provider: 'anthropic' },
    });
  });
});

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

  it("reports an explicit empty context before a fresh session's first API response", () => {
    expect(
      claudeContextWindowEvent({
        model: { id: 'claude-haiku-4-5-20251001' },
        context_window: {
          total_input_tokens: 0,
          context_window_size: 200_000,
          current_usage: null,
          used_percentage: null,
        },
      }),
    ).toEqual({
      type: 'context-window.updated',
      usedTokens: 0,
      capacityTokens: 200_000,
      modelId: 'claude-haiku-4-5-20251001',
    });
  });

  it("uses Claude's pre-calculated percentage when the token breakdown is omitted", () => {
    expect(
      claudeContextWindowEvent({
        model: { id: 'claude-fable-5' },
        context_window: { context_window_size: 1_000_000, current_usage: {}, used_percentage: 13 },
      }),
    ).toEqual({
      type: 'context-window.updated',
      usedTokens: 130_000,
      capacityTokens: 1_000_000,
      modelId: 'claude-fable-5',
    });
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
