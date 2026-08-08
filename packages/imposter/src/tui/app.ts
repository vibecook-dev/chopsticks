/**
 * The imposter's chrome (draft/IMPOSTER.md §4) — one screen for every persona.
 *
 * It announces which agent is being impostered and shows enough to debug by. It
 * is deliberately NOT a clone of any vendor's interface: cloning would spend
 * effort on the one surface chopsticks is forbidden to read, and would produce a
 * screen convincing enough to invite exactly the mistake §1.1 prohibits.
 *
 * `createElement`, not JSX, because this file is loaded by node's type
 * stripping straight from source and node rejects `.tsx`
 * (ERR_UNKNOWN_FILE_EXTENSION, probed 2026-08-08). Ink is a renderer here and
 * nothing else: input is read by the CLI and fed to the shared paste decoder,
 * so there is exactly one input path in both TTY and pipe modes (§4.1.1).
 */

import { Box, Text } from 'ink';
import { createElement as h, useEffect, useState, type ReactElement } from 'react';
import type { TuiStore } from './store.ts';

export interface ImposterAppProps {
  vendor: string;
  version: string;
  sessionId: string;
  store: TuiStore;
}

/** Rows the fixed chrome costs: banner, two rules, prompt. */
const CHROME_ROWS = 4;

/**
 * `||`, not `??`: a PTY with no window size reports `columns === 0`, which is a
 * number and therefore survives `??`. That produced an 8-character rule and a
 * one-line stream the first time this ran under `script`.
 */
function terminalSize(): { columns: number; rows: number } {
  return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState(terminalSize);
  useEffect(() => {
    const onResize = (): void => setSize(terminalSize());
    process.stdout.on('resize', onResize);
    return () => void process.stdout.off('resize', onResize);
  }, []);
  return size;
}

export function ImposterApp({ vendor, version, sessionId, store }: ImposterAppProps): ReactElement {
  const [snapshot, setSnapshot] = useState(store.getSnapshot());
  useEffect(() => store.subscribe(setSnapshot), [store]);
  const { columns, rows } = useTerminalSize();

  const rule = '─'.repeat(Math.max(8, columns));
  const visible = snapshot.lines.slice(-Math.max(1, rows - CHROME_ROWS));
  const prompt = snapshot.staged ? `> ${snapshot.staged}` : '> ';

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { key: 'banner' },
      h(Text, { bold: true, color: 'magenta' }, 'IMPOSTER'),
      h(Text, { dimColor: true }, ' · '),
      `${vendor} ${version}`,
      h(Text, { dimColor: true }, ' · '),
      sessionId.slice(0, 8),
      h(Text, { dimColor: true }, ' · '),
      h(Text, { color: 'cyan' }, snapshot.channels.join(' ')),
    ),
    h(Text, { key: 'rule-top', dimColor: true }, rule),
    h(
      Box,
      { key: 'stream', flexDirection: 'column' },
      ...visible.map((line, index) => h(Text, { key: `${index}-${line}` }, line)),
    ),
    h(Text, { key: 'rule-bottom', dimColor: true }, rule),
    h(Text, { key: 'prompt' }, prompt, snapshot.notice ? h(Text, { color: 'red' }, `  ${snapshot.notice}`) : null),
  );
}
