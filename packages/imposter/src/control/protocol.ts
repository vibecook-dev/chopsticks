/**
 * Control-channel message shapes (draft/IMPOSTER.md §5.1), shared by the
 * imposter's client and the control center's plane.
 *
 * Zero I/O — types, validation, and the two well-known paths. Framing lives in
 * `peer.ts`, dialing in `client.ts`, and the server side is built from the same
 * two by `apps/emulator/src/main/plane.ts`.
 *
 * Every parser here refuses rather than coerces. The plane is the boundary
 * between a browser console and a process that impersonates a vendor, so a
 * malformed field must fail loudly at the edge instead of arriving at a channel
 * as `undefined` and teaching the adapter something untrue.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SurfaceModel } from '@vibecook/chopsticks-surface';
import type { Persona } from '../persona/types.ts';

// ---------------------------------------------------------------------------
// Errors — JSON-RPC codes, so the plane can map them onto HTTP for the console
// ---------------------------------------------------------------------------

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** The imposter declined: off-model payload, unsupported fault, bad state. */
export const REFUSED = -32000;
/** Addressed something that does not exist (a scenario name, a session). */
export const NOT_FOUND = -32001;

export class ControlError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

/** HTTP status for a JSON-RPC code, for the plane's browser-facing side. */
export function httpStatusForCode(code: number): number {
  if (code === METHOD_NOT_FOUND || code === NOT_FOUND) return 404;
  if (code === INVALID_PARAMS || code === INVALID_REQUEST || code === PARSE_ERROR) return 400;
  if (code === REFUSED) return 422;
  return 500;
}

// ---------------------------------------------------------------------------
// Well-known paths
// ---------------------------------------------------------------------------

/**
 * `sun_path` is ~103 bytes on macOS and ~107 on Linux, so the socket lives at a
 * short fixed path and never a nested per-session one (§5.2). Windows gets a
 * named pipe, which node's `net` reaches through the same API.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

export function controlHome(): string {
  return join(homedir(), '.chopsticks');
}

export function defaultSocketPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.CHOPSTICKS_IMPOSTER_SOCKET;
  if (override) return override;
  if (process.platform === 'win32') return '\\\\.\\pipe\\chopsticks-imposter';
  return join(controlHome(), 'imposter.sock');
}

/**
 * The shared secret, beside the socket rather than inside a discovery file.
 *
 * On POSIX the 0700 directory is the real capability and this is belt-and-
 * braces; on Windows named pipes node exposes no ACL, so the token is the only
 * thing standing between the plane and any local process that guesses the pipe
 * name. It carries no URL, no pid, and no liveness — the socket is discovery,
 * and socket close is liveness (§5).
 */
export function defaultTokenPath(env: Record<string, string | undefined> = process.env): string {
  return env.CHOPSTICKS_IMPOSTER_TOKEN_FILE ?? join(controlHome(), 'imposter.token');
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface PaletteEntry {
  event: string;
  /** PayloadSchema property names, for the console's trigger form. */
  fields: string[];
}

/**
 * One semantic op as this persona binds it. The console drives sessions by op
 * first and by raw event second: an op is what a turn is made of, so firing one
 * produces traffic a real vendor would produce, while a raw event is the
 * adversarial escape hatch that deliberately does not.
 */
export interface OpDescriptor {
  op: string;
  /** Delivery kinds this op fans out to. */
  channels: string[];
  /** Wire names it produces — hook events, or JSON-RPC methods. */
  events: string[];
  /** `$op.<field>` references in the persona's templates, i.e. the op's arguments. */
  fields: string[];
  /** The op suspends until the client answers (an approval). */
  awaits?: boolean;
}

/** Where the session's lifecycle machine is now (session/machine.ts). */
export interface MachineView {
  state: string;
  enabled: string[];
  offModel: number;
  applied: number;
  heartbeats: number;
}

/** imposter -> plane, first message on the connection. */
export interface SessionHello {
  token: string;
  vendor: string;
  version: string;
  sessionId: string;
  pid: number;
  cwd: string;
  channels: string[];
  palette: PaletteEntry[];
  ops: OpDescriptor[];
  machine: MachineView;
}

/** What the plane shows the console. Never carries the token. */
export interface SessionView {
  vendor: string;
  version: string;
  sessionId: string;
  pid: number;
  cwd: string;
  channels: string[];
  palette: PaletteEntry[];
  ops: OpDescriptor[];
  machine: MachineView;
  joinedAt: string;
}

export interface EmittedEntry {
  at: string;
  sequence: number;
  event: string;
  payload?: Record<string, unknown>;
  truncated?: boolean;
}

export interface TriggerRequest {
  event: string;
  with: Record<string, unknown>;
}

export interface OpRequest {
  op: string;
  with: Record<string, unknown>;
}

export interface ScenarioRunRequest {
  name?: string;
  script?: unknown;
  mode: 'play' | 'pause' | 'step';
  speed: number;
  stimulus?: Record<string, unknown>;
}

export type ScenarioControlAction = 'pause' | 'step' | 'resume';

export interface ScenarioControlRequest {
  action: ScenarioControlAction;
}

export type FaultKind = 'crash' | 'exit' | 'hang' | 'flood' | 'channel-drop';

export interface FaultRequest {
  kind: FaultKind;
  channel?: string;
  count?: number;
  event?: string;
  with?: Record<string, unknown>;
  exitCode?: number;
}

export const FAULT_KINDS: readonly FaultKind[] = ['crash', 'exit', 'hang', 'flood', 'channel-drop'];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new ControlError(INVALID_PARAMS, message);
}

export function asRecord(value: unknown, label = 'params'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, field: string, maxLength = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    invalid(`${field} must be a non-empty single-line string of at most ${maxLength} characters`);
  }
  return value;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function stringArray(value: unknown, field: string, maxEntries: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    invalid(`${field} must be an array of at most ${maxEntries} entries`);
  }
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`, maxLength));
}

export function parseHello(params: unknown): SessionHello {
  const record = asRecord(params, 'hello');
  return {
    token: requiredString(record.token, 'token', 512),
    vendor: requiredString(record.vendor, 'vendor', 128),
    version: requiredString(record.version, 'version', 128),
    sessionId: requiredString(record.sessionId, 'sessionId', 512),
    pid: boundedInteger(record.pid, 'pid', 1, Number.MAX_SAFE_INTEGER),
    cwd: requiredString(record.cwd, 'cwd', 4096),
    channels: [...new Set(stringArray(record.channels, 'channels', 64, 128))],
    palette: parsePalette(record.palette),
    ops: parseOps(record.ops),
    machine: parseMachine(record.machine),
  };
}

export function parseOps(value: unknown): OpDescriptor[] {
  if (!Array.isArray(value) || value.length > 128) invalid('ops must be an array of at most 128 entries');
  return value.map((rawEntry, index) => {
    const entry = asRecord(rawEntry, `ops[${index}]`);
    return {
      op: requiredString(entry.op, `ops[${index}].op`, 64),
      channels: stringArray(entry.channels, `ops[${index}].channels`, 16, 128),
      events: stringArray(entry.events, `ops[${index}].events`, 16, 256),
      fields: stringArray(entry.fields, `ops[${index}].fields`, 64, 128),
      ...(entry.awaits === undefined ? {} : { awaits: entry.awaits === true }),
    };
  });
}

export function parseMachine(value: unknown): MachineView {
  const record = asRecord(value, 'machine');
  const count = (field: string): number =>
    boundedInteger(record[field], `machine.${field}`, 0, Number.MAX_SAFE_INTEGER);
  return {
    state: requiredString(record.state, 'machine.state', 64),
    enabled: stringArray(record.enabled, 'machine.enabled', 64, 64),
    offModel: count('offModel'),
    applied: count('applied'),
    heartbeats: count('heartbeats'),
  };
}

export function parsePalette(value: unknown): PaletteEntry[] {
  if (!Array.isArray(value) || value.length > 1024) invalid('palette must be an array of at most 1024 entries');
  return value.map((rawEntry, index) => {
    const entry = asRecord(rawEntry, `palette[${index}]`);
    return {
      event: requiredString(entry.event, `palette[${index}].event`, 256),
      fields: [...new Set(stringArray(entry.fields, `palette[${index}].fields`, 256, 256))],
    };
  });
}

export function parseTrigger(params: unknown): TriggerRequest {
  const record = asRecord(params, 'trigger');
  return {
    event: requiredString(record.event, 'event', 256),
    with: record.with === undefined ? {} : asRecord(record.with, 'with'),
  };
}

export function parseOpRequest(params: unknown): OpRequest {
  const record = asRecord(params, 'op');
  return {
    op: requiredString(record.op, 'op', 64),
    with: record.with === undefined ? {} : asRecord(record.with, 'with'),
  };
}

export function parseScenarioRun(params: unknown): ScenarioRunRequest {
  const record = asRecord(params, 'scenario');
  if ((record.name === undefined) === (record.script === undefined)) {
    invalid('scenario requires exactly one of name or script');
  }
  const mode = record.mode === undefined ? 'play' : String(record.mode);
  if (!['play', 'pause', 'step'].includes(mode)) invalid('scenario mode must be play|pause|step');
  const speed = record.speed === undefined ? 1 : record.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0 || speed > 100) {
    invalid('scenario speed must be greater than 0 and at most 100');
  }
  return {
    ...(record.name === undefined ? {} : { name: requiredString(record.name, 'scenario name', 256) }),
    ...(record.script === undefined ? {} : { script: record.script }),
    mode: mode as 'play' | 'pause' | 'step',
    speed,
    ...(record.stimulus === undefined ? {} : { stimulus: asRecord(record.stimulus, 'stimulus') }),
  };
}

export function parseScenarioControl(params: unknown): ScenarioControlRequest {
  const record = asRecord(params, 'scenario.control');
  const action = requiredString(record.action, 'action', 16);
  if (!['pause', 'step', 'resume'].includes(action)) invalid('scenario control action must be pause|step|resume');
  return { action: action as ScenarioControlAction };
}

export function parseFault(params: unknown, channels: readonly string[] = []): FaultRequest {
  const record = asRecord(params, 'fault');
  const kind = requiredString(record.kind, 'kind', 32);
  if (!FAULT_KINDS.includes(kind as FaultKind)) invalid(`fault kind must be ${FAULT_KINDS.join('|')}`);
  const request: FaultRequest = {
    kind: kind as FaultKind,
    ...(record.channel === undefined ? {} : { channel: requiredString(record.channel, 'channel', 128) }),
    ...(record.event === undefined ? {} : { event: requiredString(record.event, 'event', 256) }),
    ...(record.count === undefined ? {} : { count: boundedInteger(record.count, 'count', 1, 10_000) }),
    ...(record.with === undefined ? {} : { with: asRecord(record.with, 'with') }),
    ...(record.exitCode === undefined ? {} : { exitCode: boundedInteger(record.exitCode, 'exitCode', 0, 255) }),
  };
  if (
    request.kind === 'channel-drop' &&
    (!request.channel || (channels.length > 0 && !channels.includes(request.channel)))
  ) {
    invalid(`channel-drop requires one of: ${channels.join('|')}`);
  }
  return request;
}

export function parseEmitted(params: unknown): EmittedEntry {
  const record = asRecord(params, 'emitted');
  return {
    at: requiredString(record.at, 'at', 64),
    sequence: boundedInteger(record.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER),
    event: requiredString(record.event, 'event', 256),
    ...(record.payload === undefined ? {} : { payload: asRecord(record.payload, 'payload') }),
    ...(record.truncated === undefined ? {} : { truncated: record.truncated === true }),
  };
}

// ---------------------------------------------------------------------------
// Palette derivation
// ---------------------------------------------------------------------------

/**
 * The console's trigger forms are generated from the ASM, never hand-listed —
 * an event the model does not describe is an event the imposter would refuse
 * to emit anyway (§7.3 item 3).
 */
export function paletteFromModel(model: SurfaceModel): PaletteEntry[] {
  return model.events.map((event) => ({
    event: event.event,
    fields: Object.keys(event.payloadSchema?.properties ?? {}).sort(),
  }));
}

/** Every `$op.<field>` reference in a binding template, at any depth. */
function opFields(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    const match = /^\$op\.([A-Za-z0-9_]+)$/.exec(value);
    if (match) into.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) return void value.forEach((entry) => opFields(entry, into));
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) opFields(entry, into);
  }
}

/**
 * The ops this persona binds, derived from ops.json rather than listed by hand
 * — an op the persona does not bind is an op the console must not offer as if
 * it produced traffic. The machine's own description supplies the full
 * vocabulary, so the console can still show the gap.
 */
export function opsFromPersona(persona: Pick<Persona, 'ops' | 'channelFor'>): OpDescriptor[] {
  return Object.entries(persona.ops).map(([op, bindings]) => {
    const fields = new Set<string>();
    for (const binding of bindings) opFields(binding.with, fields);
    return {
      op,
      channels: [...new Set(bindings.map((binding) => persona.channelFor(binding.channel) ?? binding.channel))],
      events: bindings.flatMap((binding) => (binding.event ? [binding.event] : [])),
      fields: [...fields].sort(),
      ...(bindings.some((binding) => binding.await) ? { awaits: true } : {}),
    };
  });
}
