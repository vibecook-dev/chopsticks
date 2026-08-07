#!/usr/bin/env node

import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  entryPoints: [join(root, 'src/main/main.ts')],
  outfile: join(dist, 'main.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', '@parcel/watcher'],
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(dist, 'main.cjs')).href) },
});
