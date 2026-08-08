/**
 * Center-owned spawn, end to end and headless: the spawner drives the real
 * adapter with `ai` as the process, the imposter joins the plane over its
 * socket, and reducer state is pushed rather than polled — the console's spawn
 * flow with no product app and no claude binary.
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from './plane.js';
import { createClaudeSpawner } from './spawner.js';
import { controlPaths, waitFor } from './testing.js';

const tmps: string[] = [];
let plane: ControlPlane | undefined;

afterEach(async () => {
  await plane?.stop();
  plane = undefined;
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('claude spawner', () => {
  it('spawns a session that joins the plane and pushes reducer state', async () => {
    const paths = controlPaths();
    tmps.push(paths.root);
    const spawner = createClaudeSpawner({ controlSocketPath: paths.socketPath, controlTokenPath: paths.tokenPath });
    plane = createControlPlane({ socketPath: paths.socketPath, tokenPath: paths.tokenPath, spawners: [spawner] });
    await plane.start();

    // Reducer changes reach the plane by subscription, which is what replaced
    // the console's 1.5 s poll (draft/IMPOSTER.md §5).
    const changed: string[] = [];
    const off = spawner.subscribe!((sessionId) => changed.push(sessionId));

    const { sessionId } = await spawner.spawn();
    try {
      await waitFor(() => plane!.sessions.some((session) => session.sessionId === sessionId), 'session join');
      await waitFor(() => {
        const state = spawner.sessionState(sessionId) as { lifecycle?: string } | undefined;
        return state?.lifecycle === 'ready';
      }, 'ready lifecycle');
      expect(changed).toContain(sessionId);

      const res = await fetch(`${plane!.url}/api/sessions/${sessionId}/session-state?vendor=claude`, {
        headers: { authorization: `Bearer ${plane!.token}` },
      });
      expect(((await res.json()) as { lifecycle: string }).lifecycle).toBe('ready');
    } finally {
      off();
      await spawner.disposeAll();
    }
  });
});
