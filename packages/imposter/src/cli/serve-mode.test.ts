/**
 * Which fork `ai` takes comes from argv, not from the persona owning a serve
 * table (draft/IMPOSTER.md §6, §9.3).
 *
 * The real vendor works this way — `codex` opens a screen, `codex app-server`
 * speaks the protocol — and an imposter that always served would fail the most
 * visible faithfulness test there is: you could not run it by hand.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const AI = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'bin', 'ai.mjs');

const children = new Set<ChildProcess>();
const temporaries = new Set<string>();

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
  temporaries.clear();
});

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
}

function start(args: string[]): Run {
  const cwd = mkdtempSync(join(tmpdir(), 'chopsticks-serve-mode-'));
  temporaries.add(cwd);
  const child = spawn(process.execPath, [AI, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // No control plane, no token: this is the standalone mode CI runs.
    env: { ...process.env, CHOPSTICKS_IMPOSTER_HOME: cwd, CHOPSTICKS_IMPOSTER_TOKEN_FILE: join(cwd, 'absent.token') },
  });
  children.add(child);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => void (out += chunk));
  child.stderr.on('data', (chunk: string) => void (err += chunk));
  return { child, stdout: () => out, stderr: () => err };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('ai --codex', () => {
  it('runs interactively with no subcommand, and puts nothing protocol-shaped on stdout', async () => {
    const run = start(['--codex']);
    await waitFor(() => run.stdout().includes('IMPOSTER'), 'banner');

    // A prompt still drives the shared op timeline — the ops run, they simply
    // reach no wire, which is what makes this a preview rather than a session.
    run.child.stdin!.write('\x1b[200~summarise the repo\x1b[201~\r');
    // Wait for the LAST op, not the first. `turn.start` and `turn.end` are
    // separate writes; asserting the second the moment the first appears is a
    // race that only loses under load — it passed alone and failed in a full
    // parallel run (2026-08-08).
    await waitFor(() => run.stdout().includes('turn.end'), 'the whole turn');
    expect(run.stdout()).toContain('turn.start');

    // The decisive assertion: not one line of this is JSON-RPC. If serving were
    // still keyed off the persona, every line here would be protocol.
    for (const line of run.stdout().split('\n')) {
      expect(line.trimStart().startsWith('{')).toBe(false);
    }
  });

  it('reports the app-server channel as detached, because nothing is attached to it', async () => {
    const run = start(['--codex']);
    await waitFor(() => run.stdout().includes('IMPOSTER'), 'banner');
    const banner = run.stdout().split('\n')[0]!;
    expect(banner).toContain('codex');
    // The ASM calls this channel `appserver`, one word. Asserting on
    // "app-server" — the SUBCOMMAND's spelling — could never fail, which is
    // how this test passed while proving nothing (found in review).
    expect(banner).not.toContain('appserver');
    // Positive half, so the absence above means "dropped" and not "no channels
    // were ever listed": the other two are still there.
    expect(banner).toContain('argv');
    expect(banner).toContain('terminal');
  });

  it('serves the protocol when argv asks for the server subcommand', async () => {
    const run = start(['--codex', 'app-server']);
    run.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await waitFor(() => run.stdout().includes('"id":1'), 'initialize reply');
    const reply = JSON.parse(
      run
        .stdout()
        .split('\n')
        .find((line) => line.includes('"id":1'))!,
    ) as {
      result: { userAgent: string };
    };
    expect(reply.result.userAgent).toMatch(/\d+\.\d+/);
    // Presentation moved to stderr so it cannot land in the middle of NDJSON.
    expect(run.stderr()).toContain('IMPOSTER');
  });
});

describe('ai --claude', () => {
  it('is interactive with no subcommand at all, because it has no serve table', async () => {
    const run = start(['--claude']);
    await waitFor(() => run.stdout().includes('IMPOSTER'), 'banner');
    expect(run.stdout()).toContain('claude');
    // Boot ops reached the screen even with no hook settings to deliver them to.
    await waitFor(() => run.stdout().includes('session.start'), 'boot ops');
  });

  it('submits a paste whose Enter arrives late, rather than staging it forever', async () => {
    // Terminal automation commonly writes the paste and the newline separately,
    // and the decoder holds a completed paste for only 15 ms. Before the prompt
    // line kept staged text across operations, `ai --claude` in a Godview pane
    // took a prompt, showed it staged, and never ran a turn.
    const run = start(['--claude']);
    await waitFor(() => run.stdout().includes('session.start'), 'boot ops');

    run.child.stdin!.write('\x1b[200~a late prompt\x1b[201~');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(run.stdout(), 'nothing should run before Enter').not.toContain('turn.start');

    run.child.stdin!.write('\r');
    await waitFor(() => run.stdout().includes('turn.start'), 'turn from the late Enter');
    expect(run.stdout()).toContain('"a late prompt"');
  });

  it('ignores a stray Enter when nothing is staged', async () => {
    const run = start(['--claude']);
    await waitFor(() => run.stdout().includes('session.start'), 'boot ops');
    run.child.stdin!.write('\r\n\r');
    await new Promise((resolve) => setTimeout(resolve, 250));
    // An empty prompt is not a turn; a vendor would not run one either.
    expect(run.stdout()).not.toContain('turn.start');
  });
});
