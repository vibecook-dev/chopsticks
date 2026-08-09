import { defineConfig } from 'vitest/config';

/**
 * Same reason as `packages/imposter/vitest.config.ts`: these tests spawn `ai`
 * as a real process and drive it through a real adapter over a socket, and
 * vitest's default 5 s `testTimeout` is shorter than the waits inside them.
 *
 * It held on Linux and lost on Windows, where process spawn is several times
 * slower — reported as a bare "Test timed out in 5000ms", which says nothing
 * about which wait failed (2026-08-09).
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
