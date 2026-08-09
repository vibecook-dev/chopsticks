/**
 * Repo-wide capture privacy gate.
 *
 * Runs as part of `pnpm test` (root: `node --test scripts/*.test.mjs`) so a raw
 * capture cannot reach a commit, a release, or an npm tarball.
 *
 * It exists because on 2026-08-07 three leaks were found at once:
 * `packages/testing/fixtures/hooks` shipped home paths and raw session UUIDs
 * inside the PUBLISHED `@vibecook/chopsticks-testing@0.1.8` tarball;
 * `probe/codex/` held a raw JSON-RPC transcript on a public repo; and the
 * sanitiser of the day passed both as clean. Nothing was watching, so nothing
 * complained. This is the thing that watches.
 *
 * Scope: files GIT TRACKS under a capture root. Tracked, because the job is to
 * stop a leak reaching a commit — a gitignored local artefact (probe's own
 * `http-received.json` carries an Authorization header) failing the build is
 * noise. Capture roots rather than every `*.jsonl`, because captures are the
 * only files copied verbatim out of a real session. Both `.json` and `.jsonl`,
 * because one leak hid in a `*-shapes.json` companion a `.jsonl`-only scan
 * never opened.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCaptureFile } from '@vibecook/chopsticks-surface/sanitize';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories whose contents came from observing a real agent. */
const captureRoots = [
  'probe',
  'packages/testing/fixtures',
  'packages/adapter-claude/surface/captures',
  'packages/adapter-codex/surface/captures',
  'packages/adapter-grok/surface/captures',
  'packages/adapter-acp/surface/captures',
];

/**
 * Generated hook-settings documents are config, not captures: their `command`
 * values are the curl forwarder the adapter writes, which `sensitiveTextKey`
 * matches only because "command" means a USER-run tool command in a capture.
 * Their shape is asserted by adapter-claude's settings.test.ts instead.
 */
const notACapture = /-settings\.json$/;

function trackedCaptureFiles() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...captureRoots], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return listed
    .split('\0')
    .filter((file) => file.endsWith('.json') || file.endsWith('.jsonl'))
    .filter((file) => !notACapture.test(file))
    .sort();
}

test('committed captures carry no unsanitised session data', () => {
  const files = trackedCaptureFiles();
  // A scan that silently matches nothing would pass forever; assert it looked.
  assert.ok(files.length > 0, 'expected to find tracked capture files to scan');

  const findings = files.flatMap((file) => checkCaptureFile(join(repoRoot, file), file));
  assert.deepEqual(
    findings.slice(0, 20),
    [],
    `${findings.length} capture privacy issue(s) across ${files.length} tracked capture file(s).\n` +
      `Sanitise before committing:\n` +
      `  node packages/adapter-claude/surface/sanitize-captures.mjs <dir>\n` +
      findings.slice(0, 20).join('\n'),
  );
});
