#!/usr/bin/env node

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const ghostteaRoot = join(root, '..', '..', '..', '..', 'electron-ghostty');
const nativeTabAddon = join(
  ghostteaRoot,
  'apps',
  'desktop-experiment',
  'native',
  'build',
  'Release',
  'ghosttea_native_tabs.node',
);
const shared = { bundle: true, sourcemap: true, logLevel: 'info' };
const requireFromWorkbench = createRequire(import.meta.url);
const reactSingletonPlugin = {
  name: 'workbench-react-singleton',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({
      path: requireFromWorkbench.resolve(args.path),
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
    external: ['electron', '@parcel/watcher'],
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
  cp(join(ghostteaRoot, 'packages', 'terminal-electron', 'dist', 'bridge-entry.js'), join(dist, 'bridge-entry.js')),
  cp(join(ghostteaRoot, 'packages', 'terminal-electron', 'dist', 'types.js'), join(dist, 'types.js')),
  cp(
    requireFromWorkbench.resolve('@vibecook/ghosttea-react/terminal-render.worker.js'),
    join(dist, 'terminal-render.worker.js'),
  ),
  ...(process.platform === 'darwin'
    ? [
        mkdir(join(dist, 'native'), { recursive: true }).then(() =>
          cp(nativeTabAddon, join(dist, 'native', 'ghosttea_native_tabs.node')),
        ),
      ]
    : []),
]);
await writeFile(join(dist, '.built'), new Date().toISOString());
