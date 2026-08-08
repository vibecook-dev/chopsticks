/**
 * Test fixtures for the control plane. Not part of the app's runtime.
 *
 * The one thing worth naming here: `sun_path` is ~103 bytes and the macOS
 * TMPDIR alone eats half of that, so tests dig a short root of their own rather
 * than nesting a socket under `os.tmpdir()` (draft/IMPOSTER.md §5.2).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { MachineView } from '@vibecook/chopsticks-imposter/control';

/** Lifecycle snapshot for fixtures that join the plane without driving a session. */
export const IDLE_MACHINE: MachineView = {
  state: 'ready',
  enabled: ['session.end', 'turn.start', 'usage.refresh'],
  offModel: 0,
  applied: 2,
  heartbeats: 0,
};

export interface ControlPaths {
  root: string;
  socketPath: string;
  tokenPath: string;
}

export function shortRoot(): string {
  return mkdtempSync(process.platform === 'win32' ? 'cs-' : '/tmp/cs-');
}

export function controlPaths(): ControlPaths {
  const root = shortRoot();
  return {
    root,
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\chopsticks-test-${randomUUID()}` : join(root, 'p.sock'),
    tokenPath: join(root, 'p.token'),
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Collect server-sent events off the plane's push stream. */
export interface EventCollector {
  events: Array<{ event: string; data: Record<string, unknown> }>;
  latest(event: string): Record<string, unknown> | undefined;
  close(): void;
}

export async function collectEvents(url: string, token: string): Promise<EventCollector> {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/events?token=${encodeURIComponent(token)}`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const events: EventCollector['events'] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
        }
      }
    } catch {
      // Aborted by close(), or the plane stopped — either way we are done.
    }
  })();
  return {
    events,
    latest: (event) => [...events].reverse().find((entry) => entry.event === event)?.data,
    close: () => controller.abort(),
  };
}
