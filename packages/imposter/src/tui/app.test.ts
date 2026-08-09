/**
 * The chrome, rendered (draft/IMPOSTER.md §4).
 *
 * Ink is pointed at a PassThrough rather than a pty, which is enough because
 * everything asserted here is layout and content.
 *
 * What these tests defend is not the art. It is that the screen says which
 * vendor is being impersonated, says where the lifecycle is, and says it in
 * colours no vendor uses — the three things that stop someone mistaking a
 * stand-in for the real agent.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTuiStore, type TuiStore } from './store.ts';
import { stateColor, THEME } from './theme.ts';

// Chalk decides its colour level when it is first imported, from the
// environment rather than from anything this package controls. A real terminal
// gets 24 bit (verified against a pty capture: all six theme colours arrive as
// `38;2;…`); a vitest worker gets none, which would leave the palette assertion
// below unfalsifiable. Ink is imported dynamically, so setting this first works.
process.env.FORCE_COLOR = '3';

/**
 * Built rather than written literally: a raw ESC byte in a source file is
 * invisible to every reader and to grep. The `?` in the class is load-bearing —
 * without it `ESC[?25l` survives stripping and inflates every width
 * measurement, which is how the truncation check below first "failed".
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

interface Rendered {
  store: TuiStore;
  /** Latest frame with ANSI removed. */
  plain(): string;
  /** Latest frame, escapes intact. */
  raw(): string;
  stop(): void;
}

async function renderApp(columns = 90, rows = 20): Promise<Rendered> {
  const [{ render }, { createElement }, { ImposterApp }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./app.ts'),
  ]);
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  let text = '';
  stdout.on('data', (chunk: Buffer) => void (text += chunk.toString()));

  const store = createTuiStore(['hook', 'transcript']);
  const instance = render(
    createElement(ImposterApp, { vendor: 'claude', version: '2.1.207', sessionId: 'abcdef1234567890', store }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
      // Same reason mount.ts sets it, and the reason these tests passed locally
      // and failed in CI: Ink's detection is `!isInCi && isTTY`, and CI wins.
      // Without it Ink writes one frame at unmount and every assertion here
      // sees an empty string.
      interactive: true,
    },
  );
  return {
    store,
    plain: () => text.replace(ANSI, ''),
    raw: () => text,
    stop: () => instance.unmount(),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

describe('the imposter chrome', () => {
  it('frames itself in a rounded box and says who it is impersonating', async () => {
    const screen = await renderApp();
    await settle();
    const plain = screen.plain();
    screen.stop();

    expect(plain).toContain('╭');
    expect(plain).toContain('╰');
    expect(plain).toContain('IMPOSTER impersonating claude 2.1.207');
    expect(plain).toContain('abcdef12');
    expect(plain).toContain('hook · transcript');
  });

  it('draws a ghost whose face follows the lifecycle', async () => {
    const screen = await renderApp();
    await settle();
    expect(screen.plain()).toContain('│· ·│');

    screen.store.state('turn.tool');
    await settle();
    expect(screen.plain()).toContain('│◦ ◦│');

    screen.store.state('ended');
    await settle();
    screen.stop();
    expect(screen.plain()).toContain('│x x│');
  });

  it('shows the machine state, and changes it when the session transitions', async () => {
    const screen = await renderApp();
    await settle();
    expect(screen.plain()).toContain('state starting');

    screen.store.state('turn.approval');
    await settle();
    screen.stop();
    expect(screen.plain()).toContain('state turn.approval');
  });

  it('paints in violet and blue — never a colour a real vendor uses', async () => {
    const screen = await renderApp();
    await settle();
    const raw = screen.raw();
    screen.stop();
    // chalk emits hex as a 24-bit SGR triple; asserting on the numbers keeps
    // this honest about what actually reaches the terminal.
    const rgb = (hex: string): string => {
      const value = Number.parseInt(hex.slice(1), 16);
      return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
    };
    expect(raw).toContain(rgb(THEME.violet));
    expect(raw).toContain(rgb(THEME.violetDeep));
    expect(raw).toContain(rgb(THEME.sky));
  });

  it('truncates a long op line instead of wrapping the frame apart', async () => {
    const screen = await renderApp(60);
    screen.store.line(`12:00:00.000  tool.start  ${'x'.repeat(400)}`);
    await settle();
    const lines = screen.plain().split('\n');
    screen.stop();
    // Every rendered row stays inside the terminal, border included.
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(60);
    // And the frame is still whole, which a wrapped line would have destroyed.
    expect(lines.some((line) => line.startsWith('╰'))).toBe(true);
  });

  it('says so when a channel is attached to nothing', async () => {
    const screen = await renderApp();
    screen.store.channels([]);
    await settle();
    screen.stop();
    // `ai --codex` without its server subcommand lands here: ops run, no wire.
    expect(screen.plain()).toContain('no channels attached');
  });
});

describe('the theme', () => {
  it('keeps every lifecycle colour inside the two prime hues', () => {
    const allowed = new Set<string>([THEME.violet, THEME.blue, THEME.sky, THEME.muted]);
    for (const state of ['starting', 'booting', 'ready', 'turn.thinking', 'turn.tool', 'ended']) {
      expect(allowed.has(stateColor(state)), `${state} is off-palette`).toBe(true);
    }
  });
});
