#!/usr/bin/env node

import { addonPath as nativeTabAddonPath } from '@vibecook/ghosttea-native-tabs';
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { stageEsmRuntime } from '../../scripts/stage-esm-runtime.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const shared = { bundle: true, sourcemap: true, logLevel: 'info' };
const requireFromGodview = createRequire(import.meta.url);
const reactSingletonPlugin = {
  name: 'godview-react-singleton',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
      path: requireFromGodview.resolve(args.path),
    }));
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    ...shared,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(dist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // The daemon resolver stays external: it walks node_modules at runtime to
    // find the platform binary package, which a bundle cannot carry.
    external: ['electron', '@parcel/watcher', '@vibecook/ghosttead'],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(dist, 'main.cjs')).href) },
  }),
  build({
    ...shared,
    entryPoints: [join(root, 'src/preload/preload.ts')],
    outfile: join(dist, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: [join(root, 'src/shim/agent-shim.ts')],
    outfile: join(dist, 'agent-shim.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
  }),
  build({
    ...shared,
    entryPoints: [join(root, 'src/renderer/main.tsx')],
    outdir: dist,
    entryNames: 'renderer',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    splitting: true,
    plugins: [reactSingletonPlugin],
  }),
]);

await Promise.all([
  cp(join(root, 'src/renderer/index.html'), join(dist, 'index.html')),
  stageEsmRuntime(requireFromGodview.resolve('@vibecook/ghosttea-electron/bridge-entry'), dist),
  cp(
    requireFromGodview.resolve('@vibecook/ghosttea-react/terminal-render.worker.js'),
    join(dist, 'terminal-render.worker.js'),
  ),
  ...(process.platform === 'darwin'
    ? [
        mkdir(join(dist, 'native'), { recursive: true }).then(() =>
          cp(nativeTabAddonPath(), join(dist, 'native', 'ghosttea_native_tabs.node')),
        ),
      ]
    : []),
]);
await writeFile(join(dist, '.built'), new Date().toISOString());
