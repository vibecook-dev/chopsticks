/**
 * Freshness gate (the format:check pattern): registry.ts must be byte-identical
 * to a fresh render from the model. If this fails, run
 * `node surface/generate-registry.mjs` and commit the result.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel } from '@vibecook/chopsticks-emulator/model';
import { renderRegistry } from './registry-render.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('generated registry', () => {
  it('src/registry.ts is byte-identical to a fresh render from the model', () => {
    const model = loadModel(join(here, '..', 'surface', 'model', 'claude@2.1.207'));
    const onDisk = readFileSync(join(here, 'registry.ts'), 'utf8');
    expect(onDisk).toBe(renderRegistry(model));
  });

  it('still exposes the registry surface settings.ts and tests rely on', () => {
    const model = loadModel(join(here, '..', 'surface', 'model', 'claude@2.1.207'));
    expect(model.events).toHaveLength(26);
    expect(model.events.filter((event) => event.confidence !== 'unverified')).toHaveLength(13);
  });
});
