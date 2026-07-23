import { describe, expect, it } from 'vitest';
import { parseLsofCwd, resolveProcessCwd } from './process-cwd.js';

describe('Godview process cwd lookup', () => {
  it('parses the null-delimited lsof cwd field', () => {
    expect(parseLsofCwd('p123\0\nfcwd\0n/Users/james/Projects/chopsticks\0\n')).toBe(
      '/Users/james/Projects/chopsticks',
    );
  });

  it('rejects missing and relative lsof paths', () => {
    expect(parseLsofCwd('p123\0\nfcwd\0nrelative/path\0\n')).toBeUndefined();
    expect(parseLsofCwd('p123\0\nfcwd\0\n')).toBeUndefined();
  });

  it('rejects invalid process identifiers before accessing the OS', async () => {
    await expect(resolveProcessCwd(0)).resolves.toBeUndefined();
    await expect(resolveProcessCwd(Number.NaN)).resolves.toBeUndefined();
  });
});
