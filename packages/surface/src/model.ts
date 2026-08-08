/**
 * Agent Surface Model (ASM) runtime — validate, load, report, diff
 * (draft/EMULATOR.md §2, §7).
 *
 * This module is SELF-CONTAINED by design: no relative imports, erasable
 * syntax only. Adapter-local `.mjs` scripts (audit, registry generation)
 * import it as `@vibecook/chopsticks-surface`, which node (≥22.18, type
 * stripping) can execute — node does not remap the repo's `.js`-suffixed
 * relative imports, so anything reachable from those scripts must live in
 * this one file. It is therefore the package root export, not a barrel.
 *
 * That constraint is why this owns a package rather than living beside the
 * imposter (draft/IMPOSTER.md §7.1): `erasableSyntaxOnly` is set package-wide
 * here, so the compiler enforces it. A package that also carried a TUI could
 * not set that flag, and a relative import added years from now would surface
 * as a baffling `audit.mjs` failure instead of a type error.
 *
 * Truth flows real CLI → captures → model → projections; this module never
 * contacts a vendor binary. `buildReport` reads captures, `loadModel` reads
 * the model, `diffModelVsReport` is the drift equation's left half.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Model documents (draft/EMULATOR.md §2)
// ---------------------------------------------------------------------------

export interface SurfaceManifest {
  asmVersion: 1;
  vendor: string;
  vendorVersion: string;
  generatedAt: string;
  /** Where the captures came from, e.g. "phase-0 + M1 censuses". */
  source?: string;
}

/** Loose carrier — detection data is consumed by adapters, not this module. */
export interface SurfaceDetection {
  executables?: string[];
  envVar?: string;
  versionFlag?: string;
  versionPattern?: string;
  [extra: string]: unknown;
}

export interface SurfaceChannel {
  kind: string;
  [extra: string]: unknown;
}

export interface SurfaceChannels {
  channels: Record<string, SurfaceChannel>;
}

/**
 * JSON-Schema subset (EMULATOR.md §2.2): object/required/properties plus
 * primitive types and enums. Top-level presence and primitive types only —
 * nested shapes are validation overkill for drift detection.
 */
export interface PayloadSchemaProperty {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  enum?: readonly unknown[];
}

export interface PayloadSchema {
  type: 'object';
  required?: string[];
  properties?: Record<string, PayloadSchemaProperty>;
}

/** The cross-vendor evidence ladder defined by the ASM contract. */
export type SurfaceConfidence = 'verified-headless' | 'verified-interactive' | 'unverified';

export interface SurfaceEventFile {
  surface: string;
  surfaceVersion: string;
  event: string;
  channel: string;
  transport?: string;
  trigger?: string;
  payloadSchema?: PayloadSchema;
  confidence: SurfaceConfidence;
  /** Hook timeout written into generated settings (claude registry parity). */
  timeoutSec?: number;
  firstSeen?: string;
  lastVerified?: string;
  fixture?: string;
  notes?: string;
}

export interface SurfaceModel {
  manifest: SurfaceManifest;
  detection: SurfaceDetection;
  channels: SurfaceChannels;
  /** Sorted by event name for deterministic output. */
  events: SurfaceEventFile[];
}

// ---------------------------------------------------------------------------
// Surface report (built from captures)
// ---------------------------------------------------------------------------

export interface SurfaceReportEvent {
  event: string;
  /** Captured lines observed for this event. */
  count: number;
  /** Top-level payload field → number of lines it appeared on. */
  fields: Record<string, number>;
}

export type SurfaceReportIssueKind = 'invalid-json' | 'invalid-envelope' | 'schema-mismatch';

/** A capture defect with a source location, but never the potentially sensitive payload value. */
export interface SurfaceReportIssue {
  kind: SurfaceReportIssueKind;
  file: string;
  line: number;
  event?: string;
  message: string;
}

export interface SurfaceReport {
  capturesDir: string;
  generatedAt: string;
  events: SurfaceReportEvent[];
  /** Non-empty lines that failed JSON.parse — captures should have none. */
  unparsedLines: number;
  /** Parse/envelope/schema defects found while examining every captured line. */
  issues: SurfaceReportIssue[];
  /** Present when payloads were validated while building the report. */
  validatedAgainst?: { vendor: string; vendorVersion: string };
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type DriftKind =
  'invalid-capture' | 'observed-unmodeled' | 'unobserved-verified' | 'schema-mismatch' | 'unmodeled-field';

export interface DriftEntry {
  kind: DriftKind;
  event: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate a captured payload against the subset schema. Returns violation
 * strings (empty = valid). Required-ness and top-level primitive types only.
 */
export function validatePayload(schema: PayloadSchema, payload: unknown): string[] {
  const violations: string[] = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return [`payload is ${typeOf(payload)}, expected object`];
  }
  const record = payload as Record<string, unknown>;
  for (const field of schema.required ?? []) {
    if (!Object.hasOwn(record, field)) violations.push(`missing required field "${field}"`);
  }
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(record, field)) continue;
    if (property.type !== undefined) {
      const actual = typeOf(record[field]);
      if (actual !== property.type) {
        violations.push(`field "${field}" is ${actual}, expected ${property.type}`);
      }
    }
    if (property.enum !== undefined && !property.enum.includes(record[field])) {
      violations.push(`field "${field}" value not in enum`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`ASM: cannot parse ${path}: ${(error as Error).message}`);
  }
  return parsed;
}

function requireObject(path: string, value: unknown, what = 'document'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`ASM: ${path} ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireFields(path: string, value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (value[field] === undefined) {
      throw new Error(`ASM: ${path} is missing required field "${field}"`);
    }
  }
}

function requireString(path: string, value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`ASM: ${path} field "${field}" must be a non-empty string`);
  }
  return candidate;
}

function validateStringArray(path: string, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`ASM: ${path} field "${field}" must be an array of non-empty strings`);
  }
  return value as string[];
}

const payloadTypes = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);

function validatePayloadSchema(path: string, value: unknown): PayloadSchema {
  const schema = requireObject(path, value, 'payloadSchema');
  if (schema.type !== 'object') throw new Error(`ASM: ${path} payloadSchema.type must be "object"`);

  const required =
    schema.required === undefined ? [] : validateStringArray(path, schema.required, 'payloadSchema.required');
  if (new Set(required).size !== required.length) {
    throw new Error(`ASM: ${path} payloadSchema.required contains duplicate fields`);
  }

  const properties =
    schema.properties === undefined ? {} : requireObject(path, schema.properties, 'payloadSchema.properties');
  for (const [field, rawProperty] of Object.entries(properties)) {
    const property = requireObject(path, rawProperty, `payloadSchema property "${field}"`);
    if (property.type !== undefined && (typeof property.type !== 'string' || !payloadTypes.has(property.type))) {
      throw new Error(`ASM: ${path} payloadSchema property "${field}" has unsupported type`);
    }
    if (property.enum !== undefined) {
      if (!Array.isArray(property.enum) || property.enum.length === 0) {
        throw new Error(`ASM: ${path} payloadSchema property "${field}" enum must be a non-empty array`);
      }
      if (property.type !== undefined && property.enum.some((entry) => typeOf(entry) !== property.type)) {
        throw new Error(`ASM: ${path} payloadSchema property "${field}" enum value has the wrong type`);
      }
    }
  }
  for (const field of required) {
    if (!Object.hasOwn(properties, field)) {
      throw new Error(`ASM: ${path} required payload field "${field}" is absent from properties`);
    }
  }
  return schema as unknown as PayloadSchema;
}

/** Load a model directory (manifest/detection/channels/events/*.json). Throws on malformed input. */
/**
 * Event documents, with the event name each one must declare.
 *
 * The tree mirrors the vendor's own namespace: `events/thread/started.json` is
 * `thread/started`. Flat vendors are the degenerate case, so claude's
 * `events/Stop.json` is unaffected. This exists because JSON-RPC families name
 * their methods with `/` — `item/commandExecution/requestApproval` cannot be a
 * filename, and encoding the slash away would put a name in the model that the
 * vendor never uses.
 */
function eventDocumentFiles(dir: string, prefix = ''): Array<{ path: string; name: string }> {
  const found: Array<{ path: string; name: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...eventDocumentFiles(path, `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.json')) found.push({ path, name: `${prefix}${basename(entry.name, '.json')}` });
  }
  return found;
}

export function loadModel(dir: string): SurfaceModel {
  const manifestPath = join(dir, 'manifest.json');
  const manifest = requireObject(manifestPath, readJsonFile(manifestPath));
  requireFields(manifestPath, manifest, ['asmVersion', 'vendor', 'vendorVersion', 'generatedAt']);
  if (manifest.asmVersion !== 1) {
    throw new Error(`ASM: ${manifestPath} has unsupported asmVersion ${String(manifest.asmVersion)}`);
  }
  const vendor = requireString(manifestPath, manifest, 'vendor');
  const vendorVersion = requireString(manifestPath, manifest, 'vendorVersion');
  const generatedAt = requireString(manifestPath, manifest, 'generatedAt');
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error(`ASM: ${manifestPath} field "generatedAt" must be an ISO date or timestamp`);
  }

  const detectionPath = join(dir, 'detection.json');
  const detection = requireObject(detectionPath, readJsonFile(detectionPath));
  if (detection.executables !== undefined) validateStringArray(detectionPath, detection.executables, 'executables');
  for (const field of ['envVar', 'versionFlag', 'versionPattern', 'helpFlag', 'versionOutput'] as const) {
    if (detection[field] !== undefined && (typeof detection[field] !== 'string' || detection[field].length === 0)) {
      throw new Error(`ASM: ${detectionPath} field "${field}" must be a non-empty string`);
    }
  }
  for (const field of ['probedFlags', 'launchFlags'] as const) {
    if (detection[field] === undefined) continue;
    const flags = requireObject(detectionPath, detection[field], `field "${field}"`);
    for (const [name, flag] of Object.entries(flags)) {
      if (typeof flag !== 'string' || flag.length === 0) {
        throw new Error(`ASM: ${detectionPath} ${field}.${name} must be a non-empty string`);
      }
    }
  }
  if (typeof detection.versionPattern === 'string') {
    try {
      new RegExp(detection.versionPattern);
    } catch {
      throw new Error(`ASM: ${detectionPath} field "versionPattern" must be a valid regular expression`);
    }
  }

  const channelsPath = join(dir, 'channels.json');
  const channelsDocument = requireObject(channelsPath, readJsonFile(channelsPath));
  const channelRecords = requireObject(channelsPath, channelsDocument.channels, 'field "channels"');
  if (Object.keys(channelRecords).length === 0)
    throw new Error(`ASM: ${channelsPath} must declare at least one channel`);
  for (const [name, rawChannel] of Object.entries(channelRecords)) {
    const channel = requireObject(channelsPath, rawChannel, `channel "${name}"`);
    requireString(channelsPath, channel, 'kind');
  }

  const eventsDir = join(dir, 'events');
  const events: SurfaceEventFile[] = [];
  const eventNames = new Set<string>();
  for (const { path, name } of eventDocumentFiles(eventsDir)) {
    const event = requireObject(path, readJsonFile(path));
    requireFields(path, event, ['surface', 'surfaceVersion', 'event', 'channel', 'confidence']);
    const surface = requireString(path, event, 'surface');
    const surfaceVersion = requireString(path, event, 'surfaceVersion');
    const eventName = requireString(path, event, 'event');
    const channel = requireString(path, event, 'channel');
    const confidence = requireString(path, event, 'confidence');
    if (surface !== vendor || surfaceVersion !== vendorVersion) {
      throw new Error(`ASM: ${path} surface identity does not match manifest ${vendor}@${vendorVersion}`);
    }
    if (name !== eventName) {
      throw new Error(`ASM: ${path} path does not match event "${eventName}"`);
    }
    if (eventNames.has(eventName)) throw new Error(`ASM: duplicate event "${eventName}"`);
    eventNames.add(eventName);
    if (!Object.hasOwn(channelRecords, channel)) {
      throw new Error(`ASM: ${path} references unknown channel "${channel}"`);
    }
    if (!['verified-headless', 'verified-interactive', 'unverified'].includes(confidence)) {
      throw new Error(`ASM: ${path} confidence must be verified-headless|verified-interactive|unverified`);
    }
    for (const field of ['transport', 'trigger', 'firstSeen', 'lastVerified', 'fixture', 'notes'] as const) {
      if (event[field] !== undefined && (typeof event[field] !== 'string' || event[field].length === 0)) {
        throw new Error(`ASM: ${path} field "${field}" must be a non-empty string`);
      }
    }
    if (event.payloadSchema !== undefined) event.payloadSchema = validatePayloadSchema(path, event.payloadSchema);
    if (event.timeoutSec !== undefined && (typeof event.timeoutSec !== 'number' || event.timeoutSec <= 0)) {
      throw new Error(`ASM: ${path} timeoutSec must be a positive number`);
    }
    if (confidence !== 'unverified' && (!event.fixture || !event.firstSeen || !event.lastVerified)) {
      throw new Error(`ASM: ${path} verified event must cite fixture, firstSeen, and lastVerified`);
    }
    events.push(event as unknown as SurfaceEventFile);
  }
  if (events.length === 0) throw new Error(`ASM: ${eventsDir} contains no event documents`);
  events.sort((a, b) => a.event.localeCompare(b.event));

  return {
    manifest: manifest as unknown as SurfaceManifest,
    detection: detection as SurfaceDetection,
    channels: channelsDocument as unknown as SurfaceChannels,
    events,
  };
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function collectJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectJsonlFiles(path));
    } else if (entry.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Build a surface report from a captures directory (recursive, so per-run
 * subdirectories like headless/ + interactive/ all count). The event name is
 * each line's `hook_event_name`, falling back to the file basename.
 *
 * Pass the model to validate every parsed payload while it is in memory. The
 * resulting report retains only source locations and violation descriptions,
 * never captured values. Audits should always pass the model.
 */
export function buildReport(capturesDir: string, model?: SurfaceModel): SurfaceReport {
  const byEvent = new Map<string, { count: number; fields: Map<string, number> }>();
  const modeled = new Map(model?.events.map((event) => [event.event, event]) ?? []);
  const issues: SurfaceReportIssue[] = [];
  let unparsedLines = 0;

  for (const file of collectJsonlFiles(capturesDir)) {
    const fallbackName = file
      .replace(/\\/g, '/')
      .split('/')
      .pop()!
      .replace(/\.jsonl$/, '');
    let lineNumber = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        unparsedLines += 1;
        issues.push({
          kind: 'invalid-json',
          file: relative(capturesDir, file),
          line: lineNumber,
          message: `invalid JSON: ${(error as Error).message}`,
        });
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        unparsedLines += 1;
        issues.push({
          kind: 'invalid-envelope',
          file: relative(capturesDir, file),
          line: lineNumber,
          message: `capture payload is ${typeOf(parsed)}, expected object`,
        });
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (
        Object.hasOwn(record, 'hook_event_name') &&
        (typeof record.hook_event_name !== 'string' || record.hook_event_name.length === 0)
      ) {
        issues.push({
          kind: 'invalid-envelope',
          file: relative(capturesDir, file),
          line: lineNumber,
          message: 'hook_event_name must be a non-empty string when present',
        });
      }
      const name =
        typeof record.hook_event_name === 'string' && record.hook_event_name.length > 0
          ? record.hook_event_name
          : fallbackName;
      if (name !== fallbackName) {
        issues.push({
          kind: 'invalid-envelope',
          file: relative(capturesDir, file),
          line: lineNumber,
          event: name,
          message: `hook_event_name does not match fixture filename "${fallbackName}"`,
        });
      }
      const schema = modeled.get(name)?.payloadSchema;
      if (schema) {
        for (const violation of validatePayload(schema, record)) {
          issues.push({
            kind: 'schema-mismatch',
            file: relative(capturesDir, file),
            line: lineNumber,
            event: name,
            message: violation,
          });
        }
      }
      let entry = byEvent.get(name);
      if (!entry) {
        entry = { count: 0, fields: new Map() };
        byEvent.set(name, entry);
      }
      entry.count += 1;
      for (const field of Object.keys(record)) {
        entry.fields.set(field, (entry.fields.get(field) ?? 0) + 1);
      }
    }
  }

  const events: SurfaceReportEvent[] = [...byEvent.entries()]
    .map(([event, entry]) => ({
      event,
      count: entry.count,
      fields: Object.fromEntries([...entry.fields.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));

  return {
    capturesDir,
    generatedAt: new Date().toISOString(),
    events,
    unparsedLines,
    issues,
    ...(model
      ? { validatedAgainst: { vendor: model.manifest.vendor, vendorVersion: model.manifest.vendorVersion } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Diff — the drift equation (EMULATOR.md §7)
// ---------------------------------------------------------------------------

/**
 * Diff a model against a captures report. A clean result (no entries) means
 * the model exactly covers the captures. Drift kinds:
 * - observed-unmodeled: captures contain an event the model doesn't know
 * - unobserved-verified: a non-'unverified' model event never appears in captures
 * - schema-mismatch: a model-required field is missing from some captured lines
 * - unmodeled-field: captures carry a top-level field the schema doesn't list
 */
export function diffModelVsReport(model: SurfaceModel, report: SurfaceReport): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const modeled = new Map(model.events.map((event) => [event.event, event]));
  const observed = new Map(report.events.map((event) => [event.event, event]));

  if (
    report.validatedAgainst &&
    (report.validatedAgainst.vendor !== model.manifest.vendor ||
      report.validatedAgainst.vendorVersion !== model.manifest.vendorVersion)
  ) {
    drift.push({
      kind: 'invalid-capture',
      event: '(captures)',
      message:
        `report was validated against ${report.validatedAgainst.vendor}@${report.validatedAgainst.vendorVersion}, ` +
        `not ${model.manifest.vendor}@${model.manifest.vendorVersion}`,
    });
  }

  const issueCounts = new Map<string, { issue: SurfaceReportIssue; count: number }>();
  for (const issue of report.issues ?? []) {
    const key = `${issue.kind}\0${issue.event ?? ''}\0${issue.message}`;
    const existing = issueCounts.get(key);
    if (existing) existing.count += 1;
    else issueCounts.set(key, { issue, count: 1 });
  }
  if (
    report.unparsedLines > 0 &&
    !(report.issues ?? []).some((issue) => issue.kind === 'invalid-json' || issue.kind === 'invalid-envelope')
  ) {
    drift.push({
      kind: 'invalid-capture',
      event: '(captures)',
      message: `${report.unparsedLines} capture line(s) could not be parsed as JSON objects`,
    });
  }
  for (const { issue, count } of issueCounts.values()) {
    drift.push({
      kind: issue.kind === 'schema-mismatch' ? 'schema-mismatch' : 'invalid-capture',
      event: issue.event ?? '(captures)',
      message: `${issue.message} (${count} occurrence${count === 1 ? '' : 's'}; first at ${issue.file}:${issue.line})`,
    });
  }

  for (const reportEvent of report.events) {
    if (!modeled.has(reportEvent.event)) {
      drift.push({
        kind: 'observed-unmodeled',
        event: reportEvent.event,
        message: `captures contain ${reportEvent.count} line(s) of unmodeled event "${reportEvent.event}"`,
      });
    }
  }

  for (const modelEvent of model.events) {
    const reportEvent = observed.get(modelEvent.event);
    if (!reportEvent) {
      if (modelEvent.confidence !== 'unverified') {
        drift.push({
          kind: 'unobserved-verified',
          event: modelEvent.event,
          message: `model event "${modelEvent.event}" (confidence ${modelEvent.confidence}) has no captures`,
        });
      }
      continue;
    }
    const schema = modelEvent.payloadSchema;
    if (!schema) continue;
    // Reports built without a model retain the legacy presence audit. A
    // model-validated report already contains line-specific violations above.
    if (!report.validatedAgainst) {
      for (const field of schema.required ?? []) {
        const present = reportEvent.fields[field] ?? 0;
        if (present < reportEvent.count) {
          drift.push({
            kind: 'schema-mismatch',
            event: modelEvent.event,
            message: `required field "${field}" present on ${present}/${reportEvent.count} captured line(s)`,
          });
        }
      }
    }
    const properties = schema.properties ?? {};
    for (const field of Object.keys(reportEvent.fields)) {
      if (!(field in properties)) {
        drift.push({
          kind: 'unmodeled-field',
          event: modelEvent.event,
          message: `captured field "${field}" is not in the model's payloadSchema.properties`,
        });
      }
    }
  }

  return drift;
}
