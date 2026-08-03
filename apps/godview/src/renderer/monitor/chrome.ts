/**
 * Shell chrome overlaying the monitor stage — the account usage panel today.
 *
 * It is rendered beside the active view rather than inside it, so a view that
 * cares about the space it occupies finds it through this marker instead of by
 * knowing what the chrome is. The swarm keeps bubbles from behind it; a
 * scrolling view clears it with `--monitor-chrome-height`. A view that does not
 * care simply never looks.
 */
export const MONITOR_STAGE_CLASS = 'godview-monitor-stage';
export const MONITOR_CHROME_ATTRIBUTE = 'data-monitor-chrome';
export const MONITOR_CHROME_SELECTOR = `[${MONITOR_CHROME_ATTRIBUTE}]`;

/** Chrome elements sharing a stage with `viewRoot`, in stage coordinates. */
export function monitorChromeElements(viewRoot: HTMLElement): HTMLElement[] {
  const stage = viewRoot.closest(`.${MONITOR_STAGE_CLASS}`) ?? viewRoot;
  return [...stage.querySelectorAll<HTMLElement>(MONITOR_CHROME_SELECTOR)];
}
