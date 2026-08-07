#!/usr/bin/env node
/**
 * surface audit (draft/EMULATOR.md §7): diff the ASM model against the
 * captured surface. Clean exit means the model exactly covers the captures.
 *
 * Usage: node surface/audit.mjs [--write-report]
 * Requires node >= 22.18 (type stripping; on older 22.x use
 * `node --experimental-strip-types surface/audit.mjs`).
 *
 * A future nightly reconciliation lane must run a protected census against a
 * live binary before invoking this script. Until that lane lands, this command
 * checks only the sanitized fixtures already in the repository.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, diffModelVsReport, loadModel } from '@vibecook/chopsticks-emulator/model';
import { checkCaptureDirectory } from './sanitize-captures.mjs';

const surface = fileURLToPath(new URL('.', import.meta.url));
const version = '2.1.207';
const model = loadModel(join(surface, 'model', `claude@${version}`));
const captures = join(surface, 'captures', `claude@${version}`);
const report = buildReport(captures, model);
const privacyIssues = checkCaptureDirectory(captures);

if (process.argv.includes('--write-report')) {
  const path = join(surface, 'surface-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${path}`);
}

console.log(
  `model: ${model.events.length} events | captures: ${report.events.length} observed events, ` +
    `${report.events.reduce((sum, event) => sum + event.count, 0)} lines, ${report.unparsedLines} unparsed`,
);

const drift = diffModelVsReport(model, report);
if (drift.length === 0 && privacyIssues.length === 0) {
  console.log('audit clean: every capture parses and satisfies the model');
  process.exit(0);
}
for (const issue of privacyIssues) console.log(`[privacy] ${issue}`);
for (const entry of drift) {
  console.log(`[${entry.kind}] ${entry.event}: ${entry.message}`);
}
console.log(
  `${drift.length} drift entr${drift.length === 1 ? 'y' : 'ies'}, ${privacyIssues.length} privacy issue${privacyIssues.length === 1 ? '' : 's'}`,
);
process.exit(1);
