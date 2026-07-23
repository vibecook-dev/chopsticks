import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { folderName } from './folder-name.js';

function usableCwd(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/** Resolve a split from agent-owned cwd, fresh terminal metadata, then stable launch fallbacks. */
export function paneSessionLaunchSource(
  selected: SessionSummary,
  refreshedSessions: readonly SessionSummary[],
  agentCwd?: string,
  fallbackCwd?: string,
): { session: SessionSummary; cwd?: string } {
  const refreshed = refreshedSessions.find((session) => session.id === selected.id) ?? selected;
  const cwd = usableCwd(agentCwd) ?? usableCwd(refreshed.cwd) ?? usableCwd(selected.cwd) ?? usableCwd(fallbackCwd);
  return { session: refreshed, ...(cwd ? { cwd } : {}) };
}

/** A pane badge is always a folder basename; terminal titles are deliberately ignored. */
export function paneBadgeLabel(session: SessionSummary, agentProject?: string, fallbackCwd?: string): string {
  return folderName(agentProject || session.cwd || fallbackCwd, 'terminal');
}
