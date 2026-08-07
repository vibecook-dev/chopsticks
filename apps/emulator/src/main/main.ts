/**
 * Emulator control center (draft/EMULATOR.md §6): a thin Electron shell over
 * the control plane's loopback console. The plane serves the UI itself, so
 * the same console also works in a plain browser; this app just owns the
 * plane's lifetime and frames it. No ghosttea dependency — a control console
 * needs no terminal stack, which keeps it buildable without the sibling repo.
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createControlPlane } from '@vibecook/chopsticks-emulator/control';
import { createClaudeSpawner } from './spawner.js';

export function loadConsoleUi(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve('@vibecook/chopsticks-emulator/package.json');
  return readFileSync(join(dirname(packageJson), 'ui', 'control.html'), 'utf8');
}

const smoke = process.argv.includes('--smoke');
const claudeSpawner = createClaudeSpawner();
const plane = createControlPlane({ uiHtml: loadConsoleUi(), spawners: [claudeSpawner] });

// Only the electron main process boots the window shell; vitest imports this
// module for loadConsoleUi and has no electron runtime.
if (process.type === 'browser') {
  app.whenReady().then(async () => {
    await plane.start();
    if (smoke) {
      console.log(`emulator control plane at ${plane.url}`);
      await plane.stop();
      app.exit(0);
      return;
    }
    const window = new BrowserWindow({ width: 1280, height: 840, title: 'chopsticks — emulator control' });
    window.removeMenu();
    await window.loadURL(plane.url);
  });

  app.on('before-quit', async () => {
    await claudeSpawner.disposeAll();
    await plane.stop();
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
}
