/**
 * Agent Surface Model (ASM) runtime — validate, load, report, diff
 * (draft/EMULATOR.md §2, §7).
 *
 * This module is SELF-CONTAINED by design: no relative imports, erasable
 * syntax only. Adapter-local `.mjs` scripts (audit, registry generation)
 * import it directly as `@vibecook/chopsticks-emulator/model`, which node
 * (≥22.18, type stripping) can execute — node does not remap the repo's
 * `.js`-suffixed relative imports, so anything reachable from those scripts
 * must live in this one file.
 *
 * Truth flows real CLI → captures → model → projections; this module never
 * contacts a vendor binary. `buildReport` reads captures, `loadModel` reads
 * the model, `diffModelVsReport` is the drift equation's left half.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * `confidence` is an open string: the ladder is per-vendor data (claude uses
 * verified-headless/verified-interactive/unverified). This module only
 * distinguishes 'unverified' (never observed) from everything else.
 */
export interface SurfaceEventFile {
  surface: string;
  surfaceVersion: string;
  event: string;
  channel: string;
  transport?: string;
  trigger?: string;
  payloadSchema?: PayloadSchema;
  confidence: string;
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

export interface SurfaceReport {
  capturesDir: string;
  generatedAt: string;
  events: SurfaceReportEvent[];
  /** Non-empty lines that failed JSON.parse — captures should have none. */
  unparsedLines: number;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type DriftKind = 'observed-unmodeled' | 'unobserved-verified' | 'schema-mismatch' | 'unmodeled-field';

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
    if (!(field in record)) violations.push(`missing required field "${field}"`);
  }
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    if (!(field in record) || property.type === undefined) continue;
    const actual = typeOf(record[field]);
    if (actual !== property.type) {
      violations.push(`field "${field}" is ${actual}, expected ${property.type}`);
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

function requireFields(path: string, value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (value[field] === undefined) {
      throw new Error(`ASM: ${path} is missing required field "${field}"`);
    }
  }
}

/** Load a model directory (manifest/detection/channels/events/*.json). Throws on malformed input. */
export function loadModel(dir: string): SurfaceModel {
  const manifestPath = join(dir, 'manifest.json');
  const manifest = readJsonFile(manifestPath) as Record<string, unknown>;
  requireFields(manifestPath, manifest, ['asmVersion', 'vendor', 'vendorVersion', 'generatedAt']);
  if (manifest.asmVersion !== 1) {
    throw new Error(`ASM: ${manifestPath} has unsupported asmVersion ${String(manifest.asmVersion)}`);
  }

  const detection = readJsonFile(join(dir, 'detection.json')) as SurfaceDetection;
  const channels = readJsonFile(join(dir, 'channels.json')) as SurfaceChannels;

  const eventsDir = join(dir, 'events');
  const events: SurfaceEventFile[] = [];
  for (const file of readdirSync(eventsDir)) {
    if (!file.endsWith('.json')) continue;
    const path = join(eventsDir, file);
    const event = readJsonFile(path) as Record<string, unknown>;
    requireFields(path, event, ['surface', 'surfaceVersion', 'event', 'channel', 'confidence']);
    events.push(event as unknown as SurfaceEventFile);
  }
  events.sort((a, b) => a.event.localeCompare(b.event));

  return {
    manifest: manifest as unknown as SurfaceManifest,
    detection,
    channels,
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
 */
export function buildReport(capturesDir: string): SurfaceReport {
  const byEvent = new Map<string, { count: number; fields: Map<string, number> }>();
  let unparsedLines = 0;

  for (const file of collectJsonlFiles(capturesDir)) {
    const fallbackName = file
      .replace(/\\/g, '/')
      .split('/')
      .pop()!
      .replace(/\.jsonl$/, '');
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        unparsedLines += 1;
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        unparsedLines += 1;
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const name = typeof record.hook_event_name === 'string' ? record.hook_event_name : fallbackName;
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

  return { capturesDir, generatedAt: new Date().toISOString(), events, unparsedLines };
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
