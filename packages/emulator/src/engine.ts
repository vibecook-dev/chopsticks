/**
 * Vendor-neutral L1 emulator engine (draft/EMULATOR.md §3–§5): the channel
 * simulators and scenario runner an adapter's `surface/emulator/bin.mjs`
 * wires into a vendor stand-in.
 *
 * SELF-CONTAINED like model.ts (no relative runtime imports): bins are `.mjs`
 * executed under node type stripping, which does not remap `.js`-suffixed
 * relative imports. ASM validation is injected (`validate` option) rather than
 * imported, so this module stays dependency-free.
 *
 * Delivery failures are logged, never thrown: a hook the bridge rejects (or a
 * forwarder that can't spawn) must not kill the emulated process — the real
 * vendor's hooks fail the same soft way.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Bracketed paste decoder (terminal channel)
// ---------------------------------------------------------------------------

export interface PasteOperation {
  text: string;
  /** True when the paste was followed by Enter (`\r`). */
  submit: boolean;
}

export interface PasteDecoder {
  feed(chunk: string | Buffer): void;
  /** Emit any held paste as unsubmitted (stream ending). */
  flush(): void;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Splits a stdin byte stream into paste operations and plain input. A submit
 * (`\r`) may arrive in a later chunk than the paste close marker, so a
 * completed paste is held briefly for it; `flush` (or the hold timer) emits
 * it as paste-only.
 */
export function createPasteDecoder(
  onPaste: (operation: PasteOperation) => void,
  onInput?: (text: string) => void,
  holdMs = 15,
): PasteDecoder {
  let buffer = '';
  let inPaste = false;
  let held: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const releaseHeld = (submit: boolean): void => {
    if (held === undefined) return;
    const text = held;
    held = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    onPaste({ text, submit });
  };
  const holdForSubmit = (): void => {
    timer = setTimeout(() => releaseHeld(false), holdMs);
  };
  /** Longest suffix of `buffer` that could grow into the paste start marker. */
  const partialStart = (): number => {
    for (let length = Math.min(buffer.length, PASTE_START.length - 1); length > 0; length -= 1) {
      if (PASTE_START.startsWith(buffer.slice(-length))) return length;
    }
    return 0;
  };

  return {
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (;;) {
        if (held !== undefined) {
          if (buffer.length === 0) return;
          if (buffer.startsWith('\r')) {
            buffer = buffer.slice(1);
            releaseHeld(true);
          } else {
            releaseHeld(false);
          }
          continue;
        }
        if (!inPaste) {
          const start = buffer.indexOf(PASTE_START);
          if (start < 0) {
            const keep = partialStart();
            const plain = buffer.slice(0, buffer.length - keep);
            if (plain && onInput) onInput(plain);
            buffer = buffer.slice(buffer.length - keep);
            return;
          }
          if (start > 0 && onInput) onInput(buffer.slice(0, start));
          buffer = buffer.slice(start + PASTE_START.length);
          inPaste = true;
          continue;
        }
        const end = buffer.indexOf(PASTE_END);
        if (end < 0) return; // mid-paste; keep accumulating
        inPaste = false;
        held = buffer.slice(0, end);
        buffer = buffer.slice(end + PASTE_END.length);
        if (buffer.startsWith('\r')) {
          buffer = buffer.slice(1);
          releaseHeld(true);
        } else if (buffer.length > 0) {
          releaseHeld(false);
        } else {
          holdForSubmit();
          return;
        }
      }
    },
    flush() {
      releaseHeld(false);
    },
  };
}

// ---------------------------------------------------------------------------
// Hook emitter (hook channel: http + command transports)
// ---------------------------------------------------------------------------

export interface EmulatorHookSettings {
  hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
}

export interface HookEmitterOptions {
  /** Parsed claude-shape settings (the generated hooks file). */
  settings: EmulatorHookSettings;
  /** Process env used to resolve `$VAR` header references. */
  env: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export interface HookEmitter {
  /** Deliver one event; resolves when the handler(s) acknowledge. Drops unwired events. */
  emit(event: string, payload: Record<string, unknown>): Promise<void>;
}

/** Resolve `Bearer $VAR`-style header values against the granted env. */
function resolveEnvRefs(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, name: string) => env[name] ?? match);
}

/**
 * The repo's own generated curl forwarder (settings.ts `curlForwarder`) is
 * recognized by shape and delivered as a direct POST with identical headers
 * and body. The observable contract at the bridge is byte-identical, but the
 * shortcut works where `sh` is absent (Windows dev machines); unrecognized
 * command handlers still run through `sh -c` with the payload on stdin.
 */
const FORWARDER_SHAPE =
  /curl -s -m (\d+) -X POST -H "Content-Type: application\/json" -H "Authorization: Bearer \$([A-Z_][A-Z0-9_]*)" --data-binary @- ([^\s']+)/;

async function deliver(
  handler: Record<string, unknown>,
  payload: Record<string, unknown>,
  env: Record<string, string | undefined>,
  log: (message: string) => void,
): Promise<void> {
  const body = JSON.stringify(payload);
  if (handler.type === 'http') {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const [name, value] of Object.entries((handler.headers as Record<string, string>) ?? {})) {
      headers[name] = resolveEnvRefs(value, env);
    }
    const timeoutSec = typeof handler.timeout === 'number' ? handler.timeout : 5;
    const res = await fetch(String(handler.url), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (res.status !== 200) log(`hook POST -> ${res.status}`);
    return;
  }
  if (handler.type === 'command' && typeof handler.command === 'string') {
    const forwarder = handler.command.match(FORWARDER_SHAPE);
    if (forwarder) {
      const [, , tokenVar, url] = forwarder;
      const res = await fetch(url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env[tokenVar!] ?? ''}` },
        body,
        signal: AbortSignal.timeout(Number(forwarder[1]) * 1000),
      });
      if (res.status !== 200) log(`forwarded hook POST -> ${res.status}`);
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn('sh', ['-c', handler.command as string], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', (error) => {
        log(`command hook failed to spawn: ${error.message}`);
        resolve();
      });
      child.on('close', () => resolve());
      child.stdin.write(body, () => child.stdin.end());
    });
  }
}

export function createHookEmitter(options: HookEmitterOptions): HookEmitter {
  const log = options.log ?? (() => {});
  // Hooks fire 1:1 with their cause and the bridge treats arrival order as
  // meaningful, so emissions are serialized on a promise chain.
  let queue = Promise.resolve();
  return {
    emit(event, payload) {
      const matchers = options.settings.hooks?.[event] ?? [];
      const handlers = matchers.flatMap((matcher) => matcher.hooks ?? []);
      if (handlers.length === 0) {
        log(`dropped unwired event ${event}`);
        return Promise.resolve();
      }
      const full = { ...payload, hook_event_name: event };
      queue = queue.then(() =>
        Promise.all(
          handlers.map((handler) =>
            deliver(handler, full, options.env, log).catch((error: unknown) => {
              log(`hook ${event} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
            }),
          ),
        ).then(() => undefined),
      );
      return queue;
    },
  };
}

// ---------------------------------------------------------------------------
// Transcript writer (transcript channel)
// ---------------------------------------------------------------------------

export interface TranscriptWriter {
  readonly path: string;
  append(record: Record<string, unknown>): void;
  /** Write a line fragment with no trailing newline — the crash-mid-write shape. */
  appendPartial(fragment: string): void;
}

export function createTranscriptWriter(path: string): TranscriptWriter {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '');
  return {
    path,
    append(record) {
      appendFileSync(path, JSON.stringify(record) + '\n');
    },
    appendPartial(fragment) {
      appendFileSync(path, fragment);
    },
  };
}

// ---------------------------------------------------------------------------
// Statusline invoker (statusline channel)
// ---------------------------------------------------------------------------

export interface StatusLineInvoker {
  /** Feed one session-status JSON payload to the configured command's stdin. */
  invoke(payload: Record<string, unknown>): Promise<void>;
}

/**
 * Invokes the settings' `statusLine` command exactly as configured — for the
 * chopsticks recipe that is the adapter's own forwarder script, so the real
 * forwarder → bridge path is exercised end to end. Cadence is the caller's
 * choice (the vendor's refresh timing is a behavior-pack concern).
 */
export function createStatusLineInvoker(
  config: unknown,
  options: { log?: (message: string) => void } = {},
): StatusLineInvoker | undefined {
  const log = options.log ?? (() => {});
  const command =
    config !== null && typeof config === 'object' ? (config as Record<string, unknown>).command : undefined;
  if (typeof command !== 'string' || command.length === 0) return undefined;
  return {
    invoke(payload) {
      return new Promise<void>((resolve) => {
        const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', (error) => {
          log(`statusline command failed to spawn: ${error.message}`);
          resolve();
        });
        child.on('close', () => resolve());
        child.stdin.write(JSON.stringify(payload), () => child.stdin.end());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario runner (behavior rules + timelines)
// ---------------------------------------------------------------------------

export interface ScenarioStep {
  emit?: { event: string; with?: Record<string, unknown> };
  transcript?: { record: Record<string, unknown> };
  delay?: { ms: number };
  fault?: { kind: 'crash'; exitCode?: number; partialTranscriptLine?: string };
}

export interface ScenarioRunnerOptions {
  emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
  transcript: TranscriptWriter;
  /** ASM payload validation, injected from the model layer; violations fail the run. */
  validate?: (event: string, payload: Record<string, unknown>) => string[];
  /** Extra template bindings beyond $stimulus.* (e.g. $reply from a behavior pack). */
  bindings?: Record<string, string>;
  crash?: (exitCode: number) => void;
  log?: (message: string) => void;
}

export interface ScenarioRunner {
  run(steps: readonly ScenarioStep[], stimulus?: Record<string, unknown>): Promise<void>;
}

/** Replace "$stimulus.text", "$uuid:name", "$now", and option-provided bindings. */
function substitute(
  value: unknown,
  stimulus: Record<string, unknown>,
  bindings: Record<string, string>,
  uuids: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('$stimulus.')) {
      const key = value.slice('$stimulus.'.length);
      return stimulus[key];
    }
    if (value.startsWith('$uuid')) {
      const name = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
      let uuid = uuids.get(name);
      if (!uuid) {
        uuid = crypto.randomUUID();
        uuids.set(name, uuid);
      }
      return uuid;
    }
    if (value === '$now') return new Date().toISOString();
    if (value in bindings) return bindings[value];
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, stimulus, bindings, uuids));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        substitute(entry, stimulus, bindings, uuids),
      ]),
    );
  }
  return value;
}

export function createScenarioRunner(options: ScenarioRunnerOptions): ScenarioRunner {
  const log = options.log ?? (() => {});
  const crash = options.crash ?? ((exitCode: number) => process.exit(exitCode));
  return {
    async run(steps, stimulus = {}) {
      const uuids = new Map<string, string>();
      for (const step of steps) {
        if (step.delay) {
          await new Promise((resolve) => setTimeout(resolve, step.delay!.ms));
          continue;
        }
        if (step.emit) {
          const payload = substitute(step.emit.with ?? {}, stimulus, options.bindings ?? {}, uuids) as Record<
            string,
            unknown
          >;
          const violations = options.validate?.(step.emit.event, payload) ?? [];
          if (violations.length > 0) {
            throw new Error(`emulator emitted off-model payload for ${step.emit.event}: ${violations.join('; ')}`);
          }
          await options.emit(step.emit.event, payload);
          continue;
        }
        if (step.transcript) {
          options.transcript.append(
            substitute(step.transcript.record, stimulus, options.bindings ?? {}, uuids) as Record<string, unknown>,
          );
          continue;
        }
        if (step.fault) {
          if (step.fault.partialTranscriptLine) options.transcript.appendPartial(step.fault.partialTranscriptLine);
          log(`fault: crash exitCode=${step.fault.exitCode ?? 1}`);
          crash(step.fault.exitCode ?? 1);
          return;
        }
      }
    },
  };
}
