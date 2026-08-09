import { defineConfig } from 'vitest/config';

/**
 * The first vitest config in this repo, and it exists for one reason: most
 * suites here are pure, and this package's are not. Conformance spawns `ai` as
 * a real process and drives it through a real adapter.
 *
 * `testTimeout` is 20 s because vitest's default 5 s is SHORTER than the waits
 * the tests set for themselves, so the runner killed them first and reported
 * "Test timed out in 5000ms" instead of naming the milestone that was missed.
 *
 * `fileParallelism: false` because raising the deadline was not enough: a
 * 15 s wait for `session.started` still expired on a two-core runner, which is
 * not slowness, it is contention. Several suites spawning node processes at
 * once starve each other, and node's type stripping means every spawn compiles
 * the source tree afresh. Serial is both honest about what these tests are and,
 * under contention, faster than thrashing.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
