/**
 * What the TUI renders (draft/IMPOSTER.md §4), as an external store.
 *
 * The session pushes into this from outside React; the Ink component only
 * subscribes. Keeping the state here rather than in a component is what lets
 * the headless sink and the TUI share one formatter — the two modes differ in
 * how a line is displayed, never in what a line says.
 */

import type { PresentationFrame } from '../session/timeline.ts';

export interface TuiSnapshot {
  channels: readonly string[];
  lines: readonly string[];
  /** Lifecycle state id from the session's machine, e.g. `turn.thinking`. */
  state: string;
  /** Pasted-but-not-submitted text, shown at the prompt. */
  staged: string;
  notice: string;
}

export interface TuiStore {
  getSnapshot(): TuiSnapshot;
  subscribe(listener: (snapshot: TuiSnapshot) => void): () => void;
  line(text: string): void;
  channels(channels: readonly string[]): void;
  state(state: string): void;
  staged(text: string): void;
  notice(text: string): void;
}

/** Enough scrollback to debug a turn; the terminal only ever shows a window of it. */
const MAX_LINES = 500;

/**
 * One line per op or event, identical in both modes. Cosmetic only — nothing
 * ever parses this back, which is the whole reason the TUI is allowed to be a
 * summary rather than a faithful reproduction (§4).
 *
 * A silent op is still shown: it happened, the persona just binds no channel
 * for it, and seeing the gap is the point (see the note in timeline.ts).
 */
export function formatFrame(frame: PresentationFrame): string {
  const at = frame.at.slice(11, 23);
  const detail = frame.with.text ?? frame.with.tool ?? frame.with.reason ?? '';
  return `${at}  ${frame.op}${detail ? `  ${JSON.stringify(detail)}` : ''}${frame.silent ? '  (unbound)' : ''}`;
}

export function createTuiStore(channels: readonly string[]): TuiStore {
  let snapshot: TuiSnapshot = { channels: [...channels], lines: [], state: 'starting', staged: '', notice: '' };
  const listeners = new Set<(snapshot: TuiSnapshot) => void>();

  const commit = (next: TuiSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    line(text) {
      const lines = [...snapshot.lines, text];
      commit({ ...snapshot, lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines });
    },
    channels(channels) {
      commit({ ...snapshot, channels: [...channels] });
    },
    state(state) {
      commit({ ...snapshot, state });
    },
    staged(text) {
      commit({ ...snapshot, staged: text });
    },
    notice(text) {
      commit({ ...snapshot, notice: text });
    },
  };
}
