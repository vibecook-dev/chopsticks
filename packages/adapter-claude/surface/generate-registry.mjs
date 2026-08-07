#!/usr/bin/env node
/**
 * Registry generation (draft/EMULATOR.md §2, ADAPTING-AN-AGENT step 4):
 * src/registry.ts is GENERATED from surface/model/claude@2.1.207 — the model
 * is canonical, this file is a projection.
 *
 * Usage: node surface/generate-registry.mjs
 * Requires node >= 22.18 (type stripping; on older 22.x use
 * `node --experimental-strip-types surface/generate-registry.mjs`).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel } from '@vibecook/chopsticks-emulator/model';
import { renderRegistry } from '../src/registry-render.ts';

const surface = fileURLToPath(new URL('.', import.meta.url));
const target = join(surface, '..', 'src', 'registry.ts');
writeFileSync(target, renderRegistry(loadModel(join(surface, 'model', 'claude@2.1.207'))));
console.log(`generated ${target}`);
