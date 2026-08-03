import { listMonitorView } from '../views/list/index.js';
import { swarmMonitorView } from '../views/swarm/index.js';
import type { AgentMonitorView } from './types.js';

/**
 * Every way of looking at the running agents. A new view is one directory under
 * `views/` and one entry here — the same shape `createBuiltinProviders` gives
 * agent providers in packages/runtime.
 */
export const MONITOR_VIEWS: readonly AgentMonitorView[] = [swarmMonitorView, listMonitorView];

export const DEFAULT_MONITOR_VIEW_ID = swarmMonitorView.id;

/** Falls back to the default, so a stored id from a removed view cannot strand the window. */
export function monitorViewFor(id: string | null | undefined): AgentMonitorView {
  return MONITOR_VIEWS.find((view) => view.id === id) ?? MONITOR_VIEWS[0]!;
}
