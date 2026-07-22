/** Claude Code status-line telemetry and transparent delegate preservation. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import type { ContextWindowInvalidatedEvent, ContextWindowUpdatedEvent } from '@vibecook/chopsticks-core';

export interface ClaudeStatusLineConfig {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
}

interface ClaudeStatusLinePayload {
  model?: { id?: unknown };
  context_window?: {
    total_input_tokens?: unknown;
    context_window_size?: unknown;
    current_usage?: {
      input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    } | null;
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Convert Claude's provider-defined input-only usage into the shared used/size event. */
export function claudeContextWindowEvent(
  payload: unknown,
): ContextWindowUpdatedEvent | ContextWindowInvalidatedEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as ClaudeStatusLinePayload;
  const context = body.context_window;
  if (!context) return null;
  if (context.current_usage === null) {
    return { type: 'context-window.invalidated', reason: 'provider-reset' };
  }

  const capacityTokens = finiteNumber(context.context_window_size);
  if (capacityTokens === undefined) return null;

  const usage = context.current_usage;
  let usedTokens: number | undefined;
  if (usage) {
    const input = finiteNumber(usage.input_tokens);
    const cacheCreation = finiteNumber(usage.cache_creation_input_tokens);
    const cacheRead = finiteNumber(usage.cache_read_input_tokens);
    if (input !== undefined && cacheCreation !== undefined && cacheRead !== undefined) {
      usedTokens = input + cacheCreation + cacheRead;
    }
  }
  // Current Claude versions expose this as the same input-only sum. It is a
  // useful compatibility fallback if an older payload omits the components.
  usedTokens ??= finiteNumber(context.total_input_tokens);
  if (usedTokens === undefined) return null;

  const modelId = typeof body.model?.id === 'string' ? body.model.id : undefined;
  return { type: 'context-window.updated', usedTokens, capacityTokens, modelId };
}

function statusLineConfig(value: unknown): ClaudeStatusLineConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'command' || typeof candidate.command !== 'string') return undefined;
  return {
    type: 'command',
    command: candidate.command,
    padding: finiteNumber(candidate.padding),
    refreshInterval: finiteNumber(candidate.refreshInterval),
    hideVimModeIndicator:
      typeof candidate.hideVimModeIndicator === 'boolean' ? candidate.hideVimModeIndicator : undefined,
  };
}

async function statusLineFromFile(path: string): Promise<ClaudeStatusLineConfig | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { statusLine?: unknown };
    return statusLineConfig(parsed.statusLine);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the normal user/project/local settings layers before our additional
 * `--settings` file overrides `statusLine`. Nearest project settings win.
 */
export async function resolveClaudeStatusLine(
  cwd: string,
  options: { home?: string } = {},
): Promise<ClaudeStatusLineConfig | undefined> {
  const candidates: string[] = [join(options.home ?? homedir(), '.claude', 'settings.json')];
  const absolute = resolve(cwd);
  const root = parse(absolute).root;
  const ancestors: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    ancestors.push(current);
    if (current === root) break;
  }
  ancestors.reverse();
  for (const directory of ancestors) {
    candidates.push(join(directory, '.claude', 'settings.json'));
    candidates.push(join(directory, '.claude', 'settings.local.json'));
  }

  let resolvedConfig: ClaudeStatusLineConfig | undefined;
  for (const path of candidates) {
    const config = await statusLineFromFile(path);
    if (config) resolvedConfig = config;
  }
  return resolvedConfig;
}

/**
 * Tiny standalone Node program written beside the generated settings file.
 * It reports telemetry and runs the original command concurrently, relaying
 * the delegate's stdout/stderr and exit status without interpreting them.
 */
export const CLAUDE_STATUS_LINE_FORWARDER_SOURCE = `
import { spawn } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

const endpoint = process.env.CHOPSTICKS_STATUSLINE_ENDPOINT;
const token = process.env.CHOPSTICKS_HOOK_TOKEN;
const telemetry = endpoint && token
  ? fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: \`Bearer \${token}\`,
      },
      body: input,
      signal: AbortSignal.timeout(250),
    }).catch(() => undefined)
  : Promise.resolve();

const command = process.env.CHOPSTICKS_STATUSLINE_DELEGATE;
let delegate = Promise.resolve(0);
if (command) {
  delegate = new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
    child.stdin.end(input);
  });
}

const [, code] = await Promise.all([telemetry, delegate]);
process.exitCode = code;
`.trimStart();
