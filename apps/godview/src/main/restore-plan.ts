import {
  RESTORE_MANIFEST_VERSION,
  type RestoreManifest,
  type RestorePane,
  type RestoreWindow,
} from './restore-manifest.js';

/**
 * Reading back what {@link buildRestoreManifest} wrote.
 *
 * The file is on disk between runs, so it is treated as untrusted input rather
 * than as something this build necessarily produced: a manifest from a future
 * version, a half-edited file, or a hand-written one must all decline politely
 * instead of crashing a launch. Anything unrecognized yields `undefined`, and
 * the application starts exactly as it does with no manifest at all.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseWorkspace(value: unknown): RestoreAgentWorkspaceParse | undefined {
  if (!isRecord(value)) return undefined;
  const mode = optionalString(value.mode);
  const root = optionalString(value.root);
  const sourcePath = optionalString(value.sourcePath);
  if (!mode || !root || !sourcePath) return undefined;
  const branch = optionalString(value.branch);
  return { mode, root, sourcePath, ...(branch ? { branch } : {}) };
}

interface RestoreAgentWorkspaceParse {
  mode: string;
  root: string;
  sourcePath: string;
  branch?: string;
}

function parsePane(value: unknown): RestorePane | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = optionalString(value.sessionId);
  if (!sessionId) return undefined;
  const cwd = optionalString(value.cwd);

  if (value.kind === 'terminal') {
    return { sessionId, kind: 'terminal', ...(cwd ? { cwd } : {}) };
  }
  if (value.kind !== 'agent') return undefined;

  const agent = optionalString(value.agent);
  const nativeSessionId = optionalString(value.nativeSessionId);
  const workspace = parseWorkspace(value.workspace);
  // Without a resume key there is no agent to come back to. Falling back to a
  // plain terminal at the same cwd keeps the pane and its place rather than
  // dropping the user's layout over a half-written entry.
  if (!agent || !nativeSessionId || !workspace) {
    return { sessionId, kind: 'terminal', ...(cwd ? { cwd } : {}) };
  }
  return { sessionId, kind: 'agent', agent, nativeSessionId, ...(cwd ? { cwd } : {}), workspace };
}

function parseWindow(value: unknown): RestoreWindow | undefined {
  if (!isRecord(value)) return undefined;
  const slotId = optionalString(value.slotId);
  const groupId = optionalString(value.groupId);
  if (!slotId || !groupId) return undefined;
  if (!Array.isArray(value.panes)) return undefined;

  const panes = value.panes.map(parsePane).filter((pane): pane is RestorePane => pane !== undefined);
  if (!panes.length) return undefined;
  const activeCwd = optionalString(value.activeCwd);
  return { slotId, groupId, ...(activeCwd ? { activeCwd } : {}), panes };
}

export function readRestoreManifest(value: unknown): RestoreManifest | undefined {
  if (!isRecord(value)) return undefined;
  // A newer writer may mean fields this build cannot honor; declining is the
  // safe reading, because a partial restore is worse than none.
  if (value.version !== RESTORE_MANIFEST_VERSION) return undefined;
  if (!Array.isArray(value.windows)) return undefined;

  const windows = value.windows.map(parseWindow).filter((window): window is RestoreWindow => window !== undefined);
  if (!windows.length) return undefined;
  const updatedAtMs = typeof value.updatedAtMs === 'number' && Number.isFinite(value.updatedAtMs) ? value.updatedAtMs : 0;
  return { version: RESTORE_MANIFEST_VERSION, updatedAtMs, windows };
}

export interface RestoreSummaryEntry {
  agent: string;
  cwd?: string;
}

export interface RestoreSummary {
  windows: number;
  agents: number;
  terminals: number;
  /** Agent panes, in the order they would come back, for the confirmation prompt. */
  entries: RestoreSummaryEntry[];
}

export function summarizeRestore(manifest: RestoreManifest): RestoreSummary {
  const entries: RestoreSummaryEntry[] = [];
  let terminals = 0;
  for (const window of manifest.windows) {
    for (const pane of window.panes) {
      if (pane.kind === 'agent') entries.push({ agent: pane.agent, ...(pane.cwd ? { cwd: pane.cwd } : {}) });
      else terminals += 1;
    }
  }
  return { windows: manifest.windows.length, agents: entries.length, terminals, entries };
}

function count(value: number, noun: string): string {
  return `${value} ${value === 1 ? noun : `${noun}s`}`;
}

/** The body of the restore prompt: what would come back, and what coming back means. */
export function restorePromptDetail(summary: RestoreSummary, listLimit = 8): string {
  const counts = [
    count(summary.windows, 'window'),
    summary.agents > 0 ? count(summary.agents, 'agent') : undefined,
    summary.terminals > 0 ? count(summary.terminals, 'terminal') : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const listed = summary.entries.slice(0, listLimit).map((entry) => `  ${entry.agent}   ${entry.cwd ?? ''}`.trimEnd());
  const hidden = summary.entries.length - listed.length;
  if (hidden > 0) listed.push(`  …and ${hidden} more`);

  return [
    counts,
    ...(listed.length ? ['', ...listed] : []),
    '',
    // Resume continues a conversation; it does not resurrect a running turn
    // (DESIGN §22.1). Saying so keeps the prompt from implying otherwise.
    'Agents come back with their history, picking up where the conversation left off.',
  ].join('\n');
}

/** The lookup behind `onRehydratePane`: Ghosttea names a dead session, this finds what it was. */
export function restorePaneFor(manifest: RestoreManifest, sessionId: string): RestorePane | undefined {
  for (const window of manifest.windows) {
    for (const pane of window.panes) {
      if (pane.sessionId === sessionId) return pane;
    }
  }
  return undefined;
}
