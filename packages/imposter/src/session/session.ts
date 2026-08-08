/**
 * Session assembly: persona + vendor argv -> live channels + op timeline.
 *
 * This is the only module that knows what an "envelope" is. Every emission
 * funnels through `emitHook`, which merges the envelope, appends
 * `hook_event_name`, validates against the ASM, records it, and only then
 * delivers — so there is exactly one place where something can reach the wire,
 * and exactly one place that can refuse it (draft/IMPOSTER.md §7.3 item 3).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpInvocation, Persona } from '../persona/types.ts';
import { flagValue } from '../cli/argv.ts';
import { ControlError, REFUSED, type FaultRequest, type ScenarioControlAction } from '../control/protocol.ts';
import { createHookEmitter, type HookSettings } from './channels/hook.ts';
import { createStatusLineInvoker } from './channels/statusline.ts';
import { createTranscriptWriter, type TranscriptWriter } from './channels/transcript.ts';
import {
  createScenarioGate,
  createScenarioRunner,
  scenarioSteps,
  type ScenarioGate,
  type ScenarioRunner,
} from './scenario.ts';
import { substitute } from './template.ts';
import { createOpTimeline, type OpTimeline, type PresentationFrame } from './timeline.ts';

export interface BehaviorDocument {
  name?: string;
  reply?: string;
  statusLine?: {
    modelId?: string;
    modelDisplayName?: string;
    capacityTokens?: number;
    tokensPerTurn?: number;
    rateLimits?: Record<string, { used_percentage: number; resetsInSeconds?: number }>;
  };
  ops?: OpInvocation[];
}

export interface EmittedRecord {
  at: string;
  sequence: number;
  event: string;
  payload?: Record<string, unknown>;
  truncated?: boolean;
}

export interface ImposterSessionOptions {
  persona: Persona;
  /** Vendor argv, i.e. everything after persona selection. */
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
  behavior: BehaviorDocument;
  present?: (frame: PresentationFrame) => void;
  /** Pushed for every emission in order — the control channel's log stream (§5.1). */
  onEmitted?: (entry: EmittedRecord) => void;
  /** Pushed when a fault disconnects a channel, so the console never polls for liveness. */
  onChannels?: (channels: string[]) => void;
  /**
   * Process-level fault effects. The session owns channel-level faults (flood,
   * channel-drop) but never reaches for `process` itself, so a test can drive
   * `crash` without taking the test runner with it.
   */
  halt?: (kind: 'crash' | 'exit' | 'hang', exitCode: number) => void;
  /**
   * The app-server sink, for personas that serve (§9.3). Late-bound by the
   * CLI because the channel needs the dispatcher, which needs this session.
   */
  jsonrpc?: {
    notify(method: string, params: Record<string, unknown>): void;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  log?: (message: string) => void;
}

export interface RunScenarioOptions {
  stimulus?: Record<string, unknown>;
  speed?: number;
  mode?: 'play' | 'pause' | 'step';
}

export interface ImposterSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly transcriptRoot: string;
  readonly liveChannels: string[];
  readonly emitted: readonly EmittedRecord[];
  readonly timeline: OpTimeline;
  /** Session bindings; the serve table mints ids into these (§9.3 `bind`). */
  readonly bindings: Record<string, unknown>;
  readonly transcript: TranscriptWriter;
  boot(): Promise<void>;
  /** One organic turn, driven by the persona's behavior pack. */
  turn(text: string): Promise<void>;
  /** Emit a single raw native event, ASM-validated. */
  emit(event: string, payload: Record<string, unknown>): Promise<void>;
  statusPayload(): Record<string, unknown>;
  invokeStatusLine(payload?: Record<string, unknown>): Promise<void>;
  dropChannel(channel: string): void;
  /**
   * Run one scenario document. `play` resolves when the scenario finishes;
   * `pause`/`step` resolve as soon as the script is known to be valid, because
   * a reply that waited for the console to press resume would be useless.
   */
  runScenario(document: unknown, options?: RunScenarioOptions): Promise<void>;
  scenarioControl(action: ScenarioControlAction): void;
  applyFault(request: FaultRequest): Promise<void>;
  end(reason?: string): Promise<void>;
}

const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;

export function createImposterSession(options: ImposterSessionOptions): ImposterSession {
  const { persona, argv, env, cwd, behavior } = options;
  const log = options.log ?? (() => {});

  const sessionId =
    flagValue(argv, persona.flagsFor('sessionId', '--session-id')) ??
    flagValue(argv, persona.flagsFor('resume', '--resume')) ??
    crypto.randomUUID();
  const settingsPath = flagValue(argv, persona.flagsFor('settings', '--settings'));
  const sessionTitle = flagValue(argv, persona.flagsFor('name', '--name')) ?? 'imposter-session';
  const permissionMode = flagValue(argv, persona.flagsFor('permissionMode', '--permission-mode')) ?? 'default';

  // Transcripts live under an imposter-owned root, NEVER the vendor's real one
  // (~/.claude), so imposted sessions stay out of the user's spaghetti index.
  const configuredRoot = env.CHOPSTICKS_IMPOSTER_HOME;
  const transcriptRoot = configuredRoot ?? mkdtempSync(join(tmpdir(), `chopsticks-imposter-${persona.vendor}-`));
  if (!configuredRoot) {
    process.once('exit', () => rmSync(transcriptRoot, { recursive: true, force: true }));
  }
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const transcriptPath = join(transcriptRoot, 'projects', slug, `${sessionId}.jsonl`);

  const settings: HookSettings & { statusLine?: unknown } = settingsPath
    ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as HookSettings)
    : {};
  const hookEmitter = createHookEmitter({ settings, env, log });
  const transcript = createTranscriptWriter(transcriptPath);
  const statusLineInvoker = createStatusLineInvoker(settings.statusLine, { log });

  // Drops are keyed by the VENDOR's channel name — the same name `liveChannels`
  // reports and the console shows — so a channel-drop fault addresses the thing
  // the operator can see. `channelFor` translates delivery kind to that name.
  const droppedChannels = new Set<string>();
  const dropped = (kind: 'hook' | 'transcript' | 'statusline' | 'jsonrpc'): boolean =>
    droppedChannels.has(persona.channelFor(kind) ?? kind);
  const emitted: EmittedRecord[] = [];
  let emittedBytes = 0;
  let sequence = 0;

  const record = (event: string, payload: Record<string, unknown>): void => {
    sequence += 1;
    let entry: EmittedRecord = { at: new Date().toISOString(), sequence, event, payload };
    let bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > MAX_ENTRY_BYTES) {
      entry = { at: entry.at, sequence: entry.sequence, event: entry.event, truncated: true };
      bytes = Buffer.byteLength(JSON.stringify(entry));
    }
    emitted.push(entry);
    emittedBytes += bytes;
    while (emitted.length > MAX_LOG_ENTRIES || emittedBytes > MAX_LOG_BYTES) {
      emittedBytes -= Buffer.byteLength(JSON.stringify(emitted.shift()));
    }
    options.onEmitted?.(entry);
  };

  /**
   * The envelope is persona-owned vocabulary, not a constant: claude sends
   * `session_id`/`transcript_path`, and a vendor that names them differently
   * has to be describable without editing this file (§3.2). `bindings` is
   * declared below but only read when an op actually emits, which is always
   * after initialization.
   */
  const envelope = (fields: Record<string, unknown>): Record<string, unknown> => ({
    ...(substitute(persona.document.envelope, { bindings }) as Record<string, unknown>),
    ...fields,
  });

  /**
   * An unknown native name still has to reach the bridge for ADR-008 retention
   * to be testable end to end, but it has no handler of its own — route it
   * through any wired handler, exactly as the PoC did.
   */
  const fallbackRoute = persona.model.events.find((event) => (settings.hooks?.[event.event]?.length ?? 0) > 0)?.event;

  const wireFor = (event: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    ...envelope(payload),
    ...(persona.document.eventNameField ? { [persona.document.eventNameField]: event } : {}),
  });

  const emit = async (event: string, payload: Record<string, unknown>): Promise<void> => {
    const wire = wireFor(event, payload);
    const violations = persona.validate(event, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${event}: ${violations.join('; ')}`);
    }
    record(event, wire);
    if (dropped('hook')) {
      log(`dropped ${event}: hook channel is disconnected`);
      return;
    }
    await hookEmitter.emit(event, wire, persona.schemaFor(event) ? event : fallbackRoute);
  };

  /**
   * The app-server emitters. They funnel through the SAME envelope + ASM
   * validation + record boundary as hooks do, because "exactly one place that
   * can refuse" (§7.3 item 3) is a property of the imposter, not of the hook
   * channel.
   */
  const emitRpc = async (method: string, params: Record<string, unknown>): Promise<void> => {
    const wire = wireFor(method, params);
    const violations = persona.validate(method, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${method}: ${violations.join('; ')}`);
    }
    record(method, wire);
    if (dropped('jsonrpc')) return log(`dropped ${method}: app-server channel is disconnected`);
    options.jsonrpc?.notify(method, wire);
  };

  const requestRpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const wire = wireFor(method, params);
    const violations = persona.validate(method, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${method}: ${violations.join('; ')}`);
    }
    record(method, wire);
    if (!options.jsonrpc) throw new Error(`${method} needs a server request, but no app-server channel is wired`);
    return options.jsonrpc.request(method, wire);
  };

  const status = behavior.statusLine ?? {};
  const modelId =
    flagValue(argv, persona.flagsFor('model', '--model')) ?? status.modelId ?? `${persona.vendor}-imposter`;
  const capacityTokens = status.capacityTokens ?? 200_000;
  let usedTokens = 0;

  const statusPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      model: { id: modelId, display_name: status.modelDisplayName ?? modelId },
      workspace: { current_dir: cwd },
      context_window:
        usedTokens === 0
          ? { total_input_tokens: 0, context_window_size: capacityTokens, current_usage: null }
          : {
              total_input_tokens: usedTokens,
              context_window_size: capacityTokens,
              used_percentage: Math.round((usedTokens / capacityTokens) * 1000) / 10,
              current_usage: {
                input_tokens: usedTokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
    };
    if (status.rateLimits) {
      payload.rate_limits = Object.fromEntries(
        Object.entries(status.rateLimits).map(([id, window]) => [
          id,
          {
            used_percentage: window.used_percentage,
            resets_at: new Date(Date.now() + (window.resetsInSeconds ?? 3600) * 1000).toISOString(),
          },
        ]),
      );
    }
    return payload;
  };

  const invokeStatusLine = async (payload?: Record<string, unknown>): Promise<void> => {
    if (dropped('statusline')) {
      log('dropped statusline payload: channel is disconnected');
      return;
    }
    await statusLineInvoker?.invoke(payload ?? statusPayload());
  };

  const guardedTranscript: TranscriptWriter = {
    path: transcript.path,
    append: (entry) => {
      if (dropped('transcript')) return log('dropped transcript record: channel is disconnected');
      transcript.append(entry);
    },
    appendPartial: (fragment) => {
      if (dropped('transcript')) return log('dropped transcript fragment: channel is disconnected');
      transcript.appendPartial(fragment);
    },
  };

  const bindings: Record<string, unknown> = {
    $sessionId: sessionId,
    $sessionTitle: sessionTitle,
    $permissionMode: permissionMode,
    $transcriptPath: transcriptPath,
    $cwd: cwd,
    $vendorVersion: persona.version,
    $modelId: modelId,
    $capacityTokens: capacityTokens,
    $claudeMdPath: join(cwd, 'CLAUDE.md'),
    ...(behavior.reply === undefined ? {} : { $reply: behavior.reply }),
  };

  const timeline = createOpTimeline({
    persona,
    emitHook: emit,
    emitJsonRpc: emitRpc,
    requestJsonRpc: requestRpc,
    transcript: guardedTranscript,
    statusline: async () => invokeStatusLine(),
    present: options.present,
    bindings,
    statusPayload,
    log,
  });

  const liveChannels = (): string[] => persona.channels.filter((channel) => !droppedChannels.has(channel));

  const endSession = async (reason = 'other'): Promise<void> => {
    await timeline.run({ op: 'session.end', with: { reason } }).catch((error: unknown) => {
      log(`session.end failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  /**
   * Process-level faults default to what a real vendor does when it dies.
   * `setImmediate` is load-bearing: the control reply has to flush before the
   * process goes away, or the console reports a fault as failed when it landed.
   */
  const halt =
    options.halt ??
    ((kind: 'crash' | 'exit' | 'hang', exitCode: number): void => {
      if (kind === 'hang') {
        process.stdin.pause();
        return;
      }
      setImmediate(() => {
        if (kind === 'crash') process.exit(exitCode);
        else void endSession('other').finally(() => process.exit(exitCode));
      });
    });

  const applyFault = async (request: FaultRequest): Promise<void> => {
    switch (request.kind) {
      case 'channel-drop': {
        const channel = request.channel ?? 'hook';
        droppedChannels.add(channel);
        options.onChannels?.(liveChannels());
        log(`fault: dropped the ${channel} channel`);
        return;
      }
      case 'flood': {
        // There is no vendor-neutral default payload, so the caller supplies
        // one and the ASM refuses it if it is off-model — the same gate every
        // trigger goes through (§7.3 item 3).
        const event = request.event ?? persona.model.events[0]?.event;
        if (!event) throw new ControlError(REFUSED, 'flood requires an event');
        for (let index = 0; index < (request.count ?? 100); index += 1) await emit(event, request.with ?? {});
        return;
      }
      case 'crash':
        halt('crash', request.exitCode ?? 137);
        return;
      case 'exit':
        halt('exit', request.exitCode ?? 0);
        return;
      case 'hang':
        halt('hang', 0);
        return;
    }
  };

  const runner: ScenarioRunner = createScenarioRunner({
    emit,
    transcript: guardedTranscript,
    statusline: (payload) => invokeStatusLine(payload),
    // Pre-flight validation sees exactly the wire payload `emit` will build,
    // envelope included, so a scenario cannot pass here and be refused there.
    validate: (event, payload) => persona.validate(event, wireFor(event, payload)),
    fault: applyFault,
    bindings,
    log,
  });

  let gate: ScenarioGate | undefined;

  return {
    sessionId,
    transcriptPath,
    transcriptRoot,
    get liveChannels() {
      return liveChannels();
    },
    emitted,
    timeline,
    bindings,
    transcript: guardedTranscript,
    emit,
    statusPayload,
    invokeStatusLine,
    dropChannel(channel) {
      droppedChannels.add(channel);
      options.onChannels?.(liveChannels());
    },
    applyFault,
    async runScenario(document, runOptions = {}) {
      const mode = runOptions.mode ?? 'play';
      const active = createScenarioGate(mode);
      // prepare() validates the whole script and touches nothing, so a bad
      // scenario fails the caller before the gate is ever published.
      const prepared = runner.prepare(scenarioSteps(document), runOptions.stimulus ?? {}, {
        speed: runOptions.speed ?? 1,
        gate: active,
      });
      gate = active;
      const finish = (): void => {
        if (gate === active) gate = undefined;
      };
      if (mode === 'play') {
        await prepared.play().finally(finish);
        return;
      }
      void prepared
        .play()
        .catch((error: unknown) => log(`scenario failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(finish);
    },
    scenarioControl(action) {
      if (!gate) throw new ControlError(REFUSED, 'no scenario is running');
      if (action === 'pause') gate.pause();
      else if (action === 'step') gate.step();
      else gate.resume();
    },
    async boot() {
      await timeline.runAll(persona.document.boot);
    },
    async turn(text) {
      const ops = behavior.ops ?? [];
      if (ops.length === 0) {
        log(`persona ${persona.vendor} has no behavior ops; the turn is a no-op`);
        return;
      }
      timeline.beginTurn();
      // Behavior templates resolve against the stimulus FIRST, so the timeline
      // receives concrete op arguments and ops.json only ever sees `$op.*`.
      const uuids = new Map<string, string>();
      for (const invocation of ops) {
        const resolved = substitute(invocation.with ?? {}, {
          scopes: { stimulus: { text } },
          bindings,
          uuids,
        }) as Record<string, unknown>;
        await timeline.run({ op: invocation.op, with: resolved });
      }
      usedTokens += status.tokensPerTurn ?? 0;
      await invokeStatusLine();
    },
    end: endSession,
  };
}
