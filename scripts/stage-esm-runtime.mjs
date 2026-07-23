import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const LOCAL_JAVASCRIPT_IMPORT = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+\.js)['"]/g;

/**
 * Copy an ESM entry point and the transitive relative JavaScript modules it
 * imports. Directory structure is preserved beneath the entry point's source
 * directory so the staged graph remains directly executable.
 */
export async function stageEsmRuntime(entryPoint, destinationDirectory) {
  const sourceDirectory = dirname(entryPoint);
  const pending = [resolve(entryPoint)];
  const visited = new Set();

  while (pending.length > 0) {
    const source = pending.pop();
    if (!source || visited.has(source)) continue;
    visited.add(source);

    const relativePath = relative(sourceDirectory, source);
    if (
      isAbsolute(relativePath) ||
      relativePath === '..' ||
      relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      throw new Error(`ESM runtime dependency escapes its source directory: ${source}`);
    }

    const contents = await readFile(source, 'utf8');
    const destination = join(destinationDirectory, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);

    for (const match of contents.matchAll(LOCAL_JAVASCRIPT_IMPORT)) {
      pending.push(resolve(dirname(source), match[1]));
    }
  }
}
