/**
 * Persona loading (draft/IMPOSTER.md §3.2).
 *
 * Reads the persona's own documents from `personas/<vendor>/`, then resolves
 * its captured ASM out of the owning adapter package. The ASM is NOT vendored
 * here: it is capture-derived truth and stays adapter-owned (§3.3), so the
 * imposter reads whatever the adapter currently ships and cannot silently
 * drift from it.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validatePayload, type PayloadSchema } from '@vibecook/chopsticks-surface';
import { OP_NAMES, type OpBinding, type OpsDocument, type Persona, type PersonaDocument } from './types.ts';

const PERSONA_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** `personas/` sits beside `dist/` when published and beside `src/` in-repo. */
function personasRoot(): string {
  return join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'personas');
}

export function personaDirectory(vendor: string): string {
  if (!PERSONA_NAME.test(vendor)) {
    throw new Error(`persona name must be lowercase letters, digits, and hyphens (got "${vendor}")`);
  }
  return join(personasRoot(), vendor);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`imposter: cannot read ${path}: ${(error as Error).message}`);
  }
}

function requireRecord(path: string, value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`imposter: ${path} ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(path: string, record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`imposter: ${path} field "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Adapter `exports` lists only `.` and `./package.json`, so the model is
 * reached by resolving the manifest and joining from its directory — deep
 * paths like `<pkg>/surface/model/...` do not resolve (§3.2).
 */
function resolveAsmDirectory(document: PersonaDocument, from: string): string {
  const require = createRequire(from);
  let manifest: string;
  try {
    manifest = require.resolve(`${document.asm.package}/package.json`);
  } catch {
    throw new Error(
      `imposter: persona "${document.vendor}" needs ${document.asm.package}, which is not installed. ` +
        `The ASM stays adapter-owned (IMPOSTER.md §3.3), so the adapter package must be resolvable.`,
    );
  }
  return join(dirname(manifest), document.asm.path);
}

function parsePersonaDocument(path: string, value: unknown): PersonaDocument {
  const record = requireRecord(path, value, 'persona');
  const vendor = requireString(path, record, 'vendor');
  const asm = requireRecord(path, record.asm, 'field "asm"');
  const shimNames = record.shimNames;
  if (
    !Array.isArray(shimNames) ||
    shimNames.length === 0 ||
    shimNames.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    throw new Error(`imposter: ${path} field "shimNames" must be a non-empty array of strings`);
  }
  const boot = record.boot;
  if (!Array.isArray(boot)) throw new Error(`imposter: ${path} field "boot" must be an array`);
  for (const [index, entry] of boot.entries()) {
    const invocation = requireRecord(path, entry, `boot[${index}]`);
    requireString(path, invocation, 'op');
  }
  return {
    vendor,
    asm: { package: requireString(path, asm, 'package'), path: requireString(path, asm, 'path') },
    shimNames: shimNames as string[],
    boot: boot as PersonaDocument['boot'],
  };
}

function parseOpsDocument(path: string, value: unknown, knownEvents: ReadonlySet<string>): OpsDocument {
  const record = requireRecord(path, value, 'ops');
  const ops: OpsDocument = {};
  for (const [op, rawBindings] of Object.entries(record)) {
    if (!(OP_NAMES as readonly string[]).includes(op)) {
      throw new Error(`imposter: ${path} declares unknown op "${op}" (known: ${OP_NAMES.join(', ')})`);
    }
    if (!Array.isArray(rawBindings) || rawBindings.length === 0) {
      throw new Error(`imposter: ${path} op "${op}" must be a non-empty array of bindings`);
    }
    ops[op] = rawBindings.map((rawBinding, index): OpBinding => {
      const binding = requireRecord(path, rawBinding, `op "${op}" binding ${index}`);
      const channel = requireString(path, binding, 'channel');
      if (!['hook', 'transcript', 'statusline', 'jsonrpc'].includes(channel)) {
        throw new Error(`imposter: ${path} op "${op}" has unsupported channel "${channel}"`);
      }
      if (binding.event !== undefined && (typeof binding.event !== 'string' || binding.event.length === 0)) {
        throw new Error(`imposter: ${path} op "${op}" field "event" must be a non-empty string`);
      }
      if (binding.with !== undefined) requireRecord(path, binding.with, `op "${op}" field "with"`);
      // An op bound to a hook event the ASM has never seen would emit an
      // unmodeled payload, which is exactly what §7.3 item 3 forbids.
      if (channel === 'hook' && typeof binding.event === 'string' && !knownEvents.has(binding.event)) {
        throw new Error(`imposter: ${path} op "${op}" binds hook event "${binding.event}", which is not in the ASM`);
      }
      return {
        channel: channel as OpBinding['channel'],
        ...(binding.event === undefined ? {} : { event: binding.event as string }),
        ...(binding.with === undefined ? {} : { with: binding.with as Record<string, unknown> }),
      };
    });
  }
  return ops;
}

export interface LoadPersonaOptions {
  /** Resolution base for the adapter package; defaults to this module. */
  resolveFrom?: string;
  /** Override the persona directory (tests, alternative persona sets). */
  directory?: string;
}

export function loadPersona(vendor: string, options: LoadPersonaOptions = {}): Persona {
  const directory = options.directory ?? personaDirectory(vendor);
  const personaPath = join(directory, 'persona.json');
  const document = parsePersonaDocument(personaPath, readJson(personaPath));
  if (document.vendor !== vendor) {
    throw new Error(`imposter: ${personaPath} declares vendor "${document.vendor}" but lives in "${vendor}"`);
  }

  const model = loadModel(resolveAsmDirectory(document, options.resolveFrom ?? import.meta.url));
  const schemas = new Map<string, PayloadSchema | undefined>(
    model.events.map((event) => [event.event, event.payloadSchema]),
  );

  const opsPath = join(directory, 'ops.json');
  const ops = parseOpsDocument(opsPath, readJson(opsPath), new Set(schemas.keys()));

  const flagTable: Record<string, unknown> = {
    ...(model.detection.launchFlags && typeof model.detection.launchFlags === 'object'
      ? (model.detection.launchFlags as Record<string, unknown>)
      : {}),
    ...(model.detection.probedFlags && typeof model.detection.probedFlags === 'object'
      ? (model.detection.probedFlags as Record<string, unknown>)
      : {}),
  };

  return {
    vendor,
    version: model.manifest.vendorVersion,
    document,
    model,
    ops,
    channels: Object.keys(model.channels.channels),
    schemaFor: (event) => schemas.get(event),
    validate(event, payload) {
      const schema = schemas.get(event);
      return schema ? validatePayload(schema, payload) : [];
    },
    flagsFor(key, fallback) {
      const raw = flagTable[key];
      return (typeof raw === 'string' ? raw : fallback)
        .split(',')
        .map((flag) => flag.trim())
        .filter(Boolean);
    },
  };
}
