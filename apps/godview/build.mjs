#!/usr/bin/env node

import { addonPath as nativeTabAddonPath } from '@vibecook/ghosttea-native-tabs';
import { ghostteadPath } from '@vibecook/ghosttead';
import { resolveSidecarPath } from '@vibecook/truffle';
import { build } from 'esbuild';
import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { stageEsmRuntime } from '../../scripts/stage-esm-runtime.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const shared = { bundle: true, sourcemap: true, logLevel: 'info' };
const requireFromGodview = createRequire(import.meta.url);
const ghostteadBinary = process.platform === 'win32' ? 'ghosttead.exe' : 'ghosttead';
// The daemon is resolved here rather than in main: @vibecook/ghosttead is
// ESM-only, and Electron's bundled Node cannot require it from a CJS bundle —
// neither bundled nor external. Staging the binary is the alternative its
// README names. Throws where no prebuild exists, which is not fatal: that build
// just needs GHOSTTEAD_BIN at run time.
let stagedGhosttead;
try {
  stagedGhosttead = ghostteadPath();
} catch (error) {
  console.warn(`ghosttead not staged: ${error.message}`);
}
// Truffle's sidecar is staged the same way, so remote sessions need no Truffle
// checkout beside this repo either. Absent on platforms with no prebuild, which
// truffle-config reports as a missing sidecar when Truffle is enabled.
const sidecarBinary = process.platform === 'win32' ? 'sidecar-slim.exe' : 'sidecar-slim';
let stagedSidecar;
try {
  stagedSidecar = resolveSidecarPath();
} catch (error) {
  console.warn(`truffle sidecar not staged: ${error.message}`);
}
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
  ...(stagedGhosttead
    ? [
        mkdir(join(dist, 'bin'), { recursive: true })
          .then(() => cp(stagedGhosttead, join(dist, 'bin', ghostteadBinary)))
          // cp drops the executable bit when it creates the destination.
          .then(() => chmod(join(dist, 'bin', ghostteadBinary), 0o755)),
      ]
    : []),
  ...(stagedSidecar
    ? [
        mkdir(join(dist, 'bin'), { recursive: true })
          .then(() => cp(stagedSidecar, join(dist, 'bin', sidecarBinary)))
          .then(() => chmod(join(dist, 'bin', sidecarBinary), 0o755)),
      ]
    : []),
]);
await writeFile(join(dist, '.built'), new Date().toISOString());
