import type { ComponentType } from 'react';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { ContextWindowRuntimeState } from '@vibecook/chopsticks-core';
import type { AgentKind, AgentSessionInfo, AgentStateMessage } from '../../protocol.js';
import type { AgentVisualStatus } from '../agent-status.js';
import type { PaneAttachment } from '../pane-attachments.js';
import type { MonitorParameterGroup, MonitorParameters } from './parameters.js';

/** The agent half of a monitored session; absent while a terminal holds no agent. */
export interface MonitorAgentFacet {
  kind: AgentKind;
  provider: string;
  model?: string;
  branch?: string;
  contextWindow?: ContextWindowRuntimeState;
  /** The underlying projections, for a view that wants tools, permissions, or diagnostics. */
  info: AgentSessionInfo;
  state?: AgentStateMessage;
}

/**
 * One monitored session in the only shape a view ever sees.
 *
 * Agent-ness is a facet rather than a separate variant, so a view reads
 * `agent?.model` instead of re-deriving which kind of thing it is holding.
 */
export interface MonitorAgent {
  /** Stable when a terminal is promoted to an agent, so view-local placement survives it. */
  id: string;
  session: SessionSummary;
  status: AgentVisualStatus;
  project: string;
  detail: string;
  color: string;
  /** Mounted in the pane the user is working in. */
  active: boolean;
  /** Colors of the panes showing this session; absent when it is mounted nowhere. */
  attachment?: PaneAttachment;
  cwd?: string;
  /** Where the user asked for it, for views that place new arrivals spatially. */
  spawnHint?: { x: number; y: number };
  agent?: MonitorAgentFacet;
}

export interface MonitorActions {
  /** Mount this session in the active pane. */
  select(agent: MonitorAgent): void;
  /** Open a terminal; spatial views pass where the gesture happened. */
  createAt(position?: { x: number; y: number }): void | Promise<void>;
}

export interface AgentMonitorProps {
  agents: readonly MonitorAgent[];
  parameters: MonitorParameters;
  actions: MonitorActions;
}

/**
 * A way of looking at the running agents. Adding one is a file plus a line in
 * the registry — deliberately the same shape as adding an `AgentProvider` to
 * the runtime (packages/runtime/src/providers.ts).
 *
 * A view is a pure function of these props. It never reaches the runtime, the
 * workspace, or a terminal, which is what keeps it structurally unable to break
 * the invariant that semantics never come from terminal text (DESIGN ADR-003).
 */
export interface AgentMonitorView {
  readonly id: string;
  readonly label: string;
  readonly parameterGroups: readonly MonitorParameterGroup[];
  readonly Component: ComponentType<AgentMonitorProps>;
}
