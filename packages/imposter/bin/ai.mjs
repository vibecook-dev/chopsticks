#!/usr/bin/env node
/**
 * The `ai` executable (draft/IMPOSTER.md §6). Kept as a thin `.mjs` shim so
 * node's type stripping enters the TypeScript sources directly — no build step
 * in development, ordinary ESM once published.
 */
import { main } from '@vibecook/chopsticks-imposter/cli';

main(process.argv.slice(2), process.argv[1]).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error) => {
    process.stderr.write(`imposter: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
