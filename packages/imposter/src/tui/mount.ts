/**
 * Presentation: the same four lines of information, rendered two ways
 * (draft/IMPOSTER.md §4.2).
 *
 * Headless is not a fallback — CI runs it, and so does the control centre's
 * spawner, because Ink's pinned layout needs a real TTY and neither has one.
 * Both modes share `formatFrame`, so what a line *says* never depends on how it
 * is displayed.
 *
 * Ink is loaded through a dynamic import, so a headless process never pays for
 * React at all: the cost of the pinned layout falls only on the mode that gets
 * the pinned layout.
 */

import type { PresentationFrame } from '../session/timeline.ts';
import { createTuiStore, formatFrame } from './store.ts';

export interface Presentation {
  frame(frame: PresentationFrame): void;
  channels(channels: readonly string[]): void;
  /** Pasted-but-not-submitted text. */
  staged(text: string): void;
  notice(text: string): void;
  readonly interactive: boolean;
  stop(): Promise<void>;
}

export interface PresentationOptions {
  vendor: string;
  version: string;
  sessionId: string;
  channels: readonly string[];
  /** Overridable so tests can assert the headless stream without a real stdout. */
  write?: (text: string) => void;
  /** Force a mode; defaults to whether both ends of the terminal are real. */
  interactive?: boolean;
}

/**
 * Ink costs ~40 MB of RSS per process (77 MB headless vs 117 MB with Ink
 * loaded, node 26.5, measured 2026-08-08). One imposter does not care; twenty
 * of them in a swarm pane is 800 MB of chrome. `CHOPSTICKS_IMPOSTER_TUI=off`
 * is the contained retreat §4.1.2 reserved — the append-only sink is a
 * first-class mode, so falling back to it costs nothing but the pinned layout.
 */
function isInteractive(): boolean {
  if (process.env.CHOPSTICKS_IMPOSTER_TUI === 'off') return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Append-only stdout: what the adapter's pipe, and therefore CI, sees. */
function headlessPresentation(options: PresentationOptions): Presentation {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  write(`IMPOSTER · ${options.vendor} ${options.version} · ${options.sessionId} · ${options.channels.join(' ')}\r\n`);
  return {
    interactive: false,
    frame: (frame) => write(`${formatFrame(frame)}\r\n`),
    channels: (channels) => write(`channels: ${channels.join(' ')}\r\n`),
    // Clearing the staged text is a TUI concern; an append-only stream has
    // nothing to clear, so it says nothing.
    staged: (text) => void (text && write(`\r\n[staged] ${text}\r\n`)),
    notice: (text) => write(`${text}\r\n`),
    stop: async () => {},
  };
}

export async function createPresentation(options: PresentationOptions): Promise<Presentation> {
  if (!(options.interactive ?? isInteractive())) return headlessPresentation(options);

  const store = createTuiStore(options.channels);
  // Imported here, and only here: a piped run never loads Ink or React.
  const [{ render }, { createElement }, { ImposterApp }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./app.ts'),
  ]);

  const instance = render(
    createElement(ImposterApp, {
      vendor: options.vendor,
      version: options.version,
      sessionId: options.sessionId,
      store,
    }),
    {
      // Ink must not touch input. `exitOnCtrlC` installs a key handler, and
      // Ctrl-C is an interrupt the session has to see as bytes like any other
      // (§4.1.1); `patchConsole` would swallow the debug log.
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  return {
    interactive: true,
    frame: (frame) => store.line(formatFrame(frame)),
    channels: (channels) => store.channels(channels),
    staged: (text) => store.staged(text),
    notice: (text) => store.notice(text),
    async stop() {
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
    },
  };
}
