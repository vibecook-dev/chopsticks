/**
 * Emulator control center (draft/EMULATOR.md §6): a thin Electron shell over
 * the control plane's loopback console. The plane serves the UI itself, so
 * the same console also works in a plain browser; this app just owns the
 * plane's lifetime and frames it. No ghosttea dependency — a control console
 * needs no terminal stack, which keeps it buildable without the sibling repo.
 */
import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlPlane } from './plane.js';
import { createClaudeSpawner } from './spawner.js';

export function loadConsoleUi(): string {
  // The bundle lands at `dist/main.cjs` and vitest imports `src/main/main.ts`,
  // so the app root is one or two levels up depending on which is running.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'ui', 'control.html'), join(here, '..', '..', 'ui', 'control.html')]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error('emulator console UI not found beside the app');
}

const smoke = process.argv.includes('--smoke');
const claudeSpawner = createClaudeSpawner();
const plane = createControlPlane({
  uiHtml: loadConsoleUi(),
  spawners: [claudeSpawner],
  // Sessions joining and leaving is the one thing worth watching from the
  // terminal you launched in, and it is how you notice an imposter that failed
  // to dial in at all.
  log: (message) => console.log(`[plane] ${message}`),
});
let quitReady = false;
let shutdownPromise: Promise<void> | undefined;
let mainWindow: BrowserWindow | undefined;

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await claudeSpawner.disposeAll();
    await plane.stop();
  })();
  return shutdownPromise;
}

// Only the electron main process boots the window shell; vitest imports this
// module for loadConsoleUi and has no electron runtime.
if (process.type === 'browser') {
  app
    .whenReady()
    .then(async () => {
      await plane.start();
      if (smoke) {
        console.log(`emulator control plane at ${plane.url}`);
        await shutdown();
        quitReady = true;
        app.exit(0);
        return;
      }
      // The console is also a plain web page; print the authenticated URL so it
      // can be opened in a real browser with devtools, or driven by a script.
      console.log(`emulator console at ${plane.consoleUrl}`);
      mainWindow = new BrowserWindow({ width: 1280, height: 840, title: 'chopsticks — emulator control' });
      mainWindow.on('closed', () => {
        mainWindow = undefined;
      });
      mainWindow.removeMenu();
      await mainWindow.loadURL(plane.consoleUrl);
    })
    .catch((error) => {
      console.error(error);
      void shutdown().finally(() => {
        quitReady = true;
        app.exit(1);
      });
    });

  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    void shutdown().finally(() => {
      quitReady = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => {
    app.quit();
  });
}
