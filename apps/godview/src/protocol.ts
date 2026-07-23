import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type {
  AccountUsageFailure,
  AccountUsageFetchResult,
  ContextWindowRuntimeState,
  ObservationLevel,
  PromptReceipt as CorePromptReceipt,
  SessionEnvironmentRuntimeState,
  ToolPresentation,
} from '@vibecook/chopsticks-core';
import type {
  AgentSessionInfo as RuntimeAgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
  BuiltinAgentKind,
} from '@vibecook/chopsticks-runtime';
import type { WorkspaceDiff, WorkspaceErrorCode } from '@vibecook/chopsticks-workspaces';

export type { WorkspaceDiff } from '@vibecook/chopsticks-workspaces';
export type AgentKind = BuiltinAgentKind;
export type WorkspaceInfo = AgentWorkspaceInfo;
export type PromptReceipt = CorePromptReceipt;
export type WorkspaceFinalEvent = AgentWorkspaceFinal;
export const ACCOUNT_USAGE_AGENTS = ['claude', 'codex', 'grok'] as const;
export type AccountUsageAgent = (typeof ACCOUNT_USAGE_AGENTS)[number];

export interface AgentAccountUsage {
  agent: AccountUsageAgent;
  result: AccountUsageFetchResult;
  /** The last good snapshot is retained when a later refresh fails. */
  stale?: boolean;
  refreshFailure?: AccountUsageFailure;
}

export interface AgentAccountUsageBatch {
  refreshedAt: string;
  entries: AgentAccountUsage[];
}

export interface CreateAgentSessionOptions {
  agent: AgentKind;
  cwd?: string;
  title?: string;
  workspace?: {
    mode: 'direct' | 'exclusive' | 'worktree';
    path?: string;
    resumeBranch?: string;
    resumeRoot?: string;
  };
  resume?: string;
}

export interface AgentSessionInfo extends Omit<RuntimeAgentSessionInfo, 'agent'> {
  agent: AgentKind;
  session: SessionSummary;
}

export interface AgentSessionFailure {
  error: { code: WorkspaceErrorCode | 'AGENT_NOT_FOUND'; message: string };
}

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

export interface SerializedSessionState {
  lifecycle: string;
  activeTurn?: { id?: string; startedAt: string };
  activeReasoning?: { reasoningId?: string; startedAt: string };
  tools: {
    toolCallId: string;
    tool?: string;
    state: 'requested' | 'running';
    input?: unknown;
    presentation?: ToolPresentation;
  }[];
  permissions: { requestId: string; toolCallId?: string; tool?: string }[];
  subagents: { subagentId: string; agentType?: string }[];
  tasks: { taskId: string; description?: string }[];
  contextWindow?: ContextWindowRuntimeState;
  environment: SessionEnvironmentRuntimeState;
  lastAssistantMessage?: string;
  exit?: { exitCode?: number; signal?: string; reason?: string };
  counters: { toolsCompleted: number; toolsFailed: number; unknownEvents: number };
  lastSequence: number;
  diagnostics: { sequence: number; code: string; message: string }[];
}

export interface AgentStateMessage {
  runtimeSessionId: string;
  state: SerializedSessionState;
  observationLevel: ObservationLevel;
}

export interface AgentStateBatch {
  sequence: number;
  states: AgentStateMessage[];
}

export interface AgentSessionSnapshot {
  info: AgentSessionInfo;
  state?: AgentStateMessage;
  final?: WorkspaceFinalEvent;
}

export interface SubmitPromptOptions {
  runtimeSessionId: string;
  text: string;
}

export interface ChopsticksBridge {
  createAgentSession(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  listAgentSessions(): Promise<AgentSessionSnapshot[]>;
  onAgentSession(cb: (info: AgentSessionInfo) => void): () => void;
  onAgentRemoved(cb: (runtimeSessionId: string) => void): () => void;
  submitPrompt(opts: SubmitPromptOptions): Promise<PromptReceipt>;
  onAgentState(cb: (state: AgentStateMessage) => void): () => void;
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  onWorkspaceFinal(cb: (event: WorkspaceFinalEvent) => void): () => void;
  accountUsage(): Promise<AgentAccountUsageBatch>;
  refreshAccountUsage(): Promise<AgentAccountUsageBatch>;
  onAccountUsage(cb: (batch: AgentAccountUsageBatch) => void): () => void;
}
