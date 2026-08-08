/**
 * The app-server channel and the serve table (draft/IMPOSTER.md §9.3).
 *
 * These are the two things the hook family never needed: a server that answers,
 * and a state machine in front of it. Both are exercised here against a pair of
 * in-memory streams — the real transport is the adapter spawning
 * `<bin> app-server` and talking NDJSON over stdio, which the conformance
 * suite covers.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OpInvocation, Persona } from '../persona/types.ts';
import { createAppServerChannel, RpcError } from './channels/jsonrpc.ts';
import { createServeDispatcher, type ServeDocument } from './serve.ts';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

function wire(document: ServeDocument, overrides: Partial<Parameters<typeof createServeDispatcher>[0]> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Array<Record<string, unknown>> = [];
  output.setEncoding('utf8');
  let buffer = '';
  output.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) written.push(JSON.parse(line) as Record<string, unknown>);
    }
  });

  const ran: OpInvocation[] = [];
  const bindings: Record<string, unknown> = {};
  const dispatcher = createServeDispatcher({
    persona: { vendor: 'codex' } as Persona,
    document,
    bindings,
    runOps: async (invocations) => void ran.push(...invocations),
    runBehavior: async (stimulus) => void ran.push({ op: '$behavior', with: stimulus }),
    ...overrides,
  });
  const channel = createAppServerChannel({
    input,
    output,
    serve: dispatcher.serve,
    notified: dispatcher.notified,
  });
  const send = (message: Record<string, unknown>) => input.write(`${JSON.stringify(message)}\n`);
  const sendRaw = (line: string) => input.write(`${line}\n`);
  return { channel, dispatcher, send, sendRaw, written, ran, bindings };
}

const CODEX_LIKE: ServeDocument = {
  $server: { gate: { until: 'initialize', error: { code: -32600, message: 'Not initialized' } } },
  initialize: { result: { userAgent: '$vendorVersion' } },
  'thread/start': {
    bind: { $threadId: '$uuid:thread' },
    result: { thread: { id: '$threadId', status: { type: 'idle' } } },
    then: [{ op: 'session.start' }],
  },
  'turn/start': { result: {}, then: '$behavior' },
};

describe('the app-server channel', () => {
  it('omits `jsonrpc` on output, exactly as the vendor does', async () => {
    const { send, written } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    await settle();
    // Adding the field would teach the adapter that codex sends it, and mask
    // the day the adapter starts depending on it (C1b finding 5).
    expect(written[0]).toEqual({ id: 1, result: { userAgent: '$vendorVersion' } });
    expect(written[0]).not.toHaveProperty('jsonrpc');
  });

  it('ignores non-JSON banner lines rather than failing, as the vendor does', async () => {
    const { send, sendRaw, written } = wire(CODEX_LIKE);
    // The adapter's own transport skips these on the way in; the imposter has
    // to survive them on the way out for the same reason.
    sendRaw('codex-cli 0.147.0 starting up');
    sendRaw('');
    send({ id: 1, method: 'initialize', params: {} });
    await settle();
    expect(written).toEqual([{ id: 1, result: { userAgent: '$vendorVersion' } }]);
  });

  it('correlates a server request with the client reply that answers it', async () => {
    const { channel, send, written } = wire(CODEX_LIKE);
    const pending = channel.request('item/commandExecution/requestApproval', { command: 'curl' });
    await settle();
    const request = written.at(-1)!;
    expect(request.method).toBe('item/commandExecution/requestApproval');
    send({ id: request.id, result: { decision: 'decline' } });
    await expect(pending).resolves.toEqual({ decision: 'decline' });
  });

  it('rejects in-flight server requests when the client goes away', async () => {
    const { channel } = wire(CODEX_LIKE);
    const pending = channel.request('item/commandExecution/requestApproval', {});
    channel.close();
    await expect(pending).rejects.toBeInstanceOf(RpcError);
  });
});

describe('the serve table', () => {
  it('gates everything behind initialize, as codex does', async () => {
    const { send, written } = wire(CODEX_LIKE);
    send({ id: 1, method: 'thread/start', params: {} });
    await settle();
    expect(written[0]).toEqual({ id: 1, error: { code: -32600, message: 'Not initialized' } });

    send({ id: 2, method: 'initialize', params: {} });
    send({ id: 3, method: 'thread/start', params: {} });
    await settle();
    expect(written[2]).toMatchObject({ id: 3, result: { thread: { status: { type: 'idle' } } } });
  });

  it('mints an id once, so the reply and the ops that follow agree', async () => {
    const { send, written, bindings } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'thread/start', params: {} });
    await settle();
    const reply = written[1] as { result: { thread: { id: string } } };
    // Two independent `$uuid:` draws would give the client one id and the
    // notifications another, and nothing downstream would correlate.
    expect(reply.result.thread.id).toBe(bindings.$threadId);
    expect(reply.result.thread.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replies BEFORE running the ops the method schedules', async () => {
    const order: string[] = [];
    const { send, written } = wire(CODEX_LIKE, {
      runOps: async (invocations) => {
        order.push(`ops:${invocations.map((entry) => entry.op).join(',')}`);
      },
    });
    const output = written as unknown as Array<Record<string, unknown>>;
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'thread/start', params: {} });
    await settle();
    order.unshift(`reply:${output.length}`);
    // The vendor answers turn/start and only then streams the turn; an imposter
    // that emitted first would let the adapter see a turn for a thread it has
    // not been told about.
    expect(order).toEqual(['reply:2', 'ops:session.start']);
  });

  it('hands turn/start its prompt as the behaviour stimulus', async () => {
    const { send, ran } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'turn/start', params: { input: [{ type: 'text', text: 'summarise the repo' }] } });
    await settle();
    expect(ran).toEqual([{ op: '$behavior', with: { text: 'summarise the repo' } }]);
  });

  it('refuses an unserved method instead of hanging the client', async () => {
    const { send, written } = wire(CODEX_LIKE);
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'fs/readFile', params: {} });
    await settle();
    expect(written[1]).toMatchObject({ id: 2, error: { code: -32601 } });
  });

  it('turns an off-model params payload into an error reply, never a crash', async () => {
    const { send, written } = wire(CODEX_LIKE, {
      validateParams: (method) => (method === 'turn/start' ? ['field "input" is missing'] : []),
    });
    send({ id: 1, method: 'initialize', params: {} });
    send({ id: 2, method: 'turn/start', params: {} });
    await settle();
    // This is what makes the imposter a conformance test of the adapter's
    // CLIENT — something the hook family structurally cannot do (§9.3).
    expect(written[1]).toMatchObject({ id: 2, error: { code: -32602 } });
    expect((written[1] as { error: { message: string } }).error.message).toContain('input');
  });
});
