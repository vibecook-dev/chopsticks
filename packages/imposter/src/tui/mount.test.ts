/**
 * The two presentation modes (draft/IMPOSTER.md §4.2). The Ink path needs a
 * real TTY and is exercised by driving `ai` under a pty; what is checked here
 * is the contract both modes share, and the headless path CI actually runs.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { PresentationFrame } from '../session/timeline.ts';
import { createPresentation } from './mount.ts';
import { createTuiStore, formatFrame } from './store.ts';

const mountModule = new URL('./mount.ts', import.meta.url).href;
const appModule = new URL('./app.ts', import.meta.url).href;

const frame = (op: string, fields: Record<string, unknown> = {}): PresentationFrame =>
  ({ at: '2026-08-08T06:52:44.306Z', op, with: fields }) as PresentationFrame;

describe('formatFrame', () => {
  it('renders a time, an op, and at most one detail', () => {
    expect(formatFrame(frame('session.start'))).toBe('06:52:44.306  session.start');
    expect(formatFrame(frame('turn.start', { text: 'hi' }))).toBe('06:52:44.306  turn.start  "hi"');
    expect(formatFrame(frame('tool.start', { tool: 'Bash' }))).toBe('06:52:44.306  tool.start  "Bash"');
  });
});

describe('the TUI store', () => {
  it('notifies subscribers with an immutable snapshot', () => {
    const store = createTuiStore(['hook']);
    const seen: Array<readonly string[]> = [];
    const off = store.subscribe((snapshot) => seen.push(snapshot.lines));
    store.line('one');
    store.line('two');
    off();
    store.line('three');
    expect(seen).toEqual([['one'], ['one', 'two']]);
    expect(store.getSnapshot().lines).toEqual(['one', 'two', 'three']);
  });

  it('bounds its scrollback rather than growing without limit under a flood', () => {
    const store = createTuiStore([]);
    for (let index = 0; index < 700; index += 1) store.line(`line ${index}`);
    expect(store.getSnapshot().lines).toHaveLength(500);
    expect(store.getSnapshot().lines.at(-1)).toBe('line 699');
  });
});

describe('headless presentation', () => {
  const capture = async () => {
    const written: string[] = [];
    const screen = await createPresentation({
      vendor: 'claude',
      version: '2.1.207',
      sessionId: 'abc',
      channels: ['hook', 'transcript'],
      interactive: false,
      write: (text) => written.push(text),
    });
    return { screen, written };
  };

  it('announces itself and streams the same lines the TUI shows', async () => {
    const { screen, written } = await capture();
    expect(screen.interactive).toBe(false);
    expect(written[0]).toBe('IMPOSTER · claude 2.1.207 · abc · hook transcript\r\n');
    screen.frame(frame('turn.start', { text: 'hi' }));
    expect(written.at(-1)).toBe(`${formatFrame(frame('turn.start', { text: 'hi' }))}\r\n`);
  });

  it('reports staged pastes and channel changes on the same stream', async () => {
    const { screen, written } = await capture();
    screen.staged('half a prompt');
    expect(written.at(-1)).toContain('[staged] half a prompt');
    screen.channels(['transcript']);
    expect(written.at(-1)).toBe('channels: transcript\r\n');
    await expect(screen.stop()).resolves.toBeUndefined();
  });

  it('resolves neither ink nor react — the pinned layout costs only the mode that gets it', () => {
    // ~40 MB of RSS per process rides on this staying a dynamic import (§4.1.2),
    // and CI and the control centre's spawner are both piped. Checked in a
    // subprocess through a resolve hook, so it observes the real module graph
    // rather than something that merely correlates with it.
    const probe = `
      import { registerHooks } from 'node:module';
      const resolved = [];
      registerHooks({ resolve(specifier, context, next) { resolved.push(specifier); return next(specifier, context); } });
      const { createPresentation } = await import('${mountModule}');
      await createPresentation({ vendor: 'c', version: '1', sessionId: 'x', channels: [], interactive: false, write: () => {} });
      const headless = resolved.filter((s) => s === 'ink' || s === 'react');
      await import('${appModule}');
      const afterTui = resolved.filter((s) => s === 'ink' || s === 'react');
      console.log(JSON.stringify({ headless, afterTui }));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], { encoding: 'utf8' });
    const { headless, afterTui } = JSON.parse(output) as { headless: string[]; afterTui: string[] };
    expect(headless).toEqual([]);
    // The hook works, so the empty result above is evidence and not a no-op.
    expect(afterTui).toContain('ink');
  });
});
