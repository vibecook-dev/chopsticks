import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseLsofCwd(output: string): string | undefined {
  for (const field of output.split('\0')) {
    const normalized = field.replace(/^\n+/, '');
    if (normalized.startsWith('n') && isAbsolute(normalized.slice(1))) return normalized.slice(1);
  }
  return undefined;
}

/** Resolve a local terminal process's live cwd when VT shell metadata is unavailable or stale. */
export async function resolveProcessCwd(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      return isAbsolute(cwd) ? cwd : undefined;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F0n'], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      });
      return parseLsofCwd(stdout);
    }
  } catch {
    // The process may have exited between the terminal snapshot and this lookup.
  }
  return undefined;
}
