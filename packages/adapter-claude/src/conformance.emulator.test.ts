/**
 * Emulator-mode conformance (draft/EMULATOR.md §10 P2): the SAME shared suite
 * as conformance.test.ts, but events originate from a real emulator
 * subprocess (surface/emulator/bin.mjs) instead of test-code POSTs. This
 * exercises the full chain hermetically: settings generation → settings
 * parsing → real HTTP hooks → normalizer → reducer, plus guarded-paste prompt
 * confirmation and the spaghetti-SDK transcript tail — no claude binary, no
 * tokens.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { runAgentSessionConformance, type AgentSessionHarness } from '@vibecook/chopsticks-testing/conformance';
import { getClaudeStatusLineAccountUsage } from './account-usage.js';
import { createClaudeSession, type ClaudeSession } from './driver.js';
import type { PreparedClaudeSession } from './prepare.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const BIN = join(here, '..', 'surface', 'emulator', 'bin.mjs');
const BEHAVIOR = JSON.parse(
  readFileSync(join(here, '..', 'surface', 'emulator', 'behavior', 'happy-turn.json'), 'utf8'),
) as {
  reply: string;
  statusLine: { modelId: string; capacityTokens: number; tokensPerTurn: number };
};

const children = new Set<ChildProcess>();
const homes = new Set<string>();

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface EmulatorHarness extends AgentSessionHarness {
  session: ClaudeSession;
  child: ChildProcess;
  emulatorHome: string;
  cwd: string;
}

/** Drive a live ClaudeSession backed by the emulator bin as a real subprocess. */
async function emulatorHarness(): Promise<EmulatorHarness> {
  const cwd = mkdtempSync(join(tmpdir(), 'chopsticks-emulator-cwd-'));
  const emulatorHome = mkdtempSync(join(tmpdir(), 'chopsticks-emulator-home-'));
  homes.add(emulatorHome);
  let child: ChildProcess | undefined;

  const session = await createClaudeSession({
    cwd,
    title: 'conformance-emulator',
    executable: BIN,
    transcriptPollIntervalMs: 50,
    ports: {
      spawn: async (prepared: PreparedClaudeSession) => {
        // The recipe is self-contained (script executables are wrapped with
        // node by prepare), so spawn it exactly as built.
        child = spawn(prepared.command, prepared.args, {
          cwd: prepared.cwd,
          env: { ...process.env, ...prepared.env, CHOPSTICKS_EMULATOR_CLAUDE_HOME: emulatorHome },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        children.add(child);
        return { runtimeSessionId: 'rt-emulator-conformance' };
      },
      automate: async (_runtimeSessionId, operation) => {
        if (!child) return { accepted: false, reason: 'no emulator process' };
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

  await waitFor(() => session.state().lifecycle === 'ready', 'emulator boot (SessionStart hook)');
  const harness: EmulatorHarness = {
    session,
    child: child!,
    emulatorHome,
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
  return harness;
}

runAgentSessionConformance('claude-emulator', emulatorHarness);

describe('claude emulator channels', () => {
  it('reaches native-hooks observation with no test-code hooks', async () => {
    const harness = await emulatorHarness();
    try {
      expect(harness.session.observationLevel()).toBe('native-hooks');
    } finally {
      await harness.session.dispose();
    }
  });

  it('delivers transcript-sourced assistant messages and keeps the transcript in the emulator home', async () => {
    const harness = await emulatorHarness();
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
      expect(fromTranscript.event.type).toBe('assistant.message');
      if (fromTranscript.event.type === 'assistant.message') {
        expect(fromTranscript.event.displayOnly).toBe(false);
        expect(fromTranscript.event.text).toBe(BEHAVIOR.reply);
      }
      const transcriptPath = harness.session.transcriptPath();
      expect(transcriptPath).toBeDefined();
      expect(transcriptPath!.startsWith(harness.emulatorHome)).toBe(true);
      expect(transcriptPath).not.toContain('.claude');
    } finally {
      await harness.session.dispose();
    }
  });

  it('reports statusline telemetry: known-empty window at boot, usage after a turn', async () => {
    const harness = await emulatorHarness();
    try {
      // Boot statusline payload: model + cwd environment, 0-of-capacity window.
      await waitFor(() => harness.session.state().contextWindow !== undefined, 'boot context-window telemetry');
      const boot = harness.session.state();
      expect(boot.contextWindow).toMatchObject({
        usedTokens: 0,
        capacityTokens: BEHAVIOR.statusLine.capacityTokens,
        modelId: BEHAVIOR.statusLine.modelId,
      });
      expect(boot.environment.model?.value.id).toBe(BEHAVIOR.statusLine.modelId);
      expect(boot.environment.currentCwd?.value).toBe(harness.cwd);

      await harness.driveTurn('burn some tokens');
      await waitFor(
        () => harness.session.state().contextWindow?.usedTokens === BEHAVIOR.statusLine.tokensPerTurn,
        'post-turn context-window telemetry',
      );

      // The statusline rate_limits block feeds the account-wide usage channel
      // (godview's usage panel) — process-global, not session state.
      const usage = getClaudeStatusLineAccountUsage();
      expect(usage?.status).toBe('available');
      const subscription = usage?.snapshot.limits.find((limit) => limit.id === 'claude-subscription');
      const fiveHour = subscription?.windows?.find((window) => window.id === 'five_hour');
      expect(fiveHour).toMatchObject({ usedPercent: 12 });
    } finally {
      await harness.session.dispose();
    }
  });
});
