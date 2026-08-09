/**
 * Phase I1 exit criterion (draft/IMPOSTER.md §8): the SHARED conformance suite,
 * green against `ai` instead of the PoC's per-adapter `bin.mjs`.
 *
 * This runs the whole chain hermetically — settings generation → settings
 * parsing → real HTTP hooks → normalizer → reducer, plus guarded-paste prompt
 * confirmation and the spaghetti-SDK transcript tail — with no claude binary
 * and no tokens. It is the pipe-and-no-socket path from §4.2, which is exactly
 * what CI runs, so headless has to be first-class rather than a fallback.
 *
 * It lives in the imposter package because the imposter already devDepends on
 * the adapter (to resolve its ASM); putting it in the adapter would close a
 * workspace dependency cycle.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { createClaudeSession, type ClaudeSession } from '@vibecook/chopsticks-adapter-claude';
import { runAgentSessionConformance, type AgentSessionHarness } from '@vibecook/chopsticks-testing/conformance';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const AI = join(packageRoot, 'bin', 'ai.mjs');
const BEHAVIOR = JSON.parse(
  readFileSync(join(packageRoot, 'personas', 'claude', 'behavior', 'happy-turn.json'), 'utf8'),
) as { reply: string; statusLine: { modelId: string; capacityTokens: number; tokensPerTurn: number } };

const children = new Set<ChildProcess>();
const temporaries = new Set<string>();

/**
 * Windows refuses to remove a directory that is a live process's cwd, and
 * `kill()` returns before the process is actually gone — so tearing down a
 * spawned `ai` and deleting its cwd in the same tick raced, and CI reported
 * `EBUSY: rmdir` (2026-08-09). Wait for the exit, then retry the removal.
 */
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    child.once('exit', done);
    setTimeout(done, 2000).unref?.();
  });
}

const removeDirectory = (path: string): void =>
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

afterEach(async () => {
  await Promise.all([...children].map(reap));
  children.clear();
  for (const path of temporaries) removeDirectory(path);
  temporaries.clear();
});

function temporaryDirectory(prefix: string): string {
  // macOS exposes /var through /private/var; the child reports its canonical
  // process.cwd(), so canonicalize the test contract too.
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaries.add(path);
  return path;
}

// 15 s, not 5 or 8: what these wait for is a spawned `ai` reaching a milestone
// through a real adapter, and a CI runner executing several package suites at
// once is far slower than a laptop doing one. Kept UNDER the suite's 20 s
// testTimeout on purpose, so this deadline fires first and says which milestone
// was missed rather than leaving vitest to report a bare timeout (2026-08-09).
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface ImposterHarness extends AgentSessionHarness {
  session: ClaudeSession;
  imposterHome: string;
  cwd: string;
}

/**
 * Drive a live ClaudeSession backed by `ai` as a real subprocess.
 *
 * Persona selection is via AI_PERSONA here rather than an argv0 shim, because
 * symlinks need privileges on Windows and this suite is the cross-platform CI
 * lane. The shim path — the one godview actually uses — is asserted separately
 * below.
 */
async function imposterHarness(): Promise<ImposterHarness> {
  const cwd = temporaryDirectory('chopsticks-imposter-cwd-');
  const imposterHome = temporaryDirectory('chopsticks-imposter-home-');
  let child: ChildProcess | undefined;

  const session = await createClaudeSession({
    cwd,
    title: 'conformance-imposter',
    executable: AI,
    transcriptPollIntervalMs: 50,
    ports: {
      spawn: async (prepared) => {
        // prepare() wraps script executables with node, so the recipe is
        // self-contained; spawn it exactly as built.
        child = spawn(prepared.command, prepared.args, {
          cwd: prepared.cwd,
          env: { ...process.env, ...prepared.env, AI_PERSONA: 'claude', CHOPSTICKS_IMPOSTER_HOME: imposterHome },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        children.add(child);
        return { runtimeSessionId: 'rt-imposter-conformance' };
      },
      automate: async (_runtimeSessionId, operation) => {
        if (!child) return { accepted: false, reason: 'no imposter process' };
        if (operation.kind === 'paste') {
          child.stdin!.write(`\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`);
        } else if (operation.kind === 'text') {
          child.stdin!.write(operation.text);
        } else {
          child.stdin!.write('\x03');
        }
        return { accepted: true };
      },
    },
  });

  await waitFor(() => session.state().lifecycle === 'ready', 'imposter boot (SessionStart + InstructionsLoaded)');
  return {
    session,
    imposterHome,
    cwd,
    reply: BEHAVIOR.reply,
    driveTurn: async (prompt) => {
      const completed = new Promise<void>((resolve, reject) => {
        const off = session.onEvent((envelope: AgentEventEnvelope) => {
          if (envelope.event.type === 'turn.completed') {
            off();
            resolve();
          }
        });
        setTimeout(() => {
          off();
          reject(new Error('timed out waiting for turn.completed'));
        }, 5000);
      });
      const receipt = await session.submitPrompt({ text: prompt });
      if (receipt.status !== 'confirmed') {
        throw new Error(`expected confirmed prompt receipt, got ${receipt.status}: ${receipt.reason ?? ''}`);
      }
      await completed;
    },
  };
}

runAgentSessionConformance('claude-imposter', imposterHarness);

describe('claude imposter channels', () => {
  it('reaches native-hooks observation with no test-code hooks', async () => {
    const harness = await imposterHarness();
    try {
      expect(harness.session.observationLevel()).toBe('native-hooks');
    } finally {
      await harness.session.dispose();
    }
  });

  it('delivers transcript-sourced assistant messages, kept out of the real ~/.claude', async () => {
    const harness = await imposterHarness();
    const messages: AgentEventEnvelope[] = [];
    harness.session.onEvent((envelope) => {
      if (envelope.event.type === 'assistant.message') messages.push(envelope);
    });
    try {
      await harness.driveTurn('where does the transcript live?');
      await waitFor(
        () => messages.some((envelope) => envelope.source === 'native-transcript'),
        'transcript-sourced assistant.message',
      );
      const fromTranscript = messages.find((envelope) => envelope.source === 'native-transcript')!;
      if (fromTranscript.event.type === 'assistant.message') {
        expect(fromTranscript.event.displayOnly).toBe(false);
        expect(fromTranscript.event.text).toBe(BEHAVIOR.reply);
      }
      const transcriptPath = harness.session.transcriptPath();
      expect(transcriptPath!.startsWith(harness.imposterHome)).toBe(true);
      expect(transcriptPath).not.toContain('.claude');
    } finally {
      await harness.session.dispose();
    }
  });

  it('reports statusline telemetry: known-empty window at boot, usage after a turn', async () => {
    const harness = await imposterHarness();
    try {
      await waitFor(() => harness.session.state().contextWindow !== undefined, 'boot context-window telemetry');
      expect(harness.session.state().contextWindow).toMatchObject({
        usedTokens: 0,
        capacityTokens: BEHAVIOR.statusLine.capacityTokens,
        modelId: BEHAVIOR.statusLine.modelId,
      });
      expect(harness.session.state().environment.currentCwd?.value).toBe(harness.cwd);

      await harness.driveTurn('burn some tokens');
      await waitFor(
        () => harness.session.state().contextWindow?.usedTokens === BEHAVIOR.statusLine.tokensPerTurn,
        'post-turn context-window telemetry',
      );
    } finally {
      await harness.session.dispose();
    }
  });
});

describe.skipIf(process.platform === 'win32')('argv0 shim dispatch', () => {
  it('selects the persona from the shim name, so godview needs no changes (§6)', async () => {
    const shims = temporaryDirectory('chopsticks-imposter-shims-');
    const shim = join(shims, 'claude');
    symlinkSync(AI, shim);
    chmodSync(AI, 0o755);

    // Spawned as a plain binary with NO --claude flag and NO AI_PERSONA: the
    // only signal is argv0, which is exactly how the adapter's launch recipe
    // will reach the imposter on a shimmed PATH.
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(shim, ['--version'], { stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout!.on('data', (chunk) => (stdout += chunk));
      child.once('error', reject);
      child.once('close', () => resolve(stdout.trim()));
    });
    expect(output).toBe('2.1.207 (Claude Code)');
  });
});
