/**
 * WebSocket-over-UDS transport for the Codex app-server (M5 C6).
 *
 * The app-server's socket transports (unix AND tcp) frame JSON-RPC as
 * WebSocket; only stdio:// is NDJSON (CODEX-SURFACE-FINDINGS §8). For the
 * workbench we run one `codex app-server --listen unix://<sock>` and connect a
 * controller over it — UDS is preferred (no port, filesystem-scoped, not
 * network-exposed). Node's built-in WebSocket is TCP-only, so this is a small
 * hand-rolled WS client (handshake + RFC-6455 framing) exposed as a `Transport`,
 * so `createCodexSession` drives it unchanged via the injected-transport seam.
 *
 * Localhost/UDS needs no auth token (the bearer is for remote/pairing).
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from './app-server-client.js';

// ─── RFC 6455 framing ──────────────────────────────────────────────────────

const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CONTINUATION = 0x0;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** Encode a client frame (client → server frames MUST be masked). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * Incremental RFC-6455 decoder. Data frames are returned as complete logical
 * messages: fragmented text/binary frames are buffered across continuation
 * frames, while interleaved control frames are delivered immediately.
 */
class FrameDecoder {
  private buf = Buffer.alloc(0);
  private fragmentedOpcode: number | undefined;
  private fragmentedPayloads: Buffer[] = [];
  private fragmentedBytes = 0;

  feed(chunk: Buffer): DecodedFrame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const first = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0) throw new Error('unsupported WebSocket extension bits');
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const wideLength = this.buf.readBigUInt64BE(2);
        if (wideLength > BigInt(MAX_MESSAGE_BYTES)) throw new Error('WebSocket frame exceeds message limit');
        len = Number(wideLength);
        off = 10;
      }
      if (len > MAX_MESSAGE_BYTES) throw new Error('WebSocket frame exceeds message limit');
      if (opcode >= OP_CLOSE && (!fin || len > 125)) throw new Error('invalid fragmented WebSocket control frame');
      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buf.length < off + 4) break;
        maskKey = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) break;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) {
        const u = Buffer.alloc(len);
        for (let i = 0; i < len; i++) u[i] = payload[i]! ^ maskKey[i % 4]!;
        payload = u;
      }
      this.buf = this.buf.subarray(off + len);

      if (opcode >= OP_CLOSE) {
        if (opcode !== OP_CLOSE && opcode !== OP_PING && opcode !== OP_PONG) {
          throw new Error(`unsupported WebSocket control opcode ${opcode}`);
        }
        frames.push({ opcode, payload });
        continue;
      }
      if (opcode === OP_CONTINUATION) {
        if (this.fragmentedOpcode === undefined) throw new Error('unexpected WebSocket continuation frame');
        this.fragmentedPayloads.push(payload);
        this.fragmentedBytes += payload.length;
        if (this.fragmentedBytes > MAX_MESSAGE_BYTES) throw new Error('WebSocket message exceeds message limit');
        if (fin) {
          frames.push({ opcode: this.fragmentedOpcode, payload: Buffer.concat(this.fragmentedPayloads) });
          this.fragmentedOpcode = undefined;
          this.fragmentedPayloads = [];
          this.fragmentedBytes = 0;
        }
        continue;
      }
      if (opcode !== OP_TEXT && opcode !== OP_BINARY) throw new Error(`unsupported WebSocket opcode ${opcode}`);
      if (this.fragmentedOpcode !== undefined) throw new Error('new WebSocket data frame during fragmented message');
      if (fin) {
        frames.push({ opcode, payload });
      } else {
        this.fragmentedOpcode = opcode;
        this.fragmentedPayloads = [payload];
        this.fragmentedBytes = payload.length;
      }
    }
    return frames;
  }
}

// ─── Transport ─────────────────────────────────────────────────────────────

export interface WsUnixTransportOptions {
  /** Host header value for the upgrade request (cosmetic for UDS). */
  host?: string;
}

/**
 * Connect to a listening `codex app-server` over a unix socket and expose it as
 * a `Transport`. Messages are delivered/sent as already-parsed JSON objects
 * (same contract as the stdio transport). Sends before the handshake completes
 * are queued and flushed on open.
 */
export function wsOverUnixTransport(socketPath: string, opts: WsUnixTransportOptions = {}): Transport {
  let onMsg: ((m: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  let closedEmitted = false;

  const decoder = new FrameDecoder();
  let handshakeDone = false;
  let headerBuf = Buffer.alloc(0);
  let open = false;
  const sendQueue: string[] = [];

  const sock = net.connect(socketPath);
  sock.setNoDelay(true);

  const emitClose = (info: { code: number | null; signal: string | null }): void => {
    if (closedEmitted) return;
    closedEmitted = true;
    onCls?.(info);
  };

  const deliverText = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    onMsg?.(parsed);
  };

  const handleFrames = (chunk: Buffer): void => {
    try {
      for (const f of decoder.feed(chunk)) {
        if (f.opcode === OP_TEXT || f.opcode === OP_BINARY) deliverText(f.payload.toString('utf8'));
        else if (f.opcode === OP_PING) sock.write(encodeFrame(OP_PONG, f.payload));
        else if (f.opcode === OP_CLOSE) sock.destroy();
      }
    } catch (error) {
      sock.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  };

  sock.on('connect', () => {
    const key = crypto.randomBytes(16).toString('base64');
    sock.write(
      `GET / HTTP/1.1\r\n` +
        `Host: ${opts.host ?? 'localhost'}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
    );
  });

  sock.on('data', (chunk) => {
    if (!handshakeDone) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const statusLine = headerBuf.subarray(0, headerBuf.indexOf('\r\n')).toString();
      if (!statusLine.includes('101')) {
        sock.destroy(new Error(`app-server WS handshake failed: ${statusLine}`));
        return;
      }
      handshakeDone = true;
      open = true;
      const rest = headerBuf.subarray(idx + 4);
      headerBuf = Buffer.alloc(0);
      for (const q of sendQueue) sock.write(encodeFrame(OP_TEXT, Buffer.from(q, 'utf8')));
      sendQueue.length = 0;
      if (rest.length) handleFrames(rest);
      return;
    }
    handleFrames(chunk);
  });

  sock.on('close', () => emitClose({ code: null, signal: null }));
  sock.on('error', () => emitClose({ code: null, signal: null }));

  return {
    send: (message) => {
      const s = JSON.stringify(message);
      if (open) sock.write(encodeFrame(OP_TEXT, Buffer.from(s, 'utf8')));
      else sendQueue.push(s);
    },
    onMessage: (h) => {
      onMsg = h;
    },
    onClose: (h) => {
      onCls = h;
    },
    close: () => {
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

export interface UnixWebSocketTapProxy {
  socketPath: string;
  ready(): Promise<void>;
  dispose(): void;
}

/**
 * Transparent UDS proxy for a native Codex TUI connection. Bytes remain
 * untouched; client WebSocket text frames are decoded only to discover which
 * thread a native resume picker selected.
 */
export function createUnixWebSocketTapProxy(
  upstreamPath: string,
  onClientMessage: (message: unknown) => void,
): UnixWebSocketTapProxy {
  const realTmp = realpathSync(tmpdir());
  const socketPath = join(realTmp, `cx-tap-${process.pid}-${sockCounter++}.sock`);
  let disposed = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const server = net.createServer((downstream) => {
    const upstream = net.connect(upstreamPath);
    let decoder = new FrameDecoder();
    let upgraded = false;
    let requestHeaders = Buffer.alloc(0);

    upstream.on('data', (chunk) => downstream.write(chunk));
    downstream.on('data', (chunk) => {
      upstream.write(chunk);
      let framed = chunk;
      if (!upgraded) {
        requestHeaders = Buffer.concat([requestHeaders, chunk]);
        const end = requestHeaders.indexOf('\r\n\r\n');
        if (end < 0) return;
        upgraded = true;
        framed = requestHeaders.subarray(end + 4);
        requestHeaders = Buffer.alloc(0);
      }
      try {
        for (const frame of decoder.feed(framed)) {
          if (frame.opcode !== OP_TEXT && frame.opcode !== OP_BINARY) continue;
          try {
            onClientMessage(JSON.parse(frame.payload.toString('utf8')));
          } catch {
            // Non-JSON frames remain transparently forwarded.
          }
        }
      } catch {
        // Observation must never disturb the transparent byte stream. Reset
        // after malformed/unsupported framing and keep forwarding untouched.
        decoder = new FrameDecoder();
      }
    });
    const close = (): void => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.on('close', () => upstream.destroy());
    downstream.on('error', close);
    upstream.on('close', () => downstream.destroy());
    upstream.on('error', close);
  });
  server.on('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
  });
  server.listen(socketPath, () => {
    readySettled = true;
    resolveReady();
  });

  return {
    socketPath,
    ready: () => readyPromise,
    dispose() {
      if (disposed) return;
      disposed = true;
      server.close();
      rmSync(socketPath, { force: true });
    },
  };
}

// ─── app-server process ──────────────────────────────────────────────────────

let sockCounter = 0;

export interface AppServerHandle {
  /** The unix socket the app-server is listening on. */
  socketPath: string;
  process: ChildProcess;
  /** Resolves once the socket file exists (or rejects on timeout / early exit). */
  ready(timeoutMs?: number): Promise<void>;
  /** SIGTERM the app-server. */
  dispose(): void;
}

/**
 * Spawn `codex app-server --listen unix://<sock>`. The socket path defaults to a
 * fresh file under the REAL temp dir (macOS `/tmp` is a symlink the app-server's
 * lstat rejects — CODEX-SURFACE-FINDINGS §8).
 */
export function spawnAppServer(opts?: { executable?: string; socketPath?: string }): AppServerHandle {
  const realTmp = realpathSync(tmpdir());
  const socketPath = opts?.socketPath ?? join(realTmp, `chopsticks-codex-${process.pid}-${sockCounter++}.sock`);
  const child = spawn(opts?.executable ?? 'codex', ['app-server', '--listen', `unix://${socketPath}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  return {
    socketPath,
    process: child,
    ready: (timeoutMs = 8000) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        let exited = false;
        child.once('exit', (code) => {
          exited = true;
          reject(new Error(`app-server exited before ready (code ${code})`));
        });
        const tick = (): void => {
          if (exited) return;
          if (existsSync(socketPath)) return resolve();
          if (Date.now() - t0 > timeoutMs) return reject(new Error('app-server socket not ready in time'));
          setTimeout(tick, 100);
        };
        tick();
      }),
    dispose: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}
