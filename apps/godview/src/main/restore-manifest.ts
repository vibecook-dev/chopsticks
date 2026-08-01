import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentSessionInfo } from '@vibecook/chopsticks-runtime';

/**
 * What Godview would need to rebuild its windows after the application exits.
 *
 * Ghosttea's own layout document records geometry against terminal session ids,
 * which are all dead once the daemon restarts, so it cannot survive a quit on
 * its own. This manifest is the durable half: per window, the panes in order,
 * each described by something that outlives the process — a cwd for a plain
 * terminal, and for an agent its native session id, which is the resume key
 * (DESIGN §22.1: "resume is spawn configuration, not storage").
 *
 * Deliberately excludes argv and environment. Launch environments can carry
 * session bearer tokens, and DESIGN §22.2 forbids persisting secrets in command
 * arguments or session metadata. Everything here is recoverable from a cwd, an
 * agent kind, and a native session id.
 */
export const RESTORE_MANIFEST_VERSION = 1 as const;

export interface RestoreAgentWorkspace {
  mode: string;
  root: string;
  sourcePath: string;
  branch?: string;
}

/**
 * The terminal session this pane held when the snapshot was taken. Dead by the
 * time anything restores, and that is exactly its use: Ghosttea hands the same
 * id back through `onRehydratePane` for a pane it could not resolve, so it is
 * the join between its saved layout and this manifest. No `paneMeta` needed —
 * the key both sides already agree on is the one Ghosttea persisted itself.
 */
interface RestorePaneIdentity {
  sessionId: string;
}

export type RestorePane = RestorePaneIdentity &
  (
    | { kind: 'terminal'; cwd?: string }
    | {
        kind: 'agent';
        agent: string;
        /** The agent's own session id — what `resume` is given on the way back. */
        nativeSessionId: string;
        cwd?: string;
        workspace: RestoreAgentWorkspace;
      }
  );

export interface RestoreWindow {
  slotId: string;
  groupId: string;
  activeCwd?: string;
  panes: RestorePane[];
}

export interface RestoreManifest {
  version: typeof RESTORE_MANIFEST_VERSION;
  updatedAtMs: number;
  windows: RestoreWindow[];
}

export interface RestoreWindowInput {
  id: string;
  groupId: string;
  activeCwd: string | undefined;
  /** Pane order: the registry builds this from the ordered list the renderer reports. */
  sessionIds: Iterable<string>;
}

export interface RestoreAgentInput {
  info: Pick<AgentSessionInfo, 'agent' | 'sessionId' | 'workspace'>;
  session: Pick<SessionSummary, 'exited'>;
}

export interface BuildRestoreManifestInput {
  windows: readonly RestoreWindowInput[];
  agents: ReadonlyMap<string, RestoreAgentInput>;
  sessions: readonly SessionSummary[];
  updatedAtMs: number;
}

function usable(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function describePane(
  sessionId: string,
  agents: ReadonlyMap<string, RestoreAgentInput>,
  sessions: ReadonlyMap<string, SessionSummary>,
): RestorePane | undefined {
  const session = sessions.get(sessionId);
  // A pane whose session is already gone has nothing to come back to.
  if (!session || session.exited) return undefined;

  const agent = agents.get(sessionId);
  if (!agent || agent.session.exited) {
    const cwd = usable(session.cwd);
    return { sessionId, kind: 'terminal', ...(cwd ? { cwd } : {}) };
  }

  const workspace = agent.info.workspace;
  const cwd = usable(workspace.sourcePath) ?? usable(workspace.root) ?? usable(session.cwd);
  const branch = usable(workspace.branch);
  return {
    sessionId,
    kind: 'agent',
    agent: agent.info.agent,
    nativeSessionId: agent.info.sessionId,
    ...(cwd ? { cwd } : {}),
    workspace: {
      mode: workspace.mode,
      root: workspace.root,
      sourcePath: workspace.sourcePath,
      ...(branch ? { branch } : {}),
    },
  };
}

/** Pure snapshot of what is currently open; the caller owns when it reaches disk. */
export function buildRestoreManifest(input: BuildRestoreManifestInput): RestoreManifest {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]));
  const windows: RestoreWindow[] = [];

  for (const window of input.windows) {
    const panes: RestorePane[] = [];
    for (const sessionId of window.sessionIds) {
      const pane = describePane(sessionId, input.agents, sessions);
      if (pane) panes.push(pane);
    }
    // An empty window is not worth reopening.
    if (!panes.length) continue;
    const activeCwd = usable(window.activeCwd);
    windows.push({
      slotId: window.id,
      groupId: window.groupId,
      ...(activeCwd ? { activeCwd } : {}),
      panes,
    });
  }

  return { version: RESTORE_MANIFEST_VERSION, updatedAtMs: input.updatedAtMs, windows };
}
