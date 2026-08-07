/**
 * The persona contract (draft/IMPOSTER.md §3.2).
 *
 * A persona is deliberately thin, because most of what the imposter needs is
 * already captured truth: `detection.json` supplies binary names and the argv
 * surface, `channels.json` says which wires exist, and `events/*.json` supplies
 * event names with payload schemas. Those stay adapter-owned (§3.3) and are
 * loaded from the adapter package.
 *
 * What a persona adds is only what the ASM cannot know: which semantic ops map
 * to which channel emissions, and what a session emits at boot.
 */

import type { PayloadSchema, SurfaceModel } from '@vibecook/chopsticks-surface';

/**
 * The vendor-neutral op vocabulary (§2). Deliberately small and semantic: it
 * is NOT a superset of every vendor's events. Anything not expressible as an
 * op — faults, duplicates, out-of-order arrival, unknown native events — is
 * written as a raw emission in a scenario instead.
 */
export const OP_NAMES = [
  // Session lifecycle. `session.ready` is the adapter's boot-finished signal,
  // so a persona that never emits it leaves the driver waiting forever.
  'session.start',
  'session.ready',
  'session.end',
  // Turn ops.
  'turn.start',
  'assistant.delta',
  'tool.start',
  'tool.end',
  'permission.ask',
  'turn.end',
  'usage.refresh',
] as const;

export type OpName = (typeof OP_NAMES)[number];

export type OpChannel = 'hook' | 'transcript' | 'statusline' | 'jsonrpc';

/**
 * One channel emission produced by an op.
 *
 * `event` plus `with` rather than a bare name lookup, because the two adapter
 * families discriminate differently (§2.1): claude gives each op a distinct
 * hook name, while codex routes several ops through one JSON-RPC method and
 * discriminates by item type inside the payload. A payload template covers
 * both. Templates may reference `$op.<field>` for the op's own arguments, plus
 * the usual `$uuid:name` / `$now` / binding substitutions.
 */
export interface OpBinding {
  channel: OpChannel;
  /** Hook event name, or JSON-RPC method. Absent for pure transcript writes. */
  event?: string;
  with?: Record<string, unknown>;
}

/** One op may fan out to several channels; order within an op is preserved. */
export type OpsDocument = Record<string, OpBinding[]>;

export interface OpInvocation {
  op: string;
  with?: Record<string, unknown>;
}

export interface PersonaDocument {
  vendor: string;
  /** Where the captured ASM lives; resolved through the adapter's package.json. */
  asm: { package: string; path: string };
  /** Names written by `ai shims install`, resolved back via argv0 (§6). */
  shimNames: string[];
  /** Ops emitted when a session starts, before any stimulus. */
  boot: OpInvocation[];
}

export interface Persona {
  vendor: string;
  version: string;
  document: PersonaDocument;
  model: SurfaceModel;
  ops: OpsDocument;
  /** Declared channels, from the ASM. */
  channels: string[];
  schemaFor(event: string): PayloadSchema | undefined;
  /** ASM validation for one wire payload; empty means valid. */
  validate(event: string, payload: Record<string, unknown>): string[];
  /**
   * Argv flag aliases for a launch-recipe key, from `detection.json`
   * (`probedFlags` + `launchFlags`), e.g. `name` -> ['-n', '--name'].
   */
  flagsFor(key: string, fallback: string): string[];
}
