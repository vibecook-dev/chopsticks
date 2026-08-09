import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from './transcript.ts';

describe('createTranscriptWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chopsticks-imposter-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends JSONL records and partial fragments', () => {
    const path = join(dir, 'nested', 'session.jsonl');
    const writer = createTranscriptWriter(path);
    writer.append({ type: 'user', text: 'hi' });
    writer.appendPartial('{"type":"assis');
    const content = readFileSync(path, 'utf8');
    expect(content).toBe('{"type":"user","text":"hi"}\n{"type":"assis');
  });

  it('creates the file eagerly so a tailing observer can attach before the first record', () => {
    const path = join(dir, 'empty.jsonl');
    const writer = createTranscriptWriter(path);
    expect(readFileSync(writer.path, 'utf8')).toBe('');
  });
});
