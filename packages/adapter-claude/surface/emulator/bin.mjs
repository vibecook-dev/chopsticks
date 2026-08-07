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
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validatePayload } from '@vibecook/chopsticks-surface';
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
const modelDirectories = readdirSync(join(surface, 'model'), { withFileTypes: true }).filter(
  (entry) => entry.isDirectory() && entry.name.startsWith('claude@'),
);
if (modelDirectories.length !== 1) {
  throw new Error(`claude-emulator: expected exactly one claude ASM, found ${modelDirectories.length}`);
}
const model = loadModel(join(surface, 'model', modelDirectories[0].name));
const vendorVersion = model.manifest.vendorVersion;
const detection = model.detection;

// ---------------------------------------------------------------------------
// argv — the subset of claude's surface the adapter's launch recipe uses
// (detection.json keeps the probed-flag list honest)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (...names) => {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index >= 0) return argv[index + 1];
  }
  return undefined;
};
const probedFlags = {
  ...(detection.launchFlags && typeof detection.launchFlags === 'object' ? detection.launchFlags : {}),
  ...(detection.probedFlags && typeof detection.probedFlags === 'object' ? detection.probedFlags : {}),
};
const detectedFlags = (key, fallback) => {
  const raw = probedFlags[key];
  return (typeof raw === 'string' ? raw : fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};
const versionFlag = typeof detection.versionFlag === 'string' ? detection.versionFlag : '--version';
const helpFlag = typeof detection.helpFlag === 'string' ? detection.helpFlag : '--help';

if (argv.includes(versionFlag)) {
  console.log(typeof detection.versionOutput === 'string' ? detection.versionOutput : `${vendorVersion} (Claude Code)`);
  process.exit(0);
}
if (argv.includes(helpFlag)) {
  console.log(
    `Usage: claude [${detectedFlags('sessionId', '--session-id').at(-1)} <uuid> | ${detectedFlags('resume', '--resume').at(-1)} <uuid>] ` +
      `[${detectedFlags('settings', '--settings').at(-1)} <path>]`,
  );
  console.log(`  ${detectedFlags('name', '-n, --name').join(', ')} <title>        session title`);
  console.log(`      ${detectedFlags('permissionMode', '--permission-mode').at(-1)} <m> default | plan | ...`);
  console.log('      --model <model>       model alias or id');
  console.log('      (emulator) --scenario <name> runs surface/emulator/scenarios/<name>.json on first paste');
  process.exit(0);
}

const sessionId =
  flag(...detectedFlags('sessionId', '--session-id')) ??
  flag(...detectedFlags('resume', '--resume')) ??
  crypto.randomUUID();
const settingsPath = flag(...detectedFlags('settings', '--settings'));
if (!settingsPath) {
  console.error('claude-emulator: --settings is required');
  process.exit(2);
}
const sessionTitle = flag(...detectedFlags('name', '--name')) ?? 'emulator-session';
const permissionMode = flag(...detectedFlags('permissionMode', '--permission-mode')) ?? 'default';
const cwd = process.cwd();

const configuredTranscriptRoot = process.env.CHOPSTICKS_EMULATOR_CLAUDE_HOME;
const transcriptRoot = configuredTranscriptRoot ?? mkdtempSync(join(tmpdir(), 'chopsticks-emulator-claude-'));
if (!configuredTranscriptRoot) {
  process.once('exit', () => rmSync(transcriptRoot, { recursive: true, force: true }));
}
const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
const transcriptPath = join(transcriptRoot, 'projects', slug, `${sessionId}.jsonl`);

// Debug trace: the bin runs under PTYs where stderr is hard to observe, so
// boot milestones land in an append-only log next to the transcripts.
const debugLog = (message) => {
  try {
    appendFileSync(
      join(transcriptRoot, 'emulator-debug.log'),
      `${new Date().toISOString()} ${process.pid} ${message}\n`,
    );
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
let emittedLogBytes = 0;
let emittedSequence = 0;
const recordEmission = (entry) => {
  emittedSequence += 1;
  let recorded = { at: new Date().toISOString(), sequence: emittedSequence, ...entry };
  let bytes = Buffer.byteLength(JSON.stringify(recorded));
  if (bytes > 64 * 1024) {
    recorded = { at: recorded.at, sequence: recorded.sequence, event: recorded.event, truncated: true };
    bytes = Buffer.byteLength(JSON.stringify(recorded));
  }
  emittedLog.push(recorded);
  emittedLogBytes += bytes;
  while (emittedLog.length > 500 || emittedLogBytes > 2 * 1024 * 1024) {
    emittedLogBytes -= Buffer.byteLength(JSON.stringify(emittedLog.shift()));
  }
};
const droppedChannels = new Set();
const fallbackHookRoute = model.events.find((event) => (settings.hooks?.[event.event]?.length ?? 0) > 0)?.event;
const emitEvent = (event, payload) => {
  const wirePayload = { ...envelope(payload), hook_event_name: event };
  recordEmission({ event, payload: wirePayload });
  if (droppedChannels.has('hook')) {
    debugLog(`dropped ${event}: hook channel is disconnected`);
    return Promise.resolve();
  }
  return hookEmitter.emit(event, wirePayload, schemaByEvent.has(event) ? event : fallbackHookRoute);
};

// Validate exactly what will hit the wire: envelope fields merged, plus the
// hook_event_name the emitter appends.
const validate = (event, payload) => {
  const schema = schemaByEvent.get(event);
  return schema ? validatePayload(schema, { ...envelope(payload), hook_event_name: event }) : [];
};

const safeScenarioName = (name) => {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(name)) {
    throw new Error('scenario name must contain only letters, numbers, and hyphens');
  }
  return name;
};
const behaviorName = flag('--scenario');
const behaviorPath = behaviorName
  ? join(emulatorDir, 'scenarios', `${safeScenarioName(behaviorName)}.json`)
  : join(emulatorDir, 'behavior', 'happy-turn.json');
const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8'));
const scenarioSteps = (document) => {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('scenario must be a JSON object');
  }
  const steps = Array.isArray(document.steps) ? document.steps : document.then;
  if (!Array.isArray(steps)) throw new Error('scenario must contain a steps or then array');
  return steps;
};

const scenarioTranscript = {
  path: transcript.path,
  append: (record) => {
    if (droppedChannels.has('transcript')) return debugLog('dropped transcript record: channel is disconnected');
    transcript.append(record);
  },
  appendPartial: (fragment) => {
    if (droppedChannels.has('transcript')) return debugLog('dropped transcript fragment: channel is disconnected');
    transcript.appendPartial(fragment);
  },
};

// ---------------------------------------------------------------------------
// statusline channel: the vendor invokes the configured command with session
// JSON on stdin. Cadence here: once at boot (known-empty window), then after
// each turn with cumulative fake usage (behavior-pack data).
// ---------------------------------------------------------------------------
const statusLineSpec = behavior.statusLine ?? {};
const statusLineInvoker = createStatusLineInvoker(settings.statusLine, {
  log: (message) => debugLog(message),
});
const invokeStatusLine = (payload) => {
  if (droppedChannels.has('statusline')) {
    debugLog('dropped statusline payload: channel is disconnected');
    return Promise.resolve();
  }
  return statusLineInvoker?.invoke(payload) ?? Promise.resolve();
};
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

async function applyFault(request) {
  if (request.kind === 'crash') {
    setImmediate(() => process.exit(request.exitCode ?? 137));
    return;
  }
  if (request.kind === 'exit') {
    setImmediate(() => void shutdown());
    return;
  }
  if (request.kind === 'hang') {
    process.stdin.pause();
    return;
  }
  if (request.kind === 'channel-drop') {
    droppedChannels.add(request.channel ?? 'hook');
    return;
  }
  const event = request.event ?? 'Notification';
  const payload = request.with ?? {
    message: 'emulator flood',
    notification_type: 'emulator-flood',
    prompt_id: crypto.randomUUID(),
  };
  const violations = validate(event, payload);
  if (violations.length > 0) throw new Error(`flood payload for ${event} is off-model: ${violations.join('; ')}`);
  for (let index = 0; index < (request.count ?? 100); index += 1) await emitEvent(event, payload);
}

const runner = createScenarioRunner({
  emit: emitEvent,
  transcript: scenarioTranscript,
  statusline: invokeStatusLine,
  fault: applyFault,
  validate,
  bindings: {
    $sessionTitle: sessionTitle,
    $permissionMode: permissionMode,
    $sessionId: sessionId,
    $transcriptPath: transcriptPath,
    $cwd: cwd,
    $vendorVersion: vendorVersion,
    $modelId: modelId,
    $capacityTokens: capacityTokens,
    ...(behavior.reply ? { $reply: behavior.reply } : {}),
  },
  log: (message) => debugLog(message),
});

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
await invokeStatusLine(statusLinePayload());
debugLog('statusline invoked');
process.stdout.write(`claude ${vendorVersion} (emulator) — session ${sessionId}\r\n`);

let control;
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // SessionEnd's prompt_id is the last prompt's id on real claude; the runner
  // owns uuid minting, so the stand-in emits a fresh one (shape-faithful).
  await emitEvent('SessionEnd', { reason: 'other', prompt_id: crypto.randomUUID() }).catch((error) =>
    debugLog(`SessionEnd failed: ${error.message}`),
  );
  await control?.close().catch(() => undefined);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

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
control = await createEmulatorControlServer({
  vendor: 'claude',
  sessionId,
  channels: ['argv', 'hook', 'transcript', 'statusline', 'terminal'],
  channelState: () =>
    ['argv', 'hook', 'transcript', 'statusline', 'terminal'].filter((channel) => !droppedChannels.has(channel)),
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
  runScenario: async (request) => {
    const mode = request.mode ?? 'play';
    if (mode !== 'play') throw new Error(`scenario mode ${mode} is not implemented yet; use play`);
    const scenario =
      request.script ??
      JSON.parse(readFileSync(join(emulatorDir, 'scenarios', `${safeScenarioName(request.name)}.json`), 'utf8'));
    await runner.run(scenarioSteps(scenario), request.stimulus ?? {}, { speed: request.speed ?? 1 });
  },
  fault: applyFault,
  log: (message) => {
    debugLog(`control: ${message}`);
  },
});

// ---------------------------------------------------------------------------
// terminal channel: pastes drive behavior; everything else is a stub
// ---------------------------------------------------------------------------
const decoder = createPasteDecoder((operation) => {
  if (droppedChannels.has('terminal')) {
    debugLog('dropped terminal paste: channel is disconnected');
    return;
  }
  if (!operation.submit) {
    process.stdout.write(`\r\n[staged] ${operation.text}\r\n`);
    return;
  }
  process.stdout.write(`\r\n> ${operation.text}\r\n`);
  runner
    .run(scenarioSteps(behavior), { text: operation.text })
    .then(() => {
      usedTokens += statusLineSpec.tokensPerTurn ?? 0;
      return invokeStatusLine(statusLinePayload());
    })
    .catch((error) => {
      debugLog(`behavior failed: ${error.message}`);
    });
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => decoder.feed(chunk));
process.stdin.on('end', () => {
  decoder.flush();
  void shutdown();
});
