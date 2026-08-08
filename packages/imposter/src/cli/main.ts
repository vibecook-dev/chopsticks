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
import { connectControl, type ImposterControl } from '../control/client.ts';
import { ControlError, NOT_FOUND, paletteFromModel } from '../control/protocol.ts';
import { loadPersona, personaDirectory, shimNameMap } from '../persona/load.ts';
import type { Persona } from '../persona/types.ts';
import { createAppServerChannel, type AppServerChannel } from '../session/channels/jsonrpc.ts';
import { createPasteDecoder } from '../session/channels/terminal.ts';
import { createServeDispatcher } from '../session/serve.ts';
import { createImposterSession, type BehaviorDocument } from '../session/session.ts';
import { createPresentation, type Presentation } from '../tui/mount.ts';
import { flagValue, hasFlag, PersonaSelectionError, selectPersona, shimIdentity } from './argv.ts';
import { runShimsCommand } from './shims.ts';

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/i;

function safeName(name: string, what: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`${what} must contain only letters, numbers, and hyphens`);
  return name;
}

function loadBehavior(persona: Persona, name: string): BehaviorDocument {
  const path = join(personaDirectory(persona.vendor), 'behavior', `${safeName(name, 'behavior name')}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as BehaviorDocument;
}

/** Named scenarios are persona-owned data; the control channel addresses them by name. */
function loadScenario(persona: Persona, name: string): unknown {
  const path = join(personaDirectory(persona.vendor), 'scenarios', `${safeName(name, 'scenario name')}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ControlError(NOT_FOUND, `no scenario named ${name}`);
    }
    throw error;
  }
}

function detectionText(persona: Persona, field: string, fallback: string): string {
  const value = persona.model.detection[field];
  return typeof value === 'string' ? value : fallback;
}

export async function main(argv: readonly string[], argv0?: string): Promise<number> {
  const shims = shimNameMap();

  // `shims` is the tool's own subcommand, so it is only reachable when the
  // tool was invoked by its own name. Through an installed shim every argument
  // belongs to the vendor, and a vendor is free to have a `shims` command of
  // its own.
  if (argv[0] === 'shims' && !shims.has(shimIdentity(argv0 ?? ''))) {
    return runShimsCommand(argv.slice(1));
  }

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
  const log = (message: string): void => {
    if (process.env.CHOPSTICKS_IMPOSTER_DEBUG) process.stderr.write(`[imposter] ${message}\n`);
  };

  // `control` and `screen` are assigned below, after the session exists; the
  // callbacks close over them and stay inert until then. Nothing is emitted
  // before boot, which is after both.
  let control: ImposterControl | undefined;
  let screen: Presentation | undefined;
  let closing = false;

  // The trigger fork (§9.3). For claude the trigger is stdin bytes; for codex
  // it is inbound RPC. Everything downstream — the op timeline and its sinks —
  // is genuinely shared, which is the whole claim the two families test.
  const serving = persona.serve !== undefined;
  let appServer: AppServerChannel | undefined;

  const session = createImposterSession({
    persona,
    argv: rest,
    env: process.env,
    cwd: process.cwd(),
    behavior: loadBehavior(persona, behaviorName),
    present: (frame) => screen?.frame(frame),
    ...(serving
      ? {
          jsonrpc: {
            notify: (method: string, params: Record<string, unknown>) => appServer?.notify(method, params),
            request: (method: string, params: Record<string, unknown>) =>
              appServer
                ? appServer.request(method, params)
                : Promise.reject(new Error('app-server channel is not open')),
          },
        }
      : {}),
    onEmitted: (entry) => control?.pushEmitted(entry),
    onChannels: (channels) => {
      control?.pushChannels(channels);
      screen?.channels(channels);
    },
    halt: (kind, exitCode) => {
      if (kind === 'hang') {
        process.stdin.pause();
        return;
      }
      // setImmediate so the control reply flushes first. A crash sends no
      // goodbye on purpose: a vendor that dies does not say goodbye, and the
      // plane is meant to learn it from the socket closing (§5).
      setImmediate(() => {
        if (kind === 'crash') process.exit(exitCode);
        else void shutdown(exitCode);
      });
    },
    log,
  });

  const shutdown = async (exitCode = 0): Promise<never> => {
    if (closing) await new Promise(() => {});
    closing = true;
    await session.end();
    await control?.close('other');
    await screen?.stop();
    process.exit(exitCode);
  };

  // The TUI is chrome and nothing more (§4): it renders the same lines the
  // headless sink writes, and never reads input.
  //
  // When the persona SERVES, stdout is the protocol — a banner written there
  // would sit in the middle of the adapter's NDJSON stream. So presentation
  // goes to stderr and the TUI never mounts, whatever the terminal looks like.
  screen = await createPresentation({
    vendor: persona.vendor,
    version: persona.version,
    sessionId: session.sessionId,
    channels: session.liveChannels,
    ...(serving ? { interactive: false, write: (text: string) => void process.stderr.write(text) } : {}),
  });

  // Joining the control plane MUST complete before the stdin listeners attach:
  // under ELECTRON_RUN_AS_NODE (how apps spawn script recipes) a flowing stdin
  // wedges later async I/O initiation, and the connect never resolves — probed
  // 2026-08-07 against the PoC's register fetch (§7.3 item 1).
  control = await connectControl({
    vendor: persona.vendor,
    version: persona.version,
    sessionId: session.sessionId,
    cwd: process.cwd(),
    palette: paletteFromModel(persona.model),
    channels: () => session.liveChannels,
    emitted: () => session.emitted,
    trigger: (event, payload) => session.emit(event, payload),
    runScenario: (request) =>
      session.runScenario(request.script ?? loadScenario(persona, request.name!), {
        ...(request.stimulus === undefined ? {} : { stimulus: request.stimulus }),
        speed: request.speed,
        mode: request.mode,
      }),
    scenarioControl: (action) => session.scenarioControl(action),
    fault: (request) => session.applyFault(request),
    log,
  });

  await session.boot();

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  if (serving) {
    // The JSON-RPC family's trigger: inbound RPC, answered synchronously, with
    // any resulting ops scheduled onto the SAME timeline the paste path uses.
    const dispatcher = createServeDispatcher({
      persona,
      document: persona.serve!,
      bindings: session.bindings,
      runOps: (invocations) => session.timeline.runAll(invocations),
      runBehavior: (stimulus) => session.turn(typeof stimulus.text === 'string' ? stimulus.text : ''),
      // Inbound params are held to the ASM exactly like outbound payloads, so
      // the imposter is a conformance test of the adapter's client (§9.3).
      validateParams: (method, params) => persona.validate(method, params),
      log,
    });
    appServer = createAppServerChannel({
      input: process.stdin,
      output: process.stdout,
      serve: dispatcher.serve,
      notified: dispatcher.notified,
      onClose: () => void shutdown(),
      log,
    });
    await new Promise(() => {});
    return 0;
  }

  // The adapter injects prompts as a guarded bracketed paste. This is the ONLY
  // input path: the TUI does not read stdin, so TTY and pipe modes cannot drift
  // apart in the most load-bearing place there is (§4.1.1).
  const decoder = createPasteDecoder((operation) => {
    if (!operation.submit) {
      screen?.staged(operation.text);
      return;
    }
    screen?.staged('');
    void session.turn(operation.text).catch((error: unknown) => {
      screen?.notice(`turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  // A real terminal needs raw mode so a bracketed paste arrives as bytes rather
  // than line-buffered input. Raw mode also stops the kernel turning ^C into
  // SIGINT, so the interrupt is handled here as a byte — which is what the
  // vendor's own TUI does. Only a lone \x03 is a keypress; a larger chunk
  // containing it is paste payload.
  if (screen.interactive && process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (screen.interactive && chunk === '\x03') return void shutdown();
    decoder.feed(chunk);
  });
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
