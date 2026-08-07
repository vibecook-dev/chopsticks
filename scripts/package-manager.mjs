import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function findFile(root, names, depth) {
  if (!root || depth < 0 || !existsSync(root)) return undefined;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && names.has(entry.name)) return join(root, entry.name);
  }
  if (depth === 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'store') continue;
    const match = findFile(join(root, entry.name), names, depth - 1);
    if (match) return match;
  }
  return undefined;
}

/**
 * Resolve npm/pnpm to its JavaScript entry point and execute it with this
 * Node binary. This avoids `.cmd` + shell parsing on Windows entirely, so
 * arguments (including generated paths with spaces) remain an argv array.
 */
export function packageManagerInvocation(manager, environment = process.env, nodeExecutable = process.execPath) {
  if (!['npm', 'pnpm'].includes(manager)) throw new Error(`unsupported package manager: ${manager}`);
  const nodeDirectory = dirname(nodeExecutable);
  const override = environment[`CHOPSTICKS_${manager.toUpperCase()}_CLI`];
  const fileNames = new Set(manager === 'npm' ? ['npm-cli.js'] : ['pnpm.cjs', 'pnpm.mjs']);
  const lifecycleCli =
    environment.npm_execpath && fileNames.has(basename(environment.npm_execpath).toLowerCase())
      ? environment.npm_execpath
      : undefined;
  const conventional =
    manager === 'npm'
      ? [
          join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ]
      : [
          join(nodeDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
          join(nodeDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
          resolve(nodeDirectory, '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
          resolve(nodeDirectory, '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
        ];
  const toolHome = manager === 'pnpm' ? findFile(join(environment.PNPM_HOME ?? '', '.tools'), fileNames, 6) : undefined;
  const cli = firstExisting([override, lifecycleCli, ...conventional, toolHome]);
  if (!cli) {
    throw new Error(
      `could not locate the ${manager} JavaScript CLI; set CHOPSTICKS_${manager.toUpperCase()}_CLI to its entry point`,
    );
  }
  return { command: nodeExecutable, prefixArgs: [cli] };
}

export function spawnPackageManager(manager, args, options = {}) {
  const invocation = packageManagerInvocation(manager);
  return spawnSync(invocation.command, [...invocation.prefixArgs, ...args], { ...options, shell: false });
}
