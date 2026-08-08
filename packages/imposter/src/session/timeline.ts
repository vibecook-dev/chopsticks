/**
 * The op timeline — one truth, two projections (draft/IMPOSTER.md §2).
 *
 * A turn is a sequence of semantic ops. Each op fans out to BOTH a semantic
 * projection (hook / transcript / statusline / JSON-RPC, per the persona's
 * ops.json) and a presentation projection (the frame sink). They cannot
 * disagree, because there is only one source: an op either happened or it did
 * not, and both projections are derived from that single fact.
 *
 * That property is the reason a real TUI is safe to add at all. The screen is
 * a projection of the same ops that produced the wire traffic, so it can never
 * describe a turn the adapter did not observe — and it is still never read
 * back for semantics (§1.1).
 */

import type { OpInvocation, Persona } from '../persona/types.ts';
import type { TranscriptWriter } from './channels/transcript.ts';
import { substitute } from './template.ts';

/**
 * The presentation projection of one op. Human-facing only: formatting lives
 * in the sink, and NOTHING may parse these back into semantics (§1.1).
 */
export interface PresentationFrame {
  at: string;
  op: string;
  with: Record<string, unknown>;
}

export interface OpTimelineOptions {
  persona: Persona;
  /**
   * Hook delivery. The session owns envelope merging and ASM validation at
   * this boundary, so the timeline never has to know what an envelope is —
   * and there is exactly one place that decides what hits the wire.
   */
  emitHook: (event: string, payload: Record<string, unknown>) => Promise<void>;
  transcript: TranscriptWriter;
  statusline?: (payload: Record<string, unknown>) => Promise<void>;
  emitJsonRpc?: (method: string, params: Record<string, unknown>) => Promise<void>;
  /** Presentation sink: the headless log, or the Ink TUI once it lands. */
  present?: (frame: PresentationFrame) => void;
  /** Session-scoped bindings ($sessionId, $cwd, $permissionMode, …). */
  bindings?: Record<string, unknown>;
  /** Payload for a `usage.refresh` op whose binding carries no template. */
  statusPayload?: () => Record<string, unknown>;
  log?: (message: string) => void;
}

export interface OpTimeline {
  /** Run one op, fanning it out to every channel its persona binds. */
  run(invocation: OpInvocation): Promise<void>;
  runAll(invocations: readonly OpInvocation[]): Promise<void>;
  /**
   * Start a new turn's uuid scope. `$uuid:prompt` must be stable across the
   * ops OF ONE TURN — that is what correlates a prompt_id from
   * UserPromptSubmit through PreToolUse to Stop — and must differ between
   * turns. Everything before the first call shares the boot scope.
   */
  beginTurn(): void;
}

export function createOpTimeline(options: OpTimelineOptions): OpTimeline {
  const log = options.log ?? (() => {});
  let uuids = new Map<string, string>();

  const run = async (invocation: OpInvocation): Promise<void> => {
    const bindings = options.persona.ops[invocation.op];
    if (!bindings) {
      // An op the persona does not bind is a persona gap, not a crash: the
      // vendor may genuinely have no wire representation for it.
      log(`op ${invocation.op} is unbound for persona ${options.persona.vendor}`);
      return;
    }
    const context = {
      scopes: { op: invocation.with ?? {} },
      bindings: options.bindings,
      uuids,
    };

    options.present?.({ at: new Date().toISOString(), op: invocation.op, with: invocation.with ?? {} });

    for (const binding of bindings) {
      const payload =
        binding.with === undefined ? undefined : (substitute(binding.with, context) as Record<string, unknown>);
      switch (binding.channel) {
        case 'hook': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds the hook channel without an event name`);
          await options.emitHook(binding.event, payload ?? {});
          break;
        }
        case 'transcript': {
          if (!payload) throw new Error(`op ${invocation.op} binds the transcript channel without a record`);
          options.transcript.append(payload);
          break;
        }
        case 'statusline': {
          if (!options.statusline) {
            log(`op ${invocation.op} wants the statusline channel, which is not configured`);
            break;
          }
          await options.statusline(payload ?? options.statusPayload?.() ?? {});
          break;
        }
        case 'jsonrpc': {
          if (!binding.event) throw new Error(`op ${invocation.op} binds the jsonrpc channel without a method`);
          if (!options.emitJsonRpc) {
            log(`op ${invocation.op} wants the jsonrpc channel, which is not configured`);
            break;
          }
          await options.emitJsonRpc(binding.event, payload ?? {});
          break;
        }
      }
    }
  };

  return {
    run,
    async runAll(invocations) {
      for (const invocation of invocations) await run(invocation);
    },
    beginTurn() {
      uuids = new Map();
    },
  };
}
