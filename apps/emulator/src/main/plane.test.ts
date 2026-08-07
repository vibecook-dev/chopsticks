/**
 * The control center's plane wiring: starts with the packaged console UI,
 * serves it with the token injected, and cleans the state file up on stop.
 * The window shell itself is exercised by `pnpm emulator:smoke`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlPlane } from '@vibecook/chopsticks-emulator/control';
import { loadConsoleUi } from './main.js';

const tmps: string[] = [];
afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('control center plane', () => {
  it('serves the packaged console and answers the sessions API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chopsticks-emulator-app-'));
    tmps.push(dir);
    const stateFile = join(dir, 'emulator-control.json');
    const plane = createControlPlane({ stateFile, uiHtml: loadConsoleUi() });
    await plane.start();
    try {
      const html = await (await fetch(`${plane.url}/`)).text();
      expect(html).toContain('<title>chopsticks — emulator control</title>');
      expect(html).toContain(plane.token);

      const res = await fetch(`${plane.url}/api/sessions`, {
        headers: { authorization: `Bearer ${plane.token}` },
      });
      expect((await res.json()) as { sessions: unknown[] }).toEqual({ sessions: [] });
      expect(existsSync(stateFile)).toBe(true);
    } finally {
      await plane.stop();
    }
    expect(existsSync(stateFile)).toBe(false);
  });
});
