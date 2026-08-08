/**
 * Persona selection and vendor argv parsing (draft/IMPOSTER.md §6).
 *
 * Resolution order is argv0 → `--<vendor>` → `AI_PERSONA`, and argv0 comes
 * first for a reason: shims are how product apps reach the imposter. Godview's
 * adapter spawns plain `claude` with the vendor's own launch recipe, so the
 * imposter must be selectable WITHOUT any flag of its own. `ai --claude` is
 * the ergonomic hand-run form layered on top.
 *
 * Everything after selection belongs to the vendor and is parsed with that
 * persona's flag aliases from `detection.json` — the imposter never invents
 * argv the vendor does not have.
 */

import { basename } from 'node:path';

export interface PersonaSelection {
  vendor: string;
  /** argv with the imposter's own selector removed; the rest is the vendor's. */
  rest: string[];
  source: 'argv0' | 'flag' | 'env';
}

export interface SelectPersonaOptions {
  /** process.argv[1] (or argv[0] under a shim). */
  argv0?: string;
  env?: Record<string, string | undefined>;
  /** Shim name → vendor, from `shimNameMap()`. */
  shims: ReadonlyMap<string, string>;
}

/** `…/bin/claude.mjs` → `claude`; tolerate .exe/.cmd/.mjs/.js suffixes. */
export function shimIdentity(argv0: string): string {
  return basename(argv0).replace(/\.(exe|cmd|bat|mjs|cjs|js|ts)$/i, '');
}

export class PersonaSelectionError extends Error {}

export function selectPersona(argv: readonly string[], options: SelectPersonaOptions): PersonaSelection {
  const known = new Set(options.shims.values());

  if (options.argv0) {
    const vendor = options.shims.get(shimIdentity(options.argv0));
    // `ai`/`imposter` are the tool's own names, never a persona — invoking
    // them means the persona must come from a flag or the environment.
    if (vendor) return { vendor, rest: [...argv], source: 'argv0' };
  }

  const flagIndex = argv.findIndex((argument) => argument.startsWith('--') && known.has(argument.slice(2)));
  if (flagIndex >= 0) {
    const vendor = argv[flagIndex]!.slice(2);
    return { vendor, rest: [...argv.slice(0, flagIndex), ...argv.slice(flagIndex + 1)], source: 'flag' };
  }

  const fromEnv = options.env?.AI_PERSONA;
  if (fromEnv) {
    if (!known.has(fromEnv)) {
      throw new PersonaSelectionError(
        `AI_PERSONA="${fromEnv}" is not an available persona (have: ${[...known].sort().join(', ')})`,
      );
    }
    return { vendor: fromEnv, rest: [...argv], source: 'env' };
  }

  throw new PersonaSelectionError(
    `no persona selected. Use one of --${[...known].sort().join(' / --')}, set AI_PERSONA, ` +
      `or invoke through an installed shim (\`ai shims install\`). To put \`ai\` itself on PATH: \`ai link\`.`,
  );
}

/**
 * Read one flag's value out of vendor argv, given that flag's aliases from the
 * ASM's `detection.json` (e.g. name -> ['-n', '--name']).
 */
export function flagValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index >= 0) return argv[index + 1];
  }
  return undefined;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}
