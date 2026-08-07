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
  /**
   * Deliver one event; resolves when the handler(s) acknowledge. `routeEvent`
   * is an emulator-only escape hatch for sending a future/unknown native name
   * through a known handler transport so retention can be tested end to end.
   */
  emit(event: string, payload: Record<string, unknown>, routeEvent?: string): Promise<void>;
}

/** Resolve `Bearer $VAR`-style header values against explicitly granted env. */
function resolveEnvRefs(value: string, env: Record<string, string | undefined>, allowed: Set<string>): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, name: string) =>
    allowed.has(name) ? (env[name] ?? match) : match,
  );
}

/**
 * The repo's own generated curl forwarder (settings.ts `curlForwarder`) is
 * recognized by shape and delivered as a direct POST with identical headers
 * and body. The observable contract at the bridge is byte-identical, but the
 * shortcut works where `sh` is absent (Windows dev machines); unrecognized
 * command handlers still run through the platform shell with the payload on stdin.
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
    const allowedEnvVars = new Set(
      Array.isArray(handler.allowedEnvVars)
        ? handler.allowedEnvVars.filter((name): name is string => typeof name === 'string')
        : [],
    );
    for (const [name, value] of Object.entries((handler.headers as Record<string, string>) ?? {})) {
      headers[name] = resolveEnvRefs(value, env, allowedEnvVars);
    }
    const timeoutSec =
      typeof handler.timeout === 'number' && Number.isFinite(handler.timeout) && handler.timeout > 0
        ? Math.min(handler.timeout, 300)
        : 5;
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
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      const child = spawn(handler.command as string, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
      const timeoutSec =
        typeof handler.timeout === 'number' && Number.isFinite(handler.timeout) && handler.timeout > 0
          ? Math.min(handler.timeout, 300)
          : 5;
      timer = setTimeout(() => {
        log(`command hook timed out after ${timeoutSec}s`);
        child.kill('SIGKILL');
        finish();
      }, timeoutSec * 1000);
      child.on('error', (error) => {
        log(`command hook failed to spawn: ${error.message}`);
        finish();
      });
      child.on('close', finish);
      child.stdin.on('error', (error) => log(`command hook stdin failed: ${error.message}`));
      child.stdin.end(body);
    });
  }
}

export function createHookEmitter(options: HookEmitterOptions): HookEmitter {
  const log = options.log ?? (() => {});
  // Hooks fire 1:1 with their cause and the bridge treats arrival order as
  // meaningful, so emissions are serialized on a promise chain.
  let queue = Promise.resolve();
  return {
    emit(event, payload, routeEvent = event) {
      const matchers = options.settings.hooks?.[routeEvent] ?? [];
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
  options: { log?: (message: string) => void; timeoutMs?: number } = {},
): StatusLineInvoker | undefined {
  const log = options.log ?? (() => {});
  const command =
    config !== null && typeof config === 'object' ? (config as Record<string, unknown>).command : undefined;
  if (typeof command !== 'string' || command.length === 0) return undefined;
  return {
    invoke(payload) {
      return new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        const child = spawn(command, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
        const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5_000, 300_000));
        timer = setTimeout(() => {
          log(`statusline command timed out after ${timeoutMs}ms`);
          child.kill('SIGKILL');
          finish();
        }, timeoutMs);
        child.on('error', (error) => {
          log(`statusline command failed to spawn: ${error.message}`);
          finish();
        });
        child.on('close', finish);
        child.stdin.on('error', (error) => log(`statusline command stdin failed: ${error.message}`));
        child.stdin.end(JSON.stringify(payload));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario runner (behavior rules + timelines)
// ---------------------------------------------------------------------------

export interface ScenarioAction {
  emit?: { channel?: string; event: string; with?: Record<string, unknown>; afterMs?: number };
  transcript?: { record: Record<string, unknown> };
  statusline?: { with: Record<string, unknown> };
  delay?: { ms: number };
  fault?: {
    kind: 'crash' | 'exit' | 'hang' | 'flood' | 'channel-drop';
    exitCode?: number;
    partialTranscriptLine?: string;
    channel?: string;
    count?: number;
    event?: string;
    with?: Record<string, unknown>;
  };
}

export interface ScenarioTimelineStep {
  /** Milliseconds from the timeline origin, before speed scaling. */
  at: number;
  do: ScenarioAction;
}

/** Behavior packs use direct actions; named scenarios may use `at`/`do` timelines. */
export type ScenarioStep = ScenarioAction | ScenarioTimelineStep;

export interface ScenarioRunnerOptions {
  emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
  transcript: TranscriptWriter;
  /** ASM payload validation, injected from the model layer; violations fail the run. */
  validate?: (event: string, payload: Record<string, unknown>) => string[];
  /** Extra template bindings beyond $stimulus.* (e.g. $reply from a behavior pack). */
  bindings?: Record<string, unknown>;
  statusline?: (payload: Record<string, unknown>) => Promise<void>;
  fault?: (fault: NonNullable<ScenarioAction['fault']>) => void | Promise<void>;
  /** Legacy/default crash behavior when no general fault handler is supplied. */
  crash?: (exitCode: number) => void;
  log?: (message: string) => void;
}

export interface ScenarioRunner {
  run(steps: readonly ScenarioStep[], stimulus?: Record<string, unknown>, options?: { speed?: number }): Promise<void>;
}

/** Replace "$stimulus.text", "$uuid:name", "$now", and option-provided bindings. */
function substitute(
  value: unknown,
  stimulus: Record<string, unknown>,
  bindings: Record<string, unknown>,
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
  const maximumDelayMs = 5 * 60 * 1000;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const rejectUnknownFields = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
    const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
    if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
  };
  return {
    async run(steps, stimulus = {}, runOptions = {}) {
      if (!Array.isArray(steps) || steps.length > 10_000) {
        throw new Error('scenario steps must be an array with at most 10000 entries');
      }
      const speed = runOptions.speed ?? 1;
      if (!Number.isFinite(speed) || speed <= 0 || speed > 100) {
        throw new Error('scenario speed must be greater than 0 and at most 100');
      }
      const prepared: Array<{ action: ScenarioAction; waitMs: number }> = [];
      const validationUuids = new Map<string, string>();
      let timelineAt = 0;
      let totalWaitMs = 0;
      for (const step of steps) {
        if (!isRecord(step)) throw new Error('each scenario step must be an object');
        const timelineStep = Object.hasOwn(step, 'do');
        const rawAction = timelineStep ? step.do : step;
        if (!isRecord(rawAction)) throw new Error('each scenario action must be an object');
        const action = rawAction as ScenarioAction;
        let waitMs = 0;
        if (timelineStep) {
          rejectUnknownFields(step, ['at', 'do'], 'scenario timeline step');
          if (
            !Number.isFinite(step.at) ||
            typeof step.at !== 'number' ||
            step.at < timelineAt ||
            step.at > maximumDelayMs
          ) {
            throw new Error(
              `scenario timeline must be finite, sorted, and between 0 and ${maximumDelayMs}ms (got ${String(step.at)})`,
            );
          }
          waitMs += step.at - timelineAt;
          timelineAt = step.at;
        }
        rejectUnknownFields(
          action as Record<string, unknown>,
          ['delay', 'emit', 'transcript', 'statusline', 'fault'],
          'scenario action',
        );
        const actionCount = [action.delay, action.emit, action.transcript, action.statusline, action.fault].filter(
          (value) => value !== undefined,
        ).length;
        if (actionCount !== 1) throw new Error('each scenario step must contain exactly one action');
        if (action.delay !== undefined) {
          if (!isRecord(action.delay)) throw new Error('scenario delay must be an object');
          rejectUnknownFields(action.delay, ['ms'], 'scenario delay');
          if (
            typeof action.delay.ms !== 'number' ||
            !Number.isFinite(action.delay.ms) ||
            action.delay.ms < 0 ||
            action.delay.ms > maximumDelayMs
          ) {
            throw new Error(`scenario delay must be between 0 and ${maximumDelayMs}ms`);
          }
          waitMs += action.delay.ms;
        }
        if (action.emit !== undefined) {
          if (!isRecord(action.emit)) throw new Error('scenario emit must be an object');
          rejectUnknownFields(action.emit, ['channel', 'event', 'with', 'afterMs'], 'scenario emit');
          if (
            typeof action.emit.event !== 'string' ||
            action.emit.event.length === 0 ||
            action.emit.event.length > 256
          ) {
            throw new Error('scenario emit.event must be a non-empty string of at most 256 characters');
          }
          if (
            action.emit.channel !== undefined &&
            (typeof action.emit.channel !== 'string' ||
              action.emit.channel.length === 0 ||
              action.emit.channel.length > 128)
          ) {
            throw new Error('scenario emit.channel must be a non-empty string of at most 128 characters');
          }
          if (action.emit.with !== undefined && !isRecord(action.emit.with)) {
            throw new Error('scenario emit.with must be an object');
          }
          if (action.emit.afterMs !== undefined) {
            if (
              typeof action.emit.afterMs !== 'number' ||
              !Number.isFinite(action.emit.afterMs) ||
              action.emit.afterMs < 0 ||
              action.emit.afterMs > maximumDelayMs
            ) {
              throw new Error(`emit.afterMs must be between 0 and ${maximumDelayMs}ms`);
            }
            waitMs += action.emit.afterMs;
          }
          const preview = substitute(
            action.emit.with ?? {},
            stimulus,
            options.bindings ?? {},
            validationUuids,
          ) as Record<string, unknown>;
          const violations = options.validate?.(action.emit.event, preview) ?? [];
          if (violations.length > 0) {
            throw new Error(`emulator emitted off-model payload for ${action.emit.event}: ${violations.join('; ')}`);
          }
        }
        if (action.transcript !== undefined) {
          if (!isRecord(action.transcript)) throw new Error('scenario transcript must be an object');
          rejectUnknownFields(action.transcript, ['record'], 'scenario transcript');
          if (!isRecord(action.transcript.record)) throw new Error('scenario transcript.record must be an object');
        }
        if (action.statusline !== undefined) {
          if (!isRecord(action.statusline)) throw new Error('scenario statusline must be an object');
          rejectUnknownFields(action.statusline, ['with'], 'scenario statusline');
          if (!isRecord(action.statusline.with)) throw new Error('scenario statusline.with must be an object');
          if (!options.statusline) throw new Error('scenario requested statusline but no invoker is configured');
        }
        if (action.fault !== undefined) {
          if (!isRecord(action.fault)) throw new Error('scenario fault must be an object');
          rejectUnknownFields(
            action.fault,
            ['kind', 'exitCode', 'partialTranscriptLine', 'channel', 'count', 'event', 'with'],
            'scenario fault',
          );
          if (!['crash', 'exit', 'hang', 'flood', 'channel-drop'].includes(action.fault.kind)) {
            throw new Error(`unsupported scenario fault ${String(action.fault.kind)}`);
          }
          if (
            action.fault.count !== undefined &&
            (!Number.isInteger(action.fault.count) || action.fault.count < 1 || action.fault.count > 10_000)
          ) {
            throw new Error('scenario fault count must be an integer from 1 to 10000');
          }
          if (
            action.fault.channel !== undefined &&
            (typeof action.fault.channel !== 'string' ||
              action.fault.channel.length === 0 ||
              action.fault.channel.length > 128)
          ) {
            throw new Error('scenario fault channel must be a non-empty string of at most 128 characters');
          }
          if (
            action.fault.event !== undefined &&
            (typeof action.fault.event !== 'string' ||
              action.fault.event.length === 0 ||
              action.fault.event.length > 256)
          ) {
            throw new Error('scenario fault event must be a non-empty string of at most 256 characters');
          }
          if (
            action.fault.exitCode !== undefined &&
            (!Number.isInteger(action.fault.exitCode) || action.fault.exitCode < 0 || action.fault.exitCode > 255)
          ) {
            throw new Error('scenario fault exitCode must be an integer from 0 to 255');
          }
          if (
            action.fault.partialTranscriptLine !== undefined &&
            (typeof action.fault.partialTranscriptLine !== 'string' ||
              Buffer.byteLength(action.fault.partialTranscriptLine) > 64 * 1024)
          ) {
            throw new Error('scenario partial transcript line must be a string of at most 65536 bytes');
          }
          if (action.fault.with !== undefined && !isRecord(action.fault.with)) {
            throw new Error('scenario fault with must be an object');
          }
          if (!options.fault && action.fault.kind !== 'crash') {
            throw new Error(`scenario fault ${action.fault.kind} requires a fault handler`);
          }
        }
        totalWaitMs += waitMs;
        if (totalWaitMs / speed > maximumDelayMs) {
          throw new Error(`scenario's total scaled delay must be at most ${maximumDelayMs}ms`);
        }
        prepared.push({ action, waitMs });
      }

      // Structural and ASM validation above is deliberately complete before
      // the first side effect, so a typo late in an inline script cannot leave
      // a half-applied scenario behind.
      const uuids = new Map<string, string>();
      for (const { action, waitMs } of prepared) {
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs / speed));
        if (action.delay !== undefined) continue;
        if (action.emit !== undefined) {
          const payload = substitute(action.emit.with ?? {}, stimulus, options.bindings ?? {}, uuids) as Record<
            string,
            unknown
          >;
          await options.emit(action.emit.event, payload);
          continue;
        }
        if (action.transcript !== undefined) {
          options.transcript.append(
            substitute(action.transcript.record, stimulus, options.bindings ?? {}, uuids) as Record<string, unknown>,
          );
          continue;
        }
        if (action.statusline !== undefined) {
          await options.statusline!(
            substitute(action.statusline.with, stimulus, options.bindings ?? {}, uuids) as Record<string, unknown>,
          );
          continue;
        }
        if (action.fault !== undefined) {
          if (action.fault.partialTranscriptLine) options.transcript.appendPartial(action.fault.partialTranscriptLine);
          log(`fault: ${action.fault.kind}`);
          if (options.fault) await options.fault(action.fault);
          else crash(action.fault.exitCode ?? 1);
          if (['crash', 'exit', 'hang'].includes(action.fault.kind)) return;
          continue;
        }
      }
    },
  };
}
