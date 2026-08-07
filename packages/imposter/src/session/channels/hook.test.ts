import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHookEmitter } from './hook.ts';

describe('createHookEmitter', () => {
  let server: Server;
  let received: Array<{ url: string; headers: unknown; body: string }>;
  let endpoint: string;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('POSTs http handlers with env-resolved bearer and the event name merged in', async () => {
    const emitter = createHookEmitter({
      settings: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'http',
                  url: endpoint,
                  headers: { Authorization: 'Bearer $CHOPSTICKS_HOOK_TOKEN', 'X-Hidden': '$UNGRANTED_SECRET' },
                  allowedEnvVars: ['CHOPSTICKS_HOOK_TOKEN'],
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
      env: { CHOPSTICKS_HOOK_TOKEN: 'sekrit', UNGRANTED_SECRET: 'must-not-leak' },
    });
    await emitter.emit('Stop', { session_id: 'abc', stop_hook_active: false });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers).toMatchObject({ authorization: 'Bearer sekrit', 'x-hidden': '$UNGRANTED_SECRET' });
    expect(JSON.parse(received[0]!.body)).toEqual({
      session_id: 'abc',
      stop_hook_active: false,
      hook_event_name: 'Stop',
    });
  });

  it('delivers the repo curl-forwarder shape as a direct POST (no sh needed)', async () => {
    const command = `sh -c 'curl -s -m 5 -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $CHOPSTICKS_HOOK_TOKEN" --data-binary @- ${endpoint}'`;
    const emitter = createHookEmitter({
      settings: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } },
      env: { CHOPSTICKS_HOOK_TOKEN: 'sekrit' },
    });
    await emitter.emit('SessionStart', { session_id: 'abc', source: 'startup' });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers).toMatchObject({ authorization: 'Bearer sekrit' });
    // The forwarder string ends with a closing quote — the URL must be
    // extracted without it (a real bridge routes strictly on the path).
    expect(received[0]!.url).toBe('/hooks');
  });

  it('drops unwired events without throwing', async () => {
    const dropped: string[] = [];
    const emitter = createHookEmitter({ settings: { hooks: {} }, env: {}, log: (m) => dropped.push(m) });
    await emitter.emit('StopFailure', { session_id: 'abc' });
    expect(received).toHaveLength(0);
    expect(dropped[0]).toContain('StopFailure');
  });

  it('can route an unknown native name through a known transport for retention tests', async () => {
    const emitter = createHookEmitter({
      settings: { hooks: { Notification: [{ hooks: [{ type: 'http', url: endpoint, headers: {} }] }] } },
      env: {},
    });
    await emitter.emit('FutureHookEvent', { future_field: true }, 'Notification');
    expect(JSON.parse(received[0]!.body)).toEqual({ future_field: true, hook_event_name: 'FutureHookEvent' });
  });

  it('serializes emissions in call order', async () => {
    const emitter = createHookEmitter({
      settings: {
        hooks: { A: [{ hooks: [{ type: 'http', url: endpoint, headers: {}, timeout: 5 }] }] },
      },
      env: {},
    });
    await emitter.emit('A', { n: 1 });
    await emitter.emit('A', { n: 2 });
    expect(received.map((r) => JSON.parse(r.body).n)).toEqual([1, 2]);
  });

  it('a rejecting bridge is logged, never thrown (IMPOSTER.md §7.3 item 6)', async () => {
    const logged: string[] = [];
    const emitter = createHookEmitter({
      settings: { hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/nope', timeout: 1 }] }] } },
      env: {},
      log: (message) => logged.push(message),
    });
    await expect(emitter.emit('Stop', { session_id: 'abc' })).resolves.toBeUndefined();
    expect(logged.join('\n')).toContain('delivery failed');
  });
});
