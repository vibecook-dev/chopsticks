/**
 * Scenario runner — the raw layer beneath the op timeline (draft/IMPOSTER.md §2).
 *
 * Ops describe organic turns; scenarios describe everything adversarial that
 * ops cannot express by definition — faults, duplicates, out-of-order arrival,
 * floods, and unknown native events (there is no op for an event the model has
 * never seen). Both reach the channels, but only ops fan out to the
 * presentation projection.
 *
 * The entire script is structurally and schema-validated BEFORE the first side
 * effect, so a typo late in an inline script cannot leave a half-applied
 * scenario behind (§7.3 item 2).
 */

import type { TranscriptWriter } from './channels/transcript.ts';
import { substitute } from './template.ts';

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

export type ScenarioFault = NonNullable<ScenarioAction['fault']>;

export interface ScenarioRunnerOptions {
  emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
  transcript: TranscriptWriter;
  /** ASM payload validation; violations fail the run before anything is emitted. */
  validate?: (event: string, payload: Record<string, unknown>) => string[];
  /** Extra template bindings beyond $stimulus.* (e.g. $reply from a behavior pack). */
  bindings?: Record<string, unknown>;
  statusline?: (payload: Record<string, unknown>) => Promise<void>;
  fault?: (fault: ScenarioFault) => void | Promise<void>;
  /** Legacy/default crash behavior when no general fault handler is supplied. */
  crash?: (exitCode: number) => void;
  log?: (message: string) => void;
}

/**
 * The pause/step gate (draft/IMPOSTER.md §5.1). The runner awaits this between
 * prepared steps, which is the whole mechanism behind `scenario.control` — a
 * held control connection can release one step at a time and watch the emitted
 * traffic arrive between them.
 */
export interface ScenarioGate {
  /** Resolves immediately while running; blocks while paused. */
  wait(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Release exactly one step, then hold again. */
  step(): void;
  readonly paused: boolean;
}

export function createScenarioGate(initial: 'play' | 'pause' | 'step' = 'play'): ScenarioGate {
  let paused = initial !== 'play';
  // Credits cover the race where `step` arrives before the runner reaches its
  // next `wait` — without them the release would be lost and the scenario would
  // sit forever one step behind the console.
  let credits = initial === 'step' ? 1 : 0;
  let waiters: Array<() => void> = [];

  return {
    get paused() {
      return paused;
    },
    wait() {
      if (!paused) return Promise.resolve();
      if (credits > 0) {
        credits -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      credits = 0;
      const released = waiters;
      waiters = [];
      for (const resolve of released) resolve();
    },
    step() {
      paused = true;
      const next = waiters.shift();
      if (next) next();
      else credits += 1;
    },
  };
}

export interface ScenarioRunOptions {
  speed?: number;
  gate?: ScenarioGate;
}

/** A fully validated scenario that has not yet touched a channel. */
export interface PreparedScenario {
  readonly steps: number;
  play(): Promise<void>;
}

export interface ScenarioRunner {
  /**
   * Validate a whole script without running it. Splitting preparation from
   * playback is what lets a paused run answer its caller immediately: the
   * request is already known to be well-formed, and progress is observed
   * through pushed emissions rather than a reply that would not arrive until
   * the console pressed resume.
   */
  prepare(
    steps: readonly ScenarioStep[],
    stimulus?: Record<string, unknown>,
    options?: ScenarioRunOptions,
  ): PreparedScenario;
  run(steps: readonly ScenarioStep[], stimulus?: Record<string, unknown>, options?: ScenarioRunOptions): Promise<void>;
}

const MAX_DELAY_MS = 5 * 60 * 1000;
const MAX_STEPS = 10_000;

/**
 * Unwrap a scenario document into its steps. Named scenario files carry a
 * `{ name, steps }` envelope; inline scripts from the control channel may be a
 * bare array. `then` is accepted because the behavior packs use it.
 */
export function scenarioSteps(document: unknown): ScenarioStep[] {
  if (Array.isArray(document)) return document as ScenarioStep[];
  if (document === null || typeof document !== 'object') throw new Error('scenario must be a JSON object or array');
  const record = document as Record<string, unknown>;
  const steps = Array.isArray(record.steps) ? record.steps : record.then;
  if (!Array.isArray(steps)) throw new Error('scenario must contain a steps or then array');
  return steps as ScenarioStep[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
}

function boundedMs(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new Error(`${label} must be between 0 and ${MAX_DELAY_MS}ms`);
  }
  return value;
}

export function createScenarioRunner(options: ScenarioRunnerOptions): ScenarioRunner {
  const log = options.log ?? (() => {});
  const crash = options.crash ?? ((exitCode: number) => process.exit(exitCode));

  const prepareScenario = (
    steps: readonly ScenarioStep[],
    stimulus: Record<string, unknown> = {},
    runOptions: ScenarioRunOptions = {},
  ): PreparedScenario => {
    if (!Array.isArray(steps) || steps.length > MAX_STEPS) {
      throw new Error(`scenario steps must be an array with at most ${MAX_STEPS} entries`);
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
          typeof step.at !== 'number' ||
          !Number.isFinite(step.at) ||
          step.at < timelineAt ||
          step.at > MAX_DELAY_MS
        ) {
          throw new Error(
            `scenario timeline must be finite, sorted, and between 0 and ${MAX_DELAY_MS}ms (got ${String(step.at)})`,
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
        waitMs += boundedMs(action.delay.ms, 'scenario delay');
      }

      if (action.emit !== undefined) {
        if (!isRecord(action.emit)) throw new Error('scenario emit must be an object');
        rejectUnknownFields(action.emit, ['channel', 'event', 'with', 'afterMs'], 'scenario emit');
        if (typeof action.emit.event !== 'string' || action.emit.event.length === 0 || action.emit.event.length > 256) {
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
        if (action.emit.afterMs !== undefined) waitMs += boundedMs(action.emit.afterMs, 'emit.afterMs');

        // Validate exactly the payload that will hit the wire, with template
        // bindings already resolved — an off-model scenario must fail before
        // it emits anything at all.
        const preview = substitute(action.emit.with ?? {}, {
          scopes: { stimulus },
          bindings: options.bindings,
          uuids: validationUuids,
        }) as Record<string, unknown>;
        const violations = options.validate?.(action.emit.event, preview) ?? [];
        if (violations.length > 0) {
          throw new Error(`imposter emitted off-model payload for ${action.emit.event}: ${violations.join('; ')}`);
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
          (typeof action.fault.event !== 'string' || action.fault.event.length === 0 || action.fault.event.length > 256)
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
      if (totalWaitMs / speed > MAX_DELAY_MS) {
        throw new Error(`scenario's total scaled delay must be at most ${MAX_DELAY_MS}ms`);
      }
      prepared.push({ action, waitMs });
    }

    // Validation above is deliberately complete before the first side effect.
    return {
      steps: prepared.length,
      play: async () => {
        const uuids = new Map<string, string>();
        for (const { action, waitMs } of prepared) {
          // The gate comes before the delay so a paused scenario holds at the
          // step boundary rather than partway through its wait.
          await runOptions.gate?.wait();
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs / speed));
          if (action.delay !== undefined) continue;
          if (action.emit !== undefined) {
            const payload = substitute(action.emit.with ?? {}, {
              scopes: { stimulus },
              bindings: options.bindings,
              uuids,
            }) as Record<string, unknown>;
            await options.emit(action.emit.event, payload);
            continue;
          }
          if (action.transcript !== undefined) {
            options.transcript.append(
              substitute(action.transcript.record, {
                scopes: { stimulus },
                bindings: options.bindings,
                uuids,
              }) as Record<string, unknown>,
            );
            continue;
          }
          if (action.statusline !== undefined) {
            await options.statusline!(
              substitute(action.statusline.with, { scopes: { stimulus }, bindings: options.bindings, uuids }) as Record<
                string,
                unknown
              >,
            );
            continue;
          }
          if (action.fault !== undefined) {
            if (action.fault.partialTranscriptLine)
              options.transcript.appendPartial(action.fault.partialTranscriptLine);
            log(`fault: ${action.fault.kind}`);
            if (options.fault) await options.fault(action.fault);
            else crash(action.fault.exitCode ?? 1);
            if (['crash', 'exit', 'hang'].includes(action.fault.kind)) return;
            continue;
          }
        }
      },
    };
  };

  return {
    prepare: prepareScenario,
    // `async` so a preparation failure stays a rejection for `run` callers;
    // `prepare` keeps throwing synchronously, which is what lets the control
    // channel answer a malformed scenario before starting anything.
    run: async (steps, stimulus, runOptions) => prepareScenario(steps, stimulus, runOptions).play(),
  };
}
