import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageEsmRuntime } from './stage-esm-runtime.mjs';

test('stages the complete relative ESM dependency graph', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chopsticks-esm-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'entry.js'), `import { connect } from "./socket.js";\nconnect();\n`);
  await writeFile(join(source, 'socket.js'), `export { connect } from "./nested/connect.js";\n`);
  await writeFile(join(source, 'nested', 'connect.js'), `export const connect = () => undefined;\n`);

  await stageEsmRuntime(join(source, 'entry.js'), destination);

  await assert.doesNotReject(readFile(join(destination, 'entry.js'), 'utf8'));
  await assert.doesNotReject(readFile(join(destination, 'socket.js'), 'utf8'));
  await assert.doesNotReject(readFile(join(destination, 'nested', 'connect.js'), 'utf8'));
});

test('rejects dependencies outside the runtime source directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chopsticks-esm-escape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(root, 'outside.js'), 'export const outside = true;\n');
  await writeFile(join(source, 'entry.js'), `export { outside } from "../outside.js";\n`);

  await assert.rejects(
    stageEsmRuntime(join(source, 'entry.js'), join(root, 'destination')),
    /dependency escapes its source directory/,
  );
});
