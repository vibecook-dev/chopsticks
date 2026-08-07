/**
 * Terminal channel — input side (draft/IMPOSTER.md §4.1.1).
 *
 * The adapter injects prompts as a guarded bracketed paste through
 * `AgentHost.automateTerminal`, so decoding that byte sequence is the single
 * most load-bearing input path the imposter has. It lives here, in ONE place,
 * used identically by the headless (pipe) path and the Ink TUI — which is why
 * the TUI must not adopt Ink's own `usePaste`.
 */

export interface PasteOperation {
  text: string;
  /** True when the paste was followed by Enter (`\r`). */
  submit: boolean;
}

export interface PasteDecoder {
  feed(chunk: string | Buffer): void;
  /** Emit any held paste as unsubmitted (stream ending). */
  flush(): void;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Splits a stdin byte stream into paste operations and plain input. A submit
 * (`\r`) may arrive in a later chunk than the paste close marker, so a
 * completed paste is held briefly for it; `flush` (or the hold timer) emits
 * it as paste-only.
 */
export function createPasteDecoder(
  onPaste: (operation: PasteOperation) => void,
  onInput?: (text: string) => void,
  holdMs = 15,
): PasteDecoder {
  let buffer = '';
  let inPaste = false;
  let held: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const releaseHeld = (submit: boolean): void => {
    if (held === undefined) return;
    const text = held;
    held = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    onPaste({ text, submit });
  };
  const holdForSubmit = (): void => {
    timer = setTimeout(() => releaseHeld(false), holdMs);
  };
  /** Longest suffix of `buffer` that could grow into the paste start marker. */
  const partialStart = (): number => {
    for (let length = Math.min(buffer.length, PASTE_START.length - 1); length > 0; length -= 1) {
      if (PASTE_START.startsWith(buffer.slice(-length))) return length;
    }
    return 0;
  };

  return {
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (;;) {
        if (held !== undefined) {
          if (buffer.length === 0) return;
          if (buffer.startsWith('\r')) {
            buffer = buffer.slice(1);
            releaseHeld(true);
          } else {
            releaseHeld(false);
          }
          continue;
        }
        if (!inPaste) {
          const start = buffer.indexOf(PASTE_START);
          if (start < 0) {
            const keep = partialStart();
            const plain = buffer.slice(0, buffer.length - keep);
            if (plain && onInput) onInput(plain);
            buffer = buffer.slice(buffer.length - keep);
            return;
          }
          if (start > 0 && onInput) onInput(buffer.slice(0, start));
          buffer = buffer.slice(start + PASTE_START.length);
          inPaste = true;
          continue;
        }
        const end = buffer.indexOf(PASTE_END);
        if (end < 0) return; // mid-paste; keep accumulating
        inPaste = false;
        held = buffer.slice(0, end);
        buffer = buffer.slice(end + PASTE_END.length);
        if (buffer.startsWith('\r')) {
          buffer = buffer.slice(1);
          releaseHeld(true);
        } else if (buffer.length > 0) {
          releaseHeld(false);
        } else {
          holdForSubmit();
          return;
        }
      }
    },
    flush() {
      releaseHeld(false);
    },
  };
}
