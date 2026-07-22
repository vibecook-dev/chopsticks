import { rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createUnixWebSocketTapProxy } from './ws-transport.js';

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  if (payload.length >= 126) throw new Error('test frame is too large');
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
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
    const sent = Buffer.concat([
      Buffer.from('GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'),
      maskedTextFrame(message),
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
