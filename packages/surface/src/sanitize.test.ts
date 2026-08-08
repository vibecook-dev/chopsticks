import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alias,
  checkCaptureDirectory,
  checkRecord,
  extendRules,
  sanitizeCaptureDirectory,
  sanitizeRecord,
} from './sanitize.js';

describe('correlation — the property that makes a fixture replayable', () => {
  it('gives one value one pseudonym, whatever key it appears under', () => {
    const uuid = '019f5d86-423a-7083-ab79-2deb044599c1';
    const out = sanitizeRecord({ id: uuid, sessionId: uuid, threadId: uuid, nested: { turnId: uuid } }) as Record<
      string,
      unknown
    >;
    const values = [out.id, out.sessionId, out.threadId, (out.nested as Record<string, unknown>).turnId];
    expect(new Set(values).size).toBe(1);
    // Shape-faithful: a uuid in yields a uuid out, so fixtures keep the
    // vendor format downstream tests legitimately assert on.
    expect(values[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('leaves numeric JSON-RPC ids untouched, so request↔response joins survive', () => {
    const out = sanitizeRecord({ id: 2, method: 'thread/start' }) as Record<string, unknown>;
    expect(out.id).toBe(2);
  });

  it('is idempotent — re-sanitizing a fixture changes nothing', () => {
    const record = { threadId: '019f5d86-423a-7083-ab79-2deb044599c1', cwd: '/Users/someone/repo', text: 'hello' };
    const once = sanitizeRecord(record);
    expect(sanitizeRecord(once)).toEqual(once);
  });
});

describe('regressions from the real codex capture (2026-08-07)', () => {
  // Each case below was left INTACT by the pre-2026-08-07 sanitizer while its
  // privacy check reported the file clean. They are the reason the defaults
  // are broad.
  const leaky = {
    threadId: '019f5d86-423a-7083-ab79-2deb044599c1',
    installationId: '33dd9f00-3399-4a62-8fe3-0dd23055b087',
    serverName: 'Operators-MacBook-Pro.local',
    userAgent: 'probe/0.144.2 (Mac OS 26.5.1; arm64) ghostty/1.3.1',
    codexHome: '/Users/operator/.codex',
    diskCheck: 'rollout session_meta.session_id=019f5d86-423a-7083-ab79-2deb044599c1 :: matches',
    params: { input: [{ type: 'text', text: 'Reply with exactly the single word: pong.' }] },
    tmp: '/var/folders/hs/j754ys991yd3bss5c87lf0m40000gn/T/probe',
  };

  it('the detector flags every one of them on raw input', () => {
    const issues = checkRecord(leaky).join('\n');
    for (const key of ['threadId', 'installationId', 'serverName', 'userAgent', 'codexHome']) {
      expect(issues, `${key} not flagged`).toContain(key);
    }
    expect(issues).toContain('raw UUID');
  });

  it('the redactor removes them, and the detector then passes', () => {
    const clean = JSON.stringify(sanitizeRecord(leaky));
    expect(clean).not.toContain('Operators-MacBook-Pro');
    expect(clean).not.toContain('ghostty/');
    expect(clean).not.toContain('/Users/operator');
    expect(clean).not.toContain('Reply with exactly');
    expect(clean).not.toContain('33dd9f00-3399');
    expect(clean).not.toContain('var/folders/hs');
    // The ORIGINAL uuid is gone, and what replaces it is v4-shaped: never
    // v7, whose leading bits would re-encode the capture time.
    expect(clean).not.toContain('019f5d86-423a-7083');
    expect(clean).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);
    expect(checkRecord(sanitizeRecord(clean === '' ? {} : JSON.parse(clean)))).toEqual([]);
  });

  it('aliases a uuid embedded in free text rather than walking past it', () => {
    const out = sanitizeRecord({ diskCheck: leaky.diskCheck }) as Record<string, string>;
    expect(out.diskCheck).not.toContain('019f5d86');
    // Embedded and bare occurrences of the same id agree, so the join survives.
    expect(out.diskCheck).toContain(alias('019f5d86-423a-7083-ab79-2deb044599c1'));
  });
});

describe('redactor and detector stay in lockstep', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-sanitize-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sanitize → check round-trips to zero issues on a JSON-RPC transcript', () => {
    const transcript = [
      { dt: 0, dir: 'send', msg: { id: 1, method: 'initialize', params: { clientInfo: { name: 'probe' } } } },
      { dt: 12, dir: 'recv', msg: { id: 1, result: { codexHome: '/Users/someone/.codex' } } },
      {
        dt: 30,
        dir: 'recv',
        msg: { method: 'thread/started', params: { threadId: '019f5d86-423a-7083-ab79-2deb044599c1' } },
      },
    ];
    writeFileSync(join(dir, 'capture.jsonl'), transcript.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(checkCaptureDirectory(dir).length).toBeGreaterThan(0);
    sanitizeCaptureDirectory(dir);
    expect(checkCaptureDirectory(dir)).toEqual([]);
    // The envelope is metadata and must survive so the capture stays ordered.
    const first = JSON.parse(readFileSync(join(dir, 'capture.jsonl'), 'utf8').split('\n')[0]!);
    expect(first).toMatchObject({ dt: 0, dir: 'send' });
    expect(first.msg.method).toBe('initialize');
  });
});

describe('extendRules', () => {
  it('adds vendor keys without dropping the defaults', () => {
    const rules = extendRules({ sensitiveTextKey: /^vendorSecret$/ });
    const out = sanitizeRecord({ vendorSecret: 'hunter2', prompt: 'hello' }, rules) as Record<string, string>;
    expect(out.vendorSecret).toBe('<redacted:vendorSecret>');
    expect(out.prompt).toBe('<redacted:prompt>');
  });
});
