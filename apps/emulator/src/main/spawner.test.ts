/**
 * Center-owned spawn, end to end and headless: the spawner drives the real
 * adapter with the emulator bin as the process, the bin registers with the
 * plane, and the plane reports live reducer state — the console's spawn flow
 * with no product app and no claude binary.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from '@vibecook/chopsticks-emulator/control';
import { createClaudeSpawner } from './spawner.js';

const tmps: string[] = [];
let plane: ControlPlane | undefined;

afterEach(async () => {
  await plane?.stop();
  plane = undefined;
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('claude spawner', () => {
  it('spawns a session that registers and reports reducer state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chopsticks-spawner-it-'));
    tmps.push(dir);
    const stateFile = join(dir, 'emulator-control.json');
    const spawner = createClaudeSpawner({ controlStateFile: stateFile });
    plane = createControlPlane({ stateFile, spawners: [spawner] });
    await plane.start();

    const { sessionId } = await spawner.spawn();
    try {
      // The spawned bin registers itself with the plane.
      await waitFor(async () => {
        const res = await fetch(`${plane!.url}/api/sessions`, {
          headers: { authorization: `Bearer ${plane!.token}` },
        });
        const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
        return body.sessions.some((session) => session.sessionId === sessionId);
      }, 'spawned session registration');

      // Reducer state is live underneath: boot hooks brought it to ready.
      await waitFor(() => {
        const state = spawner.sessionState(sessionId) as { lifecycle?: string } | undefined;
        return state?.lifecycle === 'ready';
      }, 'ready lifecycle');
    } finally {
      await spawner.disposeAll();
    }
  });
});
