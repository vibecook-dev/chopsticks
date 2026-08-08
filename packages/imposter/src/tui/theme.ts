/**
 * One palette, shared by the TUI and the control console (draft/IMPOSTER.md §4).
 *
 * Purple and blue, because the imposter must never be mistaken for the vendor
 * it is impersonating. Claude Code is orange, Codex is green — a chopsticks
 * imposter that borrowed either would invite exactly the confusion §1.1 exists
 * to prevent. The chrome says "this is a stand-in" at a glance, from across the
 * room, in a pane you did not launch yourself.
 *
 * Hex rather than the sixteen ANSI names: Ink hands these to chalk, which
 * degrades them on terminals without truecolour, and the named colours vary so
 * wildly between themes that "purple" could arrive as anything.
 */

export const THEME = {
  /** The frame, the ghost, and anything that means "imposter". */
  violet: '#a78bfa',
  violetDeep: '#7c5cff',
  /** Live channels, session identity, the prompt caret. */
  blue: '#60a5fa',
  sky: '#38bdf8',
  /** Body text and the op stream. */
  text: '#d7dce2',
  muted: '#7c8496',
  /** Only for a turn that failed or an op the machine did not expect. */
  warn: '#f0788a',
} as const;

/**
 * The ghost. Box-drawing plus an ASCII tilde hem: every glyph here is in the
 * base box-drawing block or plain ASCII, so it renders in any terminal font
 * rather than turning into replacement boxes in the one the user actually has.
 *
 * Three lines, all six columns wide — the header lays it out beside the
 * identity block, and a ragged edge there would be visible immediately.
 */
export const GHOST = [' ╭───╮', ' │· ·│', ' ╰~~~╯'] as const;

/** Ghost eyes follow the lifecycle: the one wink of personality this chrome gets. */
export function ghostFace(state: string): readonly string[] {
  if (state === 'ended') return [' ╭───╮', ' │x x│', ' ╰~~~╯'];
  if (state.startsWith('turn.')) return [' ╭───╮', ' │◦ ◦│', ' ╰~~~╯'];
  return GHOST;
}

/** Lifecycle states, coloured within the two prime hues so nothing reads as a vendor. */
export function stateColor(state: string): string {
  if (state === 'ended') return THEME.muted;
  if (state.startsWith('turn.')) return THEME.violet;
  if (state === 'ready') return THEME.sky;
  return THEME.blue;
}
