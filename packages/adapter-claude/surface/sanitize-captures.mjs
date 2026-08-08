#!/usr/bin/env node
/**
 * Claude capture sanitiser — a thin CLI over the shared engine in
 * `@vibecook/chopsticks-surface/sanitize`.
 *
 * The engine moved out of this file on 2026-08-07 (draft/IMPOSTER.md §9.6).
 * The rules are vendor-specific, but the MECHANISM is not, and keeping one copy
 * means a hole closed for one vendor is closed for every vendor. The move was
 * prompted by finding that this file's own predecessor passed a real codex
 * capture as clean while leaving the prompt text, hostname, userAgent and 19
 * verbatim UUIDs intact — and, once the rules were widened, that it had also
 * been missing a raw `delta` in claude's own committed fixtures.
 *
 * Claude adds no rules of its own today: the shared defaults already cover its
 * surface. Should it need any, use `extendRules` rather than forking the engine.
 *
 * Usage: node surface/sanitize-captures.mjs [--check] <input-dir> [output-dir]
 * Requires node >= 22.18 (type stripping).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeCaptureDirectory } from '@vibecook/chopsticks-surface/sanitize';

export { checkCaptureDirectory, sanitizeCaptureDirectory };

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  const directories = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  if ((check && directories.length !== 1) || (!check && ![1, 2].includes(directories.length))) {
    console.error('usage: node surface/sanitize-captures.mjs [--check] <input-directory> [output-directory]');
    process.exit(2);
  }
  if (check) {
    const issues = checkCaptureDirectory(directories[0]);
    for (const issue of issues) console.error(issue);
    if (issues.length > 0) process.exit(1);
    console.log('capture privacy check clean');
  } else {
    const result = sanitizeCaptureDirectory(directories[0], directories[1]);
    console.log(`sanitized ${result.lines} capture lines in ${result.files} files`);
  }
}
