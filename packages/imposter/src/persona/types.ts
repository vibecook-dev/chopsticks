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
  /**
   * Send as a SERVER request and suspend the op until the client replies,
   * binding the reply as `$response` for the ops that follow. Only meaningful
   * on the jsonrpc channel; this is how an approval resolves (§9.3).
   */
  await?: boolean;
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
  /**
   * Where the ASM lives. With `package`, it is resolved through that package's
   * manifest — captured truth, adapter-owned (§3.3). Without it, `path` is
   * relative to the persona directory, which is only legitimate for a vendor
   * that has no captures because it does not exist (see personas/synthetic).
   */
  asm: { package?: string; path: string };
  /** Names written by `ai shims install`, resolved back via argv0 (§6). */
  shimNames: string[];
  /**
   * Fields merged into every emission on this persona's event channel, as a
   * substitution template (`$sessionId`, `$transcriptPath`, `$cwd`, …).
   *
   * This is persona-owned rather than hard-coded because the envelope is
   * vendor vocabulary: claude sends `session_id`/`transcript_path`, and a
   * vendor that sends something else must be describable without editing the
   * session. Hard-coding claude's shape here was the single most claude-shaped
   * thing left in the contract (found 2026-08-08 by writing a second persona).
   */
  envelope: Record<string, unknown>;
  /**
   * Field the event's own name is written into before delivery — claude's
   * `hook_event_name`. Omit when the vendor's transport carries the name out
   * of band and the payload must not gain a field the ASM has never seen.
   */
  eventNameField?: string;
  /** Ops emitted when a session starts, before any stimulus. */
  boot: OpInvocation[];
}

export interface Persona {
  vendor: string;
  version: string;
  document: PersonaDocument;
  model: SurfaceModel;
  ops: OpsDocument;
  /** Declared channels, from the ASM, under the vendor's own names. */
  channels: string[];
  /**
   * The vendor's channel name for one delivery kind — `hook` is called `hook`
   * by claude and could be called anything by anyone else. Without this the
   * session would drop `hook` while the console showed the vendor's real name
   * still live, and a channel-drop fault would silently do nothing.
   */
  channelFor(kind: OpChannel): string | undefined;
  schemaFor(event: string): PayloadSchema | undefined;
  /** ASM validation for one wire payload; empty means valid. */
  validate(event: string, payload: Record<string, unknown>): string[];
  /**
   * Argv flag aliases for a launch-recipe key, from `detection.json`
   * (`probedFlags` + `launchFlags`), e.g. `name` -> ['-n', '--name'].
   */
  flagsFor(key: string, fallback: string): string[];
}
