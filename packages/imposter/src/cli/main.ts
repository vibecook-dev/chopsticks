/**
 * The `ai` entry point (draft/IMPOSTER.md §6).
 *
 * Answers the vendor's detection surface from the ASM (`--version`, `--help`),
 * then brings up a session on the vendor's real channels. The TUI is not here:
 * presentation is a sink the session writes frames to, and until phase I4 that
 * sink is a plain append-only stdout log. Headless is not a fallback — CI runs
 * it (§4.2).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPersona, personaDirectory, shimNameMap } from '../persona/load.ts';
import type { Persona } from '../persona/types.ts';
import { createPasteDecoder } from '../session/channels/terminal.ts';
import { createImposterSession, type BehaviorDocument } from '../session/session.ts';
import type { PresentationFrame } from '../session/timeline.ts';
import { flagValue, hasFlag, PersonaSelectionError, selectPersona } from './argv.ts';

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/i;

function safeName(name: string, what: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`${what} must contain only letters, numbers, and hyphens`);
  return name;
}

function loadBehavior(persona: Persona, name: string): BehaviorDocument {
  const path = join(personaDirectory(persona.vendor), 'behavior', `${safeName(name, 'behavior name')}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as BehaviorDocument;
}

function detectionText(persona: Persona, field: string, fallback: string): string {
  const value = persona.model.detection[field];
  return typeof value === 'string' ? value : fallback;
}

/** One-line human rendering of an op. Cosmetic only — never parsed back. */
function renderFrame(frame: PresentationFrame): string {
  const at = frame.at.slice(11, 23);
  const detail = frame.with.text ?? frame.with.tool ?? frame.with.reason ?? '';
  return `${at}  ${frame.op}${detail ? `  ${JSON.stringify(detail)}` : ''}`;
}

export async function main(argv: readonly string[], argv0?: string): Promise<number> {
  const shims = shimNameMap();
  let selection;
  try {
    selection = selectPersona(argv, { argv0, env: process.env, shims });
  } catch (error) {
    if (error instanceof PersonaSelectionError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const persona = loadPersona(selection.vendor);
  const rest = selection.rest;

  // Detection surface, answered from the ASM so it cannot drift from what the
  // adapter's probe expects (ADAPTING-AN-AGENT step 4).
  const versionFlag = detectionText(persona, 'versionFlag', '--version');
  const helpFlag = detectionText(persona, 'helpFlag', '--help');
  if (hasFlag(rest, versionFlag)) {
    process.stdout.write(`${detectionText(persona, 'versionOutput', `${persona.version} (imposter)`)}\n`);
    return 0;
  }
  if (hasFlag(rest, helpFlag)) {
    const flags = ['sessionId', 'resume', 'settings', 'name', 'permissionMode', 'model'] as const;
    process.stdout.write(`Usage: ${persona.vendor} [options]\n`);
    for (const key of flags) {
      const aliases = persona.flagsFor(key, '');
      if (aliases.length > 0) process.stdout.write(`  ${aliases.join(', ')} <value>\n`);
    }
    return 0;
  }

  const behaviorName = flagValue(rest, ['--behavior']) ?? 'happy-turn';
  const session = createImposterSession({
    persona,
    argv: rest,
    env: process.env,
    cwd: process.cwd(),
    behavior: loadBehavior(persona, behaviorName),
    present: (frame) => process.stdout.write(`${renderFrame(frame)}\r\n`),
    log: (message) => {
      if (process.env.CHOPSTICKS_IMPOSTER_DEBUG) process.stderr.write(`[imposter] ${message}\n`);
    },
  });

  process.stdout.write(
    `IMPOSTER · ${persona.vendor} ${persona.version} · ${session.sessionId} · ${session.liveChannels.join(' ')}\r\n`,
  );
  await session.boot();

  let closing = false;
  const shutdown = async (): Promise<never> => {
    if (closing) await new Promise(() => {});
    closing = true;
    await session.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  // The adapter injects prompts as a guarded bracketed paste; the decoder is
  // shared with the (future) TUI so there is only ever one input path (§4.1.1).
  const decoder = createPasteDecoder((operation) => {
    if (!operation.submit) {
      process.stdout.write(`\r\n[staged] ${operation.text}\r\n`);
      return;
    }
    void session.turn(operation.text).catch((error: unknown) => {
      process.stderr.write(`[imposter] turn failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => decoder.feed(chunk));
  process.stdin.on('end', () => {
    decoder.flush();
    void shutdown();
  });

  // Hold the process open; the session ends on signal or stdin EOF.
  await new Promise(() => {});
  return 0;
}

// No auto-run on import: `bin/ai.mjs` owns invocation, so tests can import
// `main` without a module-load side effect spawning a session.
