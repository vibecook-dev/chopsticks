import { rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createUnixWebSocketTapProxy, wsOverUnixTransport } from './ws-transport.js';

function frame(opcode: number, payload: Buffer, options: { fin?: boolean; masked?: boolean } = {}): Buffer {
  const fin = options.fin ?? true;
  const maskedFrame = options.masked ?? false;
  const mask = Buffer.from([1, 2, 3, 4]);
  if (payload.length >= 126) throw new Error('test frame is too large');
  const first = (fin ? 0x80 : 0) | opcode;
  if (!maskedFrame) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from([first, 0x80 | payload.length]), mask, masked]);
}

describe('createUnixWebSocketTapProxy', () => {
  it('forwards bytes unchanged while observing a masked TUI thread/resume request', async () => {
    const upstreamPath = join(realpathSync(tmpdir()), `cx-up-${process.pid}.sock`);
    const upstreamBytes: Buffer[] = [];
    const upstream = createServer((socket) => socket.on('data', (chunk) => upstreamBytes.push(chunk)));
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(upstreamPath, resolve);
    });
    const observed: unknown[] = [];
    const tap = createUnixWebSocketTapProxy(upstreamPath, (message) => observed.push(message));
    await tap.ready();
    const client = createConnection(tap.socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const message = JSON.stringify({ method: 'thread/resume', params: { threadId: 'thread-from-picker' } });
    const midpoint = Math.floor(message.length / 2);
    const sent = Buffer.concat([
      Buffer.from('GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
      frame(0x1, Buffer.from(message.slice(0, midpoint)), { fin: false, masked: true }),
      frame(0x0, Buffer.from(message.slice(midpoint)), { masked: true }),
    ]);
    client.write(sent);

    await vi.waitFor(() => expect(observed).toEqual([JSON.parse(message)]));
    await vi.waitFor(() => expect(Buffer.concat(upstreamBytes)).toEqual(sent));

    client.destroy();
    tap.dispose();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(upstreamPath, { force: true });
  });
});

describe('wsOverUnixTransport', () => {
  it('reassembles fragmented app-server responses before parsing JSON', async () => {
    const socketPath = join(realpathSync(tmpdir()), `cx-fragmented-${process.pid}.sock`);
    const message = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    const midpoint = Math.floor(message.length / 2);
    const server = createServer((socket) => {
      let request = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        request = Buffer.concat([request, chunk]);
        if (!request.includes('\r\n\r\n')) return;
        socket.write(
          Buffer.concat([
            Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
            frame(0x1, Buffer.from(message.slice(0, midpoint)), { fin: false }),
            frame(0x0, Buffer.from(message.slice(midpoint))),
          ]),
        );
        request = Buffer.alloc(0);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    const transport = wsOverUnixTransport(socketPath);
    const observed: unknown[] = [];
    transport.onMessage((value) => observed.push(value));
    await vi.waitFor(() => expect(observed).toEqual([JSON.parse(message)]));

    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  });
});
