/**
 * Phase I2's exit criterion (draft/IMPOSTER.md §8): the codex family, driven by
 * the REAL `adapter-codex` driver against `ai --codex app-server` as a spawned
 * process. No codex binary, no account, no tokens.
 *
 * This is the claim §2 makes and §8 schedules the two families together to
 * test: that one op vocabulary and one timeline serve a hook vendor and a
 * JSON-RPC vendor, with only the TRIGGER differing. Everything here goes
 * through `session.turn` → the same ops → the same timeline that claude uses;
 * what changed is that the turn is started by an inbound RPC rather than by
 * bytes on stdin.
 *
 * Note what codex does NOT have: a boot-ready signal. `personas/codex/ops.json`
 * deliberately leaves `session.ready` unbound, because the real vendor has no
 * notification for it — the reducer reaches `ready` on the first
 * `turn/completed`. An imposter that invented one would be teaching the adapter
 * something the vendor never says.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { createCodexSession, type CodexSession } from '@vibecook/chopsticks-adapter-codex';

const AI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai.mjs');

const children = new Set<ChildProcess>();
const temporaries = new Set<string>();
let session: CodexSession | undefined;

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

const removeDirectory = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch (error) {
    // Windows can hold a directory handle open after the process that owned it
    // is gone, and the adapter spawns processes this file never sees. A leaked
    // temp directory is the OS's problem; failing a test that already made its
    // assertions, over cleanup, would be reporting the wrong thing.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error;
  }
};

afterEach(async () => {
  await session?.dispose().catch(() => undefined);
  session = undefined;
  await Promise.all([...children].map(reap));
  children.clear();
  for (const path of temporaries) removeDirectory(path);
  temporaries.clear();
});

// 15 s, not 5 or 8: what these wait for is a spawned `ai` reaching a milestone
// through a real adapter, and a CI runner executing several package suites at
// once is far slower than a laptop doing one. Kept UNDER the suite's 20 s
// testTimeout on purpose, so this deadline fires first and says which milestone
// was missed rather than leaving vitest to report a bare timeout (2026-08-09).
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Started {
  session: CodexSession;
  events: AgentEventEnvelope[];
  /** Approval decisions the adapter was asked for, in order. */
  approvals: string[];
}

/** Spawn `ai --codex app-server` and drive it with the real adapter. */
async function imposterSession(
  decision: 'approved' | 'denied' = 'approved',
  behavior = 'happy-turn',
): Promise<Started> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'chopsticks-codex-imposter-')));
  temporaries.add(cwd);

  // The adapter's own transport, pointed at `ai`: it appends `app-server` and
  // speaks NDJSON over stdio, exactly as it does to the real binary.
  const child = spawn(process.execPath, [AI, '--codex', 'app-server', '--behavior', behavior], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHOPSTICKS_IMPOSTER_HOME: cwd },
  });
  children.add(child);

  const transport = {
    send: (message: unknown) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (handler: (message: unknown) => void) => {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try {
            handler(JSON.parse(line));
          } catch {
            // Banner lines are not protocol, exactly as the real transport says.
          }
        }
      });
    },
    onClose: (handler: (info: { code: number | null; signal: string | null }) => void) => {
      child.on('exit', (code, signal) => handler({ code, signal }));
    },
    close: () => child.kill('SIGKILL'),
  };

  const approvals: string[] = [];
  const live = await createCodexSession({
    cwd,
    transport,
    onApproval: async ({ method }) => {
      approvals.push(method);
      return decision;
    },
  });
  const events: AgentEventEnvelope[] = [];
  live.onEvent((envelope) => events.push(envelope));
  return { session: live, events, approvals };
}

describe('the codex imposter, driven by the real adapter', () => {
  it('serves thread/start and reports the session it created', async () => {
    const started = await imposterSession();
    session = started.session;
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(
      () => started.events.some((envelope) => envelope.event.type === 'session.started'),
      'session.started',
    );
  });

  it('runs a whole turn through the ops the claude persona also uses', async () => {
    const started = await imposterSession();
    session = started.session;
    await waitFor(() => started.events.some((e) => e.event.type === 'session.started'), 'session.started');

    const receipt = await session.submitPrompt({ text: 'summarise the repo' });
    // A structured driver confirms deterministically — no `uncertain` here, and
    // that difference from claude's guarded paste is the point of §2.1.
    expect(receipt.status).toBe('confirmed');

    await waitFor(() => started.events.some((e) => e.event.type === 'turn.completed'), 'turn.completed');
    const types = started.events.map((envelope) => envelope.event.type);
    expect(types).toContain('turn.started');
    expect(types).toContain('assistant.message');
    expect(types).toContain('turn.completed');

    // The reducer reaches `ready` on turn.completed, because codex has no
    // boot-ready notification and the persona does not invent one.
    expect(session.state().lifecycle).toBe('ready');
    expect(session.state().lastAssistantMessage).toBe('imposter: ok');
  });

  it('completes an approval round-trip when the client allows it', async () => {
    // The gap that stayed open from 2026-07-13 to now: an imposter that ISSUES
    // a server request, an adapter that answers it, and a turn that continues
    // past the answer. `await: true` on the binding is what suspends the op.
    const started = await imposterSession('approved', 'approval-turn');
    session = started.session;
    await waitFor(() => started.events.some((e) => e.event.type === 'session.started'), 'session.started');

    await session.submitPrompt({ text: 'fetch a page' });
    await waitFor(() => started.events.some((e) => e.event.type === 'turn.completed'), 'turn.completed');

    expect(started.approvals).toEqual(['item/commandExecution/requestApproval']);
    const outcomes = started.events
      .filter((envelope) => envelope.event.type === 'permission.resolved')
      .map((envelope) => (envelope.event as { outcome: string }).outcome);
    expect(outcomes).toEqual(['allowed']);
    // The turn ran ON past the approval, which is the whole point of awaiting.
    expect(session.state().lastAssistantMessage).toBe('imposter: command finished');
  });

  it('completes the same round-trip when the client denies it', async () => {
    const started = await imposterSession('denied', 'approval-turn');
    session = started.session;
    await waitFor(() => started.events.some((e) => e.event.type === 'session.started'), 'session.started');

    await session.submitPrompt({ text: 'fetch a page' });
    await waitFor(() => started.events.some((e) => e.event.type === 'turn.completed'), 'turn.completed');

    const outcomes = started.events
      .filter((envelope) => envelope.event.type === 'permission.resolved')
      .map((envelope) => (envelope.event as { outcome: string }).outcome);
    // `decline` rather than `cancel`: both are accepted by the real vendor, but
    // cancel ends the turn and decline lets the agent continue (findings C1d).
    expect(outcomes).toEqual(['denied']);
    expect(session.state().lifecycle).toBe('ready');
  });

  it('keeps the reply ahead of the notifications it triggers', async () => {
    // The vendor answers `thread/start` and only then announces the thread. An
    // imposter that emitted first would hand the adapter a `thread/started` for
    // a thread it had not been told about — which is exactly what happened
    // before `then` moved from a microtask to `setImmediate`.
    const started = await imposterSession();
    session = started.session;
    await waitFor(() => started.events.some((e) => e.event.type === 'session.started'), 'session.started');
    const sessionStarted = started.events.find((e) => e.event.type === 'session.started')!;
    expect(sessionStarted.event.type === 'session.started' && sessionStarted.event.nativeSessionId).toBe(
      session.sessionId,
    );
  });
});
