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
import { createHookEmitter, type HookSettings } from './channels/hook.ts';
import { createStatusLineInvoker } from './channels/statusline.ts';
import { createTranscriptWriter, type TranscriptWriter } from './channels/transcript.ts';
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
  log?: (message: string) => void;
}

export interface ImposterSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly transcriptRoot: string;
  readonly liveChannels: string[];
  readonly emitted: readonly EmittedRecord[];
  readonly timeline: OpTimeline;
  readonly transcript: TranscriptWriter;
  boot(): Promise<void>;
  /** One organic turn, driven by the persona's behavior pack. */
  turn(text: string): Promise<void>;
  /** Emit a single raw native event, ASM-validated. */
  emit(event: string, payload: Record<string, unknown>): Promise<void>;
  statusPayload(): Record<string, unknown>;
  invokeStatusLine(): Promise<void>;
  dropChannel(channel: string): void;
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

  const droppedChannels = new Set<string>();
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
  };

  const envelope = (fields: Record<string, unknown>): Record<string, unknown> => ({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    permission_mode: permissionMode,
    ...fields,
  });

  /**
   * An unknown native name still has to reach the bridge for ADR-008 retention
   * to be testable end to end, but it has no handler of its own — route it
   * through any wired handler, exactly as the PoC did.
   */
  const fallbackRoute = persona.model.events.find((event) => (settings.hooks?.[event.event]?.length ?? 0) > 0)?.event;

  const emit = async (event: string, payload: Record<string, unknown>): Promise<void> => {
    const wire = { ...envelope(payload), hook_event_name: event };
    const violations = persona.validate(event, wire);
    if (violations.length > 0) {
      throw new Error(`imposter refused an off-model payload for ${event}: ${violations.join('; ')}`);
    }
    record(event, wire);
    if (droppedChannels.has('hook')) {
      log(`dropped ${event}: hook channel is disconnected`);
      return;
    }
    await hookEmitter.emit(event, wire, persona.schemaFor(event) ? event : fallbackRoute);
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

  const invokeStatusLine = async (): Promise<void> => {
    if (droppedChannels.has('statusline')) {
      log('dropped statusline payload: channel is disconnected');
      return;
    }
    await statusLineInvoker?.invoke(statusPayload());
  };

  const guardedTranscript: TranscriptWriter = {
    path: transcript.path,
    append: (entry) => {
      if (droppedChannels.has('transcript')) return log('dropped transcript record: channel is disconnected');
      transcript.append(entry);
    },
    appendPartial: (fragment) => {
      if (droppedChannels.has('transcript')) return log('dropped transcript fragment: channel is disconnected');
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
    transcript: guardedTranscript,
    statusline: async () => invokeStatusLine(),
    present: options.present,
    bindings,
    statusPayload,
    log,
  });

  return {
    sessionId,
    transcriptPath,
    transcriptRoot,
    get liveChannels() {
      return persona.channels.filter((channel) => !droppedChannels.has(channel));
    },
    emitted,
    timeline,
    transcript: guardedTranscript,
    emit,
    statusPayload,
    invokeStatusLine,
    dropChannel(channel) {
      droppedChannels.add(channel);
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
    async end(reason = 'other') {
      await timeline.run({ op: 'session.end', with: { reason } }).catch((error: unknown) => {
        log(`session.end failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  };
}
