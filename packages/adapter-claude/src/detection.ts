/**
 * Claude executable detection and capability probe (DESIGN §10, §16.2 steps
 * 1–3). Capability-probe, don't assume: we read `claude --version` and
 * `claude --help` and report which of the four flags the native driver depends
 * on (--session-id, --settings, --name/-n, --permission-mode) are advertised.
 *
 * Missing flags DEGRADE the observation (warnings + false in `flags`); they do
 * not throw — DESIGN §10 says report degraded capability, and a session may
 * still be spawnable with a subset. The exec function is injected so unit tests
 * run against fakes; the real binary is exercised only by the opt-in
 * integration test gated on CHOPSTICKS_REAL_CLAUDE.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import detectionSurface from '../surface/model/claude@2.1.207/detection.json' with { type: 'json' };

interface DetectionSurface {
  executables: string[];
  envVar: string;
  versionFlag: string;
  versionPattern: string;
  helpFlag: string;
  probedFlags: Record<keyof ClaudeFlagSupport, string>;
}

const surface = detectionSurface as DetectionSurface;
const versionPattern = new RegExp(surface.versionPattern);
const flags = Object.fromEntries(
  Object.entries(surface.probedFlags).map(([key, value]) => [
    key,
    value
      .split(',')
      .map((flag) => flag.trim())
      .filter(Boolean),
  ]),
) as Record<keyof ClaudeFlagSupport, string[]>;

/** Injected process runner; the default wraps node:child_process execFile. */
export type ClaudeExec = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface ClaudeFlagSupport {
  sessionId: boolean;
  settings: boolean;
  name: boolean;
  permissionMode: boolean;
}

export interface ClaudeDetection {
  /** The resolved command (an absolute path, or a bare name left to PATH). */
  executable: string;
  /** Parsed `x.y.z` from `--version`; undefined when it could not be read. */
  version?: string;
  flags: ClaudeFlagSupport;
  /** Non-fatal capability gaps (missing flags, unreadable version). */
  warnings: string[];
}

export interface DetectClaudeOptions {
  executable?: string;
  exec?: ClaudeExec;
}

const execFileAsync = promisify(execFile);

const defaultExec: ClaudeExec = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return { stdout };
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `2.1.207 (Claude Code)` → `2.1.207`; undefined when no semver is present. */
function parseVersion(stdout: string): string | undefined {
  return stdout.match(versionPattern)?.[1];
}

/**
 * Match a flag as a standalone token. Help text lists flags whitespace- or
 * comma-delimited (`-n, --name`), so a bare `includes` would false-positive
 * (`-n` inside `--session-id` need not, but `--settings` inside `--settings-x`
 * would). Bound the match on both sides.
 */
function helpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,('"\`])${escaped}([\\s,)='"\`]|$)`, 'm').test(help);
}

export async function detectClaude(options: DetectClaudeOptions = {}): Promise<ClaudeDetection> {
  const exec = options.exec ?? defaultExec;
  // Resolution order: explicit option → env override → PATH lookup of `claude`.
  const executable = options.executable ?? process.env[surface.envVar] ?? surface.executables[0] ?? 'claude';
  const warnings: string[] = [];

  let version: string | undefined;
  try {
    const { stdout } = await exec(executable, [surface.versionFlag]);
    version = parseVersion(stdout);
    if (!version) {
      warnings.push(`could not parse version from \`${executable} ${surface.versionFlag}\`: ${stdout.trim()}`);
    }
  } catch (err) {
    warnings.push(`\`${executable} ${surface.versionFlag}\` failed: ${errMessage(err)}`);
  }

  let help = '';
  try {
    help = (await exec(executable, [surface.helpFlag])).stdout;
  } catch (err) {
    warnings.push(`\`${executable} ${surface.helpFlag}\` failed: ${errMessage(err)}`);
  }

  const supported: ClaudeFlagSupport = {
    sessionId: flags.sessionId.some((flag) => helpHasFlag(help, flag)),
    settings: flags.settings.some((flag) => helpHasFlag(help, flag)),
    name: flags.name.some((flag) => helpHasFlag(help, flag)),
    permissionMode: flags.permissionMode.some((flag) => helpHasFlag(help, flag)),
  };

  for (const key of Object.keys(supported) as Array<keyof ClaudeFlagSupport>) {
    if (!supported[key]) {
      const label = flags[key].join('/');
      warnings.push(
        `\`${executable} ${surface.helpFlag}\` does not advertise ${label}; native driver capability degraded`,
      );
    }
  }

  return { executable, version, flags: supported, warnings };
}
