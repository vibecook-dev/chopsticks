#!/usr/bin/env node
/**
 * claude emulator bin (draft/EMULATOR.md §4) — the executable the adapter
 * spawns in place of `claude` (via CHOPSTICKS_CLAUDE_BIN or the executables
 * option). Speaks the real channels: parses the generated --settings file to
 * find its hook handlers, fires boot hooks, answers guarded pastes with the
 * behavior pack, and writes a real transcript JSONL for the spaghetti-SDK
 * tail. Semantics only — the TUI is a stub by design (ADR-003).
 *
 * Transcripts live under an emulator root (CHOPSTICKS_EMULATOR_CLAUDE_HOME or
 * tmpdir), NEVER ~/.claude, so emulated sessions stay out of the user's real
 * spaghetti index.
 *
 * Requires node >= 22.18 (type stripping; older 22.x: --experimental-strip-types).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validatePayload } from '@vibecook/chopsticks-emulator/model';
import {
  createHookEmitter,
  createPasteDecoder,
  createScenarioRunner,
  createStatusLineInvoker,
  createTranscriptWriter,
} from '@vibecook/chopsticks-emulator/engine';
import { createEmulatorControlServer } from '@vibecook/chopsticks-emulator/control';

const emulatorDir = fileURLToPath(new URL('.', import.meta.url));
const surface = join(emulatorDir, '..');

// ---------------------------------------------------------------------------
// argv — the subset of claude's surface the adapter's launch recipe uses
// (detection.json keeps the probed-flag list honest)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes('--version')) {
  console.log('2.1.207 (Claude Code)');
  process.exit(0);
}
if (argv.includes('--help')) {
  console.log('Usage: claude [--session-id <uuid> | --resume <uuid>] [--settings <path>]');
  console.log('  -n, --name <title>        session title');
  console.log('      --permission-mode <m> default | plan | ...');
  console.log('      --model <model>       model alias or id');
  console.log('      (emulator) --scenario <name> runs surface/emulator/scenarios/<name>.json on first paste');
  process.exit(0);
}

const sessionId = flag('--session-id') ?? flag('--resume') ?? crypto.randomUUID();
const settingsPath = flag('--settings');
if (!settingsPath) {
  console.error('claude-emulator: --settings is required');
  process.exit(2);
}
const sessionTitle = flag('--name') ?? 'emulator-session';
const permissionMode = flag('--permission-mode') ?? 'default';
const cwd = process.cwd();

const transcriptRoot = process.env.CHOPSTICKS_EMULATOR_CLAUDE_HOME ?? join(tmpdir(), 'chopsticks-emulator-claude');
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const transcriptPath = join(transcriptRoot, 'projects', slug, `${sessionId}.jsonl`);

// Debug trace: the bin runs under PTYs where stderr is hard to observe, so
// boot milestones land in an append-only log next to the transcripts.
import { appendFileSync } from 'node:fs';
const debugLog = (message) => {
  try {
    appendFileSync(join(transcriptRoot, 'emulator-debug.log'), `${new Date().toISOString()} ${process.pid} ${message}\n`);
  } catch {}
};
debugLog(`boot argv=${JSON.stringify(process.argv.slice(2))} cwd=${cwd}`);

// ---------------------------------------------------------------------------
// channels: hook emitter from the generated settings; transcript writer; model
// ---------------------------------------------------------------------------
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const hookEmitter = createHookEmitter({
  settings,
  env: process.env,
  log: (message) => debugLog(message),
});
const transcript = createTranscriptWriter(transcriptPath);

const model = loadModel(join(surface, 'model', 'claude@2.1.207'));
const schemaByEvent = new Map(model.events.map((event) => [event.event, event.payloadSchema]));

const envelope = (fields) => ({
  session_id: sessionId,
  transcript_path: transcriptPath,
  cwd,
  permission_mode: permissionMode,
  ...fields,
});

// Every emission (boot, behavior, control trigger) goes through emitEvent:
// enveloped, appended to the log the control server exposes, then delivered.
const emittedLog = [];
const emitEvent = (event, payload) => {
  emittedLog.push({ at: new Date().toISOString(), event });
  return hookEmitter.emit(event, envelope(payload));
};

// Validate exactly what will hit the wire: envelope fields merged, plus the
// hook_event_name the emitter appends.
const validate = (event, payload) => {
  const schema = schemaByEvent.get(event);
  return schema ? validatePayload(schema, { ...envelope(payload), hook_event_name: event }) : [];
};

const behaviorName = flag('--scenario');
const behaviorPath = behaviorName
  ? join(emulatorDir, 'scenarios', `${behaviorName}.json`)
  : join(emulatorDir, 'behavior', 'happy-turn.json');
const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8'));

const runner = createScenarioRunner({
  emit: emitEvent,
  transcript,
  validate,
  bindings: {
    $sessionTitle: sessionTitle,
    $permissionMode: permissionMode,
    $sessionId: sessionId,
    $cwd: cwd,
    ...(behavior.reply ? { $reply: behavior.reply } : {}),
  },
  log: (message) => debugLog(message),
});

// ---------------------------------------------------------------------------
// statusline channel: the vendor invokes the configured command with session
// JSON on stdin. Cadence here: once at boot (known-empty window), then after
// each turn with cumulative fake usage (behavior-pack data).
// ---------------------------------------------------------------------------
const statusLineSpec = behavior.statusLine ?? {};
const statusLineInvoker = createStatusLineInvoker(settings.statusLine, {
  log: (message) => debugLog(message),
});
const modelId = flag('--model') ?? statusLineSpec.modelId ?? 'claude-emulator';
const capacityTokens = statusLineSpec.capacityTokens ?? 200000;
let usedTokens = 0;
const statusLinePayload = () => {
  const payload = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    model: { id: modelId, display_name: statusLineSpec.modelDisplayName ?? modelId },
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
  if (statusLineSpec.rateLimits) {
    payload.rate_limits = Object.fromEntries(
      Object.entries(statusLineSpec.rateLimits).map(([id, window]) => [
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

// ---------------------------------------------------------------------------
// boot: SessionStart then InstructionsLoaded (the driver's boot-finished signal)
// ---------------------------------------------------------------------------
await emitEvent('SessionStart', { source: 'startup', session_title: sessionTitle });
debugLog('SessionStart done');
await emitEvent('InstructionsLoaded', {
  file_path: join(cwd, 'CLAUDE.md'),
  memory_type: 'User',
  load_reason: 'session_start',
});
debugLog('InstructionsLoaded done');
await statusLineInvoker?.invoke(statusLinePayload());
debugLog('statusline invoked');
process.stdout.write(`claude 2.1.207 (emulator) — session ${sessionId}\r\n`);

function shutdown() {
  // SessionEnd's prompt_id is the last prompt's id on real claude; the runner
  // owns uuid minting, so the stand-in emits a fresh one (shape-faithful).
  emitEvent('SessionEnd', { reason: 'other', prompt_id: crypto.randomUUID() }).finally(() => {
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------------------
// control channel (EMULATOR.md §6): register with the control plane when one
// is up; standalone otherwise. CHOPSTICKS_EMULATOR_CONTROL_STATE overrides the
// well-known state-file path (tests).
//
// This MUST complete before the stdin listeners attach: under
// ELECTRON_RUN_AS_NODE (how godview spawns script recipes), a flowing stdin
// wedges later async I/O initiation — the register fetch never resolves
// (probed 2026-08-07). Registration first keeps every runtime working.
// ---------------------------------------------------------------------------
await createEmulatorControlServer({
  vendor: 'claude',
  sessionId,
  channels: ['argv', 'hook', 'transcript', 'statusline', 'terminal'],
  palette: model.events.map((event) => ({
    event: event.event,
    fields: Object.keys(event.payloadSchema?.properties ?? {}).sort(),
  })),
  buffer: emittedLog,
  ...(process.env.CHOPSTICKS_EMULATOR_CONTROL_STATE
    ? { stateFile: process.env.CHOPSTICKS_EMULATOR_CONTROL_STATE }
    : {}),
  emit: (event, payload) => {
    const violations = validate(event, payload);
    if (violations.length > 0) {
      throw new Error(`trigger for ${event} is off-model: ${violations.join('; ')}`);
    }
    return emitEvent(event, payload);
  },
  runScenario: async (name) => {
    const scenario = JSON.parse(readFileSync(join(emulatorDir, 'scenarios', `${name}.json`), 'utf8'));
    await runner.run(scenario.then ?? [], {});
  },
  fault: (kind) => {
    if (kind === 'crash') process.exit(137);
    else if (kind === 'exit') shutdown();
    else process.stdin.removeAllListeners('data'); // hang: alive but deaf
  },
  log: (message) => {
    debugLog(`control: ${message}`);
  },
});

// ---------------------------------------------------------------------------
// terminal channel: pastes drive behavior; everything else is a stub
// ---------------------------------------------------------------------------
const decoder = createPasteDecoder((operation) => {
  if (!operation.submit) {
    process.stdout.write(`\r\n[staged] ${operation.text}\r\n`);
    return;
  }
  process.stdout.write(`\r\n> ${operation.text}\r\n`);
  runner
    .run(behavior.then, { text: operation.text })
    .then(() => {
      usedTokens += statusLineSpec.tokensPerTurn ?? 0;
      return statusLineInvoker?.invoke(statusLinePayload());
    })
    .catch((error) => {
      debugLog(`behavior failed: ${error.message}`);
    });
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => decoder.feed(chunk));
process.stdin.on('end', () => {
  decoder.flush();
  process.exit(0);
});
