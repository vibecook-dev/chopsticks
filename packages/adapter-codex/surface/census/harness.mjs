#!/usr/bin/env node
/**
 * The codex census harness (draft/EMULATOR.md §2, IMPOSTER.md §9; findings C1d).
 *
 * Drives a real `codex app-server` against a FAKE local model provider and
 * records every app-server message. No account, no network, no tokens — so the
 * census is reproducible in CI rather than being a live-credential gamble.
 *
 * Four things had to be true for this to work, all established in C1d and none
 * of them guessable:
 *
 *  1. `response.completed` must carry `usage.total_tokens`, or codex drops the
 *     stream with "failed to parse ResponseCompleted".
 *  2. `exec` is a CUSTOM tool whose input is raw JavaScript, evaluated in a V8
 *     isolate. Nested tools hang off a global `tools` object.
 *  3. `exec_command`'s `cmd` is a STRING, not an argv array. An array fails with
 *     "invalid type: sequence, expected a string" — in the LOG only, never on
 *     the protocol, which is what made this invisible for two sessions.
 *  4. Trusted commands are auto-approved even under `approvalPolicy: untrusted`,
 *     so eliciting an approval needs a non-allowlisted command (`curl`) under a
 *     `read-only` sandbox.
 *
 * Run `RUST_LOG=codex_core=debug` if a scenario goes quiet: codex reports tool
 * routing failures to its log and says nothing at all on the wire.
 *
 * usage: node harness.mjs [--out <dir>] [--scenario <name>] [--keep-raw]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_VERSION = '0.147.0';

const surfaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One provider turn. `item` is what the fake provider streams as
 * `response.output_item.done`; `null` means a plain assistant message.
 */
const assistantMessage = (turn, text = 'done') => ({
  type: 'message',
  role: 'assistant',
  id: `msg_${turn}`,
  content: [{ type: 'output_text', text }],
});

const execCall = (turn, js) => ({
  type: 'custom_tool_call',
  id: `fc_${turn}`,
  call_id: `call_${turn}`,
  status: 'completed',
  name: 'exec',
  input: js,
});

export const SCENARIOS = {
  /** The baseline arc: user message, assistant message, usage, rate limits. */
  turn: {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    prompt: 'say hello',
    items: [(turn) => assistantMessage(turn, 'hello from the fake provider')],
  },
  /** A real command execution, auto-approved because `echo` is trusted. */
  'tool-exec': {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    prompt: 'echo something',
    items: [(turn) => execCall(turn, 'await tools.exec_command({cmd: "echo hello-from-codex"})')],
  },
  /** The approval round-trip, accepted. C0 §6 #6, unobserved until 2026-08-08. */
  'approval-accept': {
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    prompt: 'fetch a page',
    reply: { decision: 'accept' },
    items: [(turn) => execCall(turn, 'await tools.exec_command({cmd: "curl -s https://example.com"})')],
  },
  /**
   * The same round-trip, denied. `decline` rather than `cancel`: both are
   * accepted, but `cancel` ends the turn while `decline` lets the agent carry
   * on, which is what "deny this command" should mean (C1d).
   */
  'approval-decline': {
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    prompt: 'fetch a page',
    reply: { decision: 'decline' },
    items: [(turn) => execCall(turn, 'await tools.exec_command({cmd: "curl -s https://example.com"})')],
  },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one scenario end to end. Returns every app-server message received, in
 * order, plus the provider request bodies (which carry the tool declarations).
 */
export async function runScenario(name, options = {}) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name} (have: ${Object.keys(SCENARIOS).join(', ')})`);

  const port = options.port ?? 8900 + Object.keys(SCENARIOS).indexOf(name);
  const home = mkdtempSync(join(tmpdir(), 'codex-census-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'codex-census-cwd-'));
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-real-key' }));

  const requestBodies = [];
  let turn = 0;
  const provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      turn += 1;
      try {
        requestBodies.push(JSON.parse(raw));
      } catch {
        // A body we cannot parse is still a turn; the census records the rest.
      }
      const item = scenario.items[turn - 1]?.(turn) ?? assistantMessage(turn);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: `resp_${turn}`, output: [] } });
      send('response.output_item.done', { output_index: 0, item });
      // total_tokens is REQUIRED — without it codex drops the whole stream.
      send('response.completed', {
        response: {
          id: `resp_${turn}`,
          usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
          output: [item],
        },
      });
      res.end();
    });
  });
  await new Promise((resolve) => provider.listen(port, '127.0.0.1', resolve));

  const child = spawn(
    options.bin ?? process.env.CHOPSTICKS_CODEX_BIN ?? 'codex',
    [
      'app-server',
      '-c', 'model_provider="fake"',
      '-c', 'model_providers.fake.name="fake"',
      '-c', `model_providers.fake.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.fake.wire_api="responses"',
      '-c', 'model_providers.fake.env_key="FAKE_KEY"',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home, FAKE_KEY: 'sk-not-a-real-key', RUST_LOG: 'codex_core=debug' },
    },
  );

  const messages = [];
  const serverRequests = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a banner line, not protocol
      }
      messages.push(message);
      // A server-initiated request has BOTH id and method. Answering is the
      // whole point of the approval scenarios.
      if (message.id !== undefined && message.method) {
        serverRequests.push(message);
        const reply = scenario.reply ?? { decision: 'accept' };
        child.stdin.write(`${JSON.stringify({ id: message.id, result: reply })}\n`);
      }
    }
  });
  let log = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (log += chunk));

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'chopsticks-census', version: '0.0.0' } } });
  await wait(1200);
  send({ method: 'initialized' });
  await wait(300);
  send({ id: 2, method: 'thread/start', params: { cwd, sandbox: scenario.sandbox, approvalPolicy: scenario.approvalPolicy } });
  await wait(1500);
  const threadId = messages.find((message) => message.method === 'thread/started')?.params?.thread?.id;
  send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: scenario.prompt }] } });
  await wait(options.turnTimeoutMs ?? 9000);

  child.kill('SIGKILL');
  await new Promise((resolve) => provider.close(resolve));
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });

  return { name, messages, serverRequests, requestBodies, log, providerTurns: turn };
}

/** Item types observed, for the coverage check the ASM's confidence rests on. */
export function observedItemTypes(messages) {
  return [
    ...new Set(
      messages
        .filter((message) => message.method === 'item/started' || message.method === 'item/completed')
        .map((message) => message.params?.item?.type)
        .filter(Boolean),
    ),
  ].sort();
}

export function observedMethods(messages) {
  return [...new Set(messages.map((message) => message.method).filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const only = flag('--scenario');
  const out = flag('--out') ?? join(surfaceRoot, 'captures-raw', `codex@${CODEX_VERSION}`);
  mkdirSync(out, { recursive: true });

  const names = only ? [only] : Object.keys(SCENARIOS);
  for (const name of names) {
    const result = await runScenario(name);
    writeFileSync(join(out, `${name}.jsonl`), `${result.messages.map((m) => JSON.stringify(m)).join('\n')}\n`);
    const routerErrors = [...result.log.matchAll(/codex_core::tools::router[^\n]*/g)].map((m) => m[0]);
    console.log(
      `${name.padEnd(18)} messages=${String(result.messages.length).padStart(3)} ` +
        `serverRequests=${result.serverRequests.length} items=[${observedItemTypes(result.messages).join(' ')}]`,
    );
    // Silence on the wire is not success; codex reports routing failures here.
    for (const error of routerErrors) console.log(`  router: ${error.replace(/\[[0-9;]*m/g, '')}`);
  }
  console.log(`\nraw captures -> ${out}`);
  console.log('These are VERBATIM and gitignored. Sanitize before committing (surface/census/sanitize.mjs).');
}
