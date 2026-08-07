#!/usr/bin/env node
/**
 * surface audit (draft/EMULATOR.md §7): diff the ASM model against the
 * captured surface. Clean exit means the model exactly covers the captures.
 *
 * Usage: node surface/audit.mjs [--write-report]
 * Requires node >= 22.18 (type stripping; on older 22.x use
 * `node --experimental-strip-types surface/audit.mjs`).
 *
 * The nightly reconciliation lane runs the census against a live binary first
 * (CHOPSTICKS_REAL_CLAUDE=1), refreshing surface/captures/ — this script's
 * diff is the mechanical verdict on what changed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, diffModelVsReport, loadModel } from '@vibecook/chopsticks-emulator/model';

const surface = fileURLToPath(new URL('.', import.meta.url));
const version = '2.1.207';
const model = loadModel(join(surface, 'model', `claude@${version}`));
const report = buildReport(join(surface, 'captures', `claude@${version}`));

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
if (drift.length === 0) {
  console.log('audit clean: model exactly covers the captures');
  process.exit(0);
}
for (const entry of drift) {
  console.log(`[${entry.kind}] ${entry.event}: ${entry.message}`);
}
console.log(`${drift.length} drift entr${drift.length === 1 ? 'y' : 'ies'}`);
process.exit(1);
