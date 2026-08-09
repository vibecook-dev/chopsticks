/**
 * The imposter's chrome (draft/IMPOSTER.md §4) — one screen for every persona.
 *
 * It announces which agent is being impostered, where that session's lifecycle
 * is, and the ops as they run. It is deliberately NOT a clone of any vendor's
 * interface: cloning would spend effort on the one surface chopsticks is
 * forbidden to read, and would produce a screen convincing enough to invite
 * exactly the mistake §1.1 prohibits. The ghost and the violet frame exist to
 * make that unmistakable — this window is a stand-in, and looks like one.
 *
 * The state on screen is not derived here. It is the same `MachineSnapshot` the
 * control console renders, pushed from the session (session/machine.ts), which
 * is why the screen can never describe a lifecycle the ops did not produce.
 *
 * `createElement`, not JSX, because this file is loaded by node's type
 * stripping straight from source and node rejects `.tsx`
 * (ERR_UNKNOWN_FILE_EXTENSION, probed 2026-08-08). Ink is a renderer here and
 * nothing else: input is read by the CLI and fed to the shared paste decoder,
 * so there is exactly one input path in both TTY and pipe modes (§4.1.1).
 */

import { Box, Text, useStdout } from 'ink';
import { createElement as h, useEffect, useState, type ReactElement } from 'react';
import type { TuiStore } from './store.ts';
import { ghostFace, stateColor, THEME } from './theme.ts';

export interface ImposterAppProps {
  vendor: string;
  version: string;
  sessionId: string;
  store: TuiStore;
}

/**
 * Rows the fixed chrome costs: two border rows, three header rows, one rule,
 * and the prompt below the frame.
 */
const CHROME_ROWS = 7;
/** Border and padding on each side. */
const CHROME_COLUMNS = 4;

/**
 * The size of the stream Ink is actually writing to, not `process.stdout`.
 * They are the same in production and different under test, and measuring the
 * one being rendered to is the version that cannot be wrong.
 *
 * `||`, not `??`: a PTY with no window size reports `columns === 0`, which is a
 * number and therefore survives `??`. That produced an 8-character rule and a
 * one-line stream the first time this ran under `script`.
 */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const measure = (): { columns: number; rows: number } => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [size, setSize] = useState(measure);
  useEffect(() => {
    const onResize = (): void => setSize(measure());
    onResize();
    stdout.on('resize', onResize);
    return () => void stdout.off('resize', onResize);
  }, [stdout]);
  return size;
}

export function ImposterApp({ vendor, version, sessionId, store }: ImposterAppProps): ReactElement {
  const [snapshot, setSnapshot] = useState(store.getSnapshot());
  useEffect(() => store.subscribe(setSnapshot), [store]);
  const { columns, rows } = useTerminalSize();

  const width = Math.max(32, columns);
  const inner = Math.max(16, width - CHROME_COLUMNS);
  const visible = snapshot.lines.slice(-Math.max(1, rows - CHROME_ROWS));
  const ghost = ghostFace(snapshot.state);

  const header = h(
    Box,
    { key: 'header', flexDirection: 'row' },
    h(
      Box,
      { key: 'ghost', flexDirection: 'column', marginRight: 2 },
      ...ghost.map((line, index) => h(Text, { key: `ghost-${index}`, color: THEME.violet }, line)),
    ),
    h(
      Box,
      { key: 'identity', flexDirection: 'column' },
      h(
        Text,
        { key: 'who', wrap: 'truncate-end' },
        h(Text, { bold: true, color: THEME.violet }, 'IMPOSTER'),
        h(Text, { color: THEME.muted }, ' impersonating '),
        h(Text, { bold: true, color: THEME.text }, `${vendor} ${version}`),
      ),
      h(
        Text,
        { key: 'state', wrap: 'truncate-end' },
        h(Text, { color: THEME.muted }, 'session '),
        h(Text, { color: THEME.blue }, sessionId.slice(0, 8)),
        h(Text, { color: THEME.muted }, '  state '),
        h(Text, { bold: true, color: stateColor(snapshot.state) }, snapshot.state),
      ),
      h(
        Text,
        { key: 'channels', wrap: 'truncate-end' },
        snapshot.channels.length > 0
          ? h(Text, { color: THEME.sky }, snapshot.channels.join(' · '))
          : h(Text, { color: THEME.muted }, 'no channels attached'),
      ),
    ),
  );

  return h(
    Box,
    { flexDirection: 'column', width },
    h(
      Box,
      {
        key: 'frame',
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: THEME.violetDeep,
        paddingX: 1,
        width,
      },
      header,
      h(Text, { key: 'rule', color: THEME.muted }, '─'.repeat(inner)),
      h(
        Box,
        { key: 'stream', flexDirection: 'column' },
        ...visible.map((line, index) =>
          h(Text, { key: `${index}-${line}`, color: THEME.text, wrap: 'truncate-end' }, line),
        ),
      ),
    ),
    h(
      Text,
      { key: 'prompt', wrap: 'truncate-end' },
      h(Text, { color: THEME.violet }, ' › '),
      snapshot.staged,
      snapshot.notice ? h(Text, { color: THEME.warn }, `  ${snapshot.notice}`) : null,
    ),
  );
}
