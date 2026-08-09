/**
 * Statusline channel — the vendor invokes the configured command with session
 * JSON on stdin.
 *
 * For the chopsticks recipe that command is the adapter's own forwarder
 * script, so invoking it exactly as configured exercises the real
 * forwarder → bridge path end to end. Cadence is the caller's choice: how
 * often a vendor refreshes is behavior-pack data, not a property of the
 * channel.
 */

import { spawn } from 'node:child_process';

export interface StatusLineInvoker {
  /** Feed one session-status JSON payload to the configured command's stdin. */
  invoke(payload: Record<string, unknown>): Promise<void>;
}

export interface StatusLineInvokerOptions {
  log?: (message: string) => void;
  timeoutMs?: number;
}

export function createStatusLineInvoker(
  config: unknown,
  options: StatusLineInvokerOptions = {},
): StatusLineInvoker | undefined {
  const log = options.log ?? (() => {});
  const command =
    config !== null && typeof config === 'object' ? (config as Record<string, unknown>).command : undefined;
  if (typeof command !== 'string' || command.length === 0) return undefined;
  return {
    invoke(payload) {
      return new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
        const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5_000, 300_000));
        timer = setTimeout(() => {
          log(`statusline command timed out after ${timeoutMs}ms`);
          child.kill('SIGKILL');
          finish();
        }, timeoutMs);
        child.on('error', (error) => {
          log(`statusline command failed to spawn: ${error.message}`);
          finish();
        });
        child.on('close', finish);
        child.stdin.on('error', (error) => log(`statusline command stdin failed: ${error.message}`));
        child.stdin.end(JSON.stringify(payload));
      });
    },
  };
}
