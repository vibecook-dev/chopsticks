import { defineConfig } from 'vitest/config';

/**
 * The first vitest config in this repo, and it exists for one reason.
 *
 * Most suites here are pure. This package's are not: conformance spawns `ai`
 * as a real process and drives it through a real adapter, and those tests wait
 * up to 8 s internally for a turn to complete. Vitest's default `testTimeout`
 * is 5 s — SHORTER than the deadline the tests set for themselves — so under
 * any load the runner killed the test first and reported "Test timed out in
 * 5000ms" instead of the honest "timed out waiting for turn.completed".
 *
 * That is worse than a slow test: it hides which wait failed. Locally these
 * finish in ~300 ms and never came close; the first CI run on a loaded runner
 * found it immediately (2026-08-08).
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
