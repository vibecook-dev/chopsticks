/**
 * Session state reducer (DESIGN §15).
 *
 * All normalized events pass through this deterministic, pure reducer:
 * - never throws on duplicate, out-of-order, or unknown events
 * - duplicates (sequence <= lastSequence) are skipped by returning the SAME
 *   state reference, so replays are idempotent
 * - invalid transitions produce bounded diagnostics, never exceptions
 * - the raw event log is retained upstream (envelopes are append-only);
 *   state is always rebuildable by replay
 *
 * Terminal geometry and control-lease state (DESIGN §15's `terminal`/`control`
 * fields) are owned by the node runtime, not this reducer — they derive from
 * PTY and lease facts, not agent events.
 */

import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventEnvelope,
  AgentEventSource,
  AgentGitState,
  AgentModelIdentity,
  ProcessExitReason,
  ToolPresentation,
} from './events.js';

export type SessionLifecycle =
  'preparing' | 'starting' | 'ready' | 'running' | 'interrupting' | 'terminating' | 'exited' | 'failed';

export interface ToolRuntimeState {
  toolCallId: string;
  tool?: string;
  state: 'requested' | 'running';
  input?: unknown;
  presentation?: ToolPresentation;
}

export interface ReasoningRuntimeState {
  reasoningId?: string;
  startedAt: string;
}

export interface PermissionRuntimeState {
  requestId: string;
  toolCallId?: string;
  tool?: string;
}

export interface SubagentRuntimeState {
  subagentId: string;
  agentType?: string;
}

export interface TaskRuntimeState {
  taskId: string;
  description?: string;
}

export interface ReducerDiagnostic {
  sequence: number;
  code: string;
  message: string;
}

/** Latest trustworthy context-window measurement for this agent session. */
export interface ContextWindowRuntimeState {
  usedTokens: number;
  capacityTokens: number;
  /** Exact, unrounded percentage in the inclusive range 0..100. */
  usedPercent: number;
  modelId?: string;
  updatedAt: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
}

export interface ObservedEnvironmentValue<T> {
  value: T;
  updatedAt: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
}

export interface SessionEnvironmentRuntimeState {
  currentCwd?: ObservedEnvironmentValue<string>;
  model?: ObservedEnvironmentValue<AgentModelIdentity>;
  /** A null value authoritatively means the current cwd is not in a Git repo. */
  git?: ObservedEnvironmentValue<AgentGitState | null>;
}

export interface SessionRuntimeState {
  lifecycle: SessionLifecycle;
  activeTurn?: { id?: string; startedAt: string };
  /** Present only for providers with an explicit reasoning signal. */
  activeReasoning?: ReasoningRuntimeState;
  /** Tools currently in flight. Completed/failed tools LEAVE this map. */
  tools: Map<string, ToolRuntimeState>;
  /** Pending permission requests. Resolved requests leave this map. */
  permissions: Map<string, PermissionRuntimeState>;
  subagents: Map<string, SubagentRuntimeState>;
  tasks: Map<string, TaskRuntimeState>;
  /** Absent until measured, and while invalidated after compaction/history changes. */
  contextWindow?: ContextWindowRuntimeState;
  /** Live provider/runtime facts about where and how the agent is executing. */
  environment: SessionEnvironmentRuntimeState;
  lastAssistantMessage?: string;
  exit?: { exitCode?: number; signal?: string; reason?: ProcessExitReason | string };
  counters: {
    toolsCompleted: number;
    toolsFailed: number;
    unknownEvents: number;
  };
  lastSequence: number;
  diagnostics: ReducerDiagnostic[];
}

const MAX_DIAGNOSTICS = 50;

export function createInitialSessionState(): SessionRuntimeState {
  return {
    lifecycle: 'preparing',
    tools: new Map(),
    permissions: new Map(),
    subagents: new Map(),
    tasks: new Map(),
    environment: {},
    counters: { toolsCompleted: 0, toolsFailed: 0, unknownEvents: 0 },
    lastSequence: 0,
    diagnostics: [],
  };
}

function withDiagnostic(
  state: SessionRuntimeState,
  sequence: number,
  code: string,
  message: string,
): SessionRuntimeState {
  if (state.diagnostics.length >= MAX_DIAGNOSTICS) return state;
  return { ...state, diagnostics: [...state.diagnostics, { sequence, code, message }] };
}

function isTerminal(lifecycle: SessionLifecycle): boolean {
  return lifecycle === 'exited' || lifecycle === 'failed';
}

export function reduceSessionState(state: SessionRuntimeState, envelope: AgentEventEnvelope): SessionRuntimeState {
  // Duplicate / out-of-order guard: envelopes are stamped in ingestion order,
  // so a non-increasing sequence is a replayed or stale event. Returning the
  // same reference keeps replays idempotent.
  if (envelope.sequence <= state.lastSequence) return state;

  let next: SessionRuntimeState = { ...state, lastSequence: envelope.sequence };
  const event = envelope.event as AgentEvent;
  const seq = envelope.sequence;

  switch (event.type) {
    case 'process.started': {
      if (next.lifecycle === 'preparing') next = { ...next, lifecycle: 'starting' };
      else next = withDiagnostic(next, seq, 'process-started-late', `process.started in ${next.lifecycle}`);
      break;
    }

    case 'session.started':
    case 'session.ready': {
      if (isTerminal(next.lifecycle)) {
        next = withDiagnostic(next, seq, 'session-start-after-exit', `${event.type} in ${next.lifecycle}`);
      } else if (next.lifecycle !== 'running') {
        next = { ...next, lifecycle: 'ready' };
      }
      break;
    }

    case 'turn.started': {
      if (isTerminal(next.lifecycle)) {
        next = withDiagnostic(next, seq, 'turn-after-exit', `turn.started in ${next.lifecycle}`);
        break;
      }
      if (next.activeTurn) {
        next = withDiagnostic(next, seq, 'turn-overlap', `turn.started while turn ${next.activeTurn.id ?? '?'} active`);
      }
      next = { ...next, lifecycle: 'running', activeTurn: { id: event.turnId, startedAt: envelope.timestamp } };
      break;
    }

    case 'turn.completed':
    case 'turn.failed': {
      if (next.activeTurn && event.turnId && next.activeTurn.id && next.activeTurn.id !== event.turnId) {
        next = withDiagnostic(
          next,
          seq,
          'turn-mismatch',
          `${event.type} for ${event.turnId}, active is ${next.activeTurn.id}`,
        );
      }
      next = { ...next, activeTurn: undefined, activeReasoning: undefined };
      if (!isTerminal(next.lifecycle)) next = { ...next, lifecycle: 'ready' };
      if (event.type === 'turn.completed' && event.lastAssistantMessage !== undefined) {
        next = { ...next, lastAssistantMessage: event.lastAssistantMessage };
      }
      break;
    }

    case 'assistant.message': {
      if (event.final !== false) next = { ...next, lastAssistantMessage: event.text };
      break;
    }

    case 'context-window.updated': {
      if (
        !Number.isFinite(event.usedTokens) ||
        event.usedTokens < 0 ||
        !Number.isFinite(event.capacityTokens) ||
        event.capacityTokens <= 0
      ) {
        next = withDiagnostic(
          next,
          seq,
          'context-window-invalid',
          `invalid context window ${event.usedTokens}/${event.capacityTokens}`,
        );
        break;
      }
      next = {
        ...next,
        contextWindow: {
          usedTokens: event.usedTokens,
          capacityTokens: event.capacityTokens,
          usedPercent: Math.min(100, Math.max(0, (event.usedTokens / event.capacityTokens) * 100)),
          modelId: event.modelId,
          updatedAt: envelope.timestamp,
          source: envelope.source,
          confidence: envelope.confidence,
        },
      };
      break;
    }

    case 'context-window.invalidated':
      next = { ...next, contextWindow: undefined };
      break;

    case 'session.environment.updated': {
      let environment = next.environment;
      const observed = <T>(value: T): ObservedEnvironmentValue<T> => ({
        value,
        updatedAt: envelope.timestamp,
        source: envelope.source,
        confidence: envelope.confidence,
      });

      if (event.currentCwd !== undefined) {
        if (event.currentCwd === null) {
          environment = { ...environment, currentCwd: undefined, git: undefined };
        } else if (!event.currentCwd.trim()) {
          next = withDiagnostic(next, seq, 'environment-cwd-invalid', 'current cwd must be non-empty');
        } else {
          const cwd = event.currentCwd.trim();
          const changed = environment.currentCwd?.value !== cwd;
          environment = { ...environment, currentCwd: observed(cwd), ...(changed ? { git: undefined } : {}) };
        }
      }

      if (event.model !== undefined) {
        if (event.model === null) {
          environment = { ...environment, model: undefined };
        } else if (!event.model.id.trim()) {
          next = withDiagnostic(next, seq, 'environment-model-invalid', 'model id must be non-empty');
        } else {
          const id = event.model.id.trim();
          const previous = environment.model?.value.id === id ? environment.model.value : undefined;
          environment = { ...environment, model: observed({ ...previous, ...event.model, id }) };
        }
      }

      if (event.git !== undefined) {
        if (event.git !== null && !event.git.root.trim()) {
          next = withDiagnostic(next, seq, 'environment-git-invalid', 'Git root must be non-empty');
        } else {
          environment = { ...environment, git: observed(event.git) };
        }
      }

      if (environment !== next.environment) next = { ...next, environment };
      break;
    }

    case 'reasoning.started':
      next = {
        ...next,
        activeReasoning: { reasoningId: event.reasoningId, startedAt: envelope.timestamp },
      };
      break;

    case 'reasoning.progress':
    case 'reasoning.summary':
      if (!next.activeReasoning) {
        next = {
          ...next,
          activeReasoning: { reasoningId: event.reasoningId, startedAt: envelope.timestamp },
        };
      }
      break;

    case 'reasoning.completed':
      next = { ...next, activeReasoning: undefined };
      break;

    case 'tool.requested': {
      const tools = new Map(next.tools);
      tools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        tool: event.tool,
        state: 'requested',
        input: event.input,
        presentation: event.presentation,
      });
      next = { ...next, tools };
      break;
    }

    case 'tool.started': {
      const existing = next.tools.get(event.toolCallId);
      const tools = new Map(next.tools);
      tools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        tool: event.tool ?? existing?.tool,
        state: 'running',
        input: event.input ?? existing?.input,
        presentation: event.presentation ?? existing?.presentation,
      });
      next = { ...next, tools };
      break;
    }

    case 'tool.completed':
    case 'tool.failed': {
      // Absent ids are not diagnostics: hook and transcript sources may both
      // report the same completion, and the second one finds the map empty.
      if (next.tools.has(event.toolCallId)) {
        const tools = new Map(next.tools);
        tools.delete(event.toolCallId);
        next = { ...next, tools };
      }
      const counters = { ...next.counters };
      if (event.type === 'tool.completed') counters.toolsCompleted += 1;
      else counters.toolsFailed += 1;
      next = { ...next, counters };
      break;
    }

    case 'permission.requested': {
      // Permission state is intentionally isolated from tool state (DESIGN §26.5).
      const permissions = new Map(next.permissions);
      permissions.set(event.requestId, { requestId: event.requestId, toolCallId: event.toolCallId, tool: event.tool });
      next = { ...next, permissions };
      break;
    }

    case 'permission.resolved': {
      if (next.permissions.has(event.requestId)) {
        const permissions = new Map(next.permissions);
        permissions.delete(event.requestId);
        next = { ...next, permissions };
      }
      break;
    }

    case 'subagent.started': {
      const subagents = new Map(next.subagents);
      subagents.set(event.subagentId, { subagentId: event.subagentId, agentType: event.agentType });
      next = { ...next, subagents };
      break;
    }

    case 'subagent.stopped': {
      if (next.subagents.has(event.subagentId)) {
        const subagents = new Map(next.subagents);
        subagents.delete(event.subagentId);
        next = { ...next, subagents };
      }
      break;
    }

    case 'task.created': {
      const tasks = new Map(next.tasks);
      tasks.set(event.taskId, { taskId: event.taskId, description: event.description });
      next = { ...next, tasks };
      break;
    }

    case 'task.completed': {
      if (next.tasks.has(event.taskId)) {
        const tasks = new Map(next.tasks);
        tasks.delete(event.taskId);
        next = { ...next, tasks };
      }
      break;
    }

    case 'session.exited': {
      if (next.activeTurn) {
        next = withDiagnostic(
          next,
          seq,
          'turn-orphaned-on-exit',
          `session exited with turn ${next.activeTurn.id ?? '?'} active`,
        );
      }
      if (next.tools.size > 0) {
        next = withDiagnostic(
          next,
          seq,
          'tools-orphaned-on-exit',
          `session exited with ${next.tools.size} tool(s) in flight`,
        );
      }
      next = {
        ...next,
        lifecycle: 'exited',
        activeTurn: undefined,
        activeReasoning: undefined,
        tools: new Map(),
        permissions: new Map(),
        exit: next.exit ?? { reason: event.reason },
      };
      break;
    }

    case 'process.exited': {
      const failed = event.reason === 'crash' || event.reason === 'spawn-failed' || event.reason === 'workspace-failed';
      next = {
        ...next,
        lifecycle: isTerminal(next.lifecycle) ? next.lifecycle : failed ? 'failed' : 'exited',
        activeTurn: undefined,
        activeReasoning: undefined,
        exit: { exitCode: event.exitCode, signal: event.signal, reason: event.reason },
      };
      break;
    }

    case 'workspace.changed':
    case 'notification':
      break;

    case 'adapter.native-event': {
      next = { ...next, counters: { ...next.counters, unknownEvents: next.counters.unknownEvents + 1 } };
      break;
    }

    default: {
      // Unknown event types must never throw (DESIGN §15.2).
      next = { ...next, counters: { ...next.counters, unknownEvents: next.counters.unknownEvents + 1 } };
      break;
    }
  }

  return next;
}
