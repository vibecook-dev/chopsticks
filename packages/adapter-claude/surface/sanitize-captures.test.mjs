import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCaptureDirectory, sanitizeCaptureDirectory } from './sanitize-captures.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'chopsticks-capture-sanitizer-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('capture sanitizer', () => {
  it('redacts content and paths while preserving enums and stable pseudonymous ids', () => {
    const input = temporaryDirectory();
    const output = temporaryDirectory();
    mkdirSync(join(input, 'interactive'));
    writeFileSync(
      join(input, 'interactive', 'Stop.jsonl'),
      [
        {
          hook_event_name: 'Stop',
          session_id: 'same-session',
          cwd: '/Users/alice/private-project',
          prompt: 'customer prompt',
          authorization: 'Bearer secret-value',
          permission_mode: 'default',
          tool_input: { file_path: '/Users/alice/private-project/key.txt', content: 'secret' },
          tool_response: { type: 'text', file: { filePath: '/Users/alice/private-project/result.txt' } },
        },
        { hook_event_name: 'Stop', session_id: 'same-session', prompt: 'another prompt' },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );

    expect(sanitizeCaptureDirectory(input, output)).toEqual({ files: 1, lines: 2 });
    const [first, second] = readFileSync(join(output, 'interactive', 'Stop.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(first.session_id).toMatch(/^anon-/);
    expect(second.session_id).toBe(first.session_id);
    expect(first).toMatchObject({
      cwd: '/workspace',
      prompt: '<redacted:prompt>',
      authorization: '<redacted:authorization>',
      permission_mode: 'default',
      tool_input: { file_path: '/workspace/redacted-file', content: '<redacted:content>' },
      tool_response: { type: 'text', file: { filePath: '/workspace/redacted-file' } },
    });
    expect(checkCaptureDirectory(output)).toEqual([]);
  });

  it('does not accept redaction-looking prefixes with sensitive suffixes', () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, 'Stop.jsonl'),
      `${JSON.stringify({ prompt: '<redacted:prompt> leaked', cwd: '/workspace/customer-name' })}\n`,
    );
    expect(checkCaptureDirectory(directory)).toHaveLength(2);
  });
});
