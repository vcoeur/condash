import { defineConfig } from 'vitest/config';
import { PERF_LOOP_DELAY_TESTS, sharedResolve } from './vitest.config';

/**
 * Second half of the split unit suite: the loop-delay timing tests, run alone
 * and one file at a time. See `PERF_LOOP_DELAY_TESTS` in `vitest.config.ts` for
 * why they cannot share a run with the other 180 files.
 *
 * Not reachable from a bare `vitest run` — `npm run test:unit` invokes both
 * configs in sequence, and that is what the Makefile and the CI fast lane call.
 */
export default defineConfig({
  test: {
    include: [...PERF_LOOP_DELAY_TESTS],
    environment: 'node',
    reporters: ['default'],
    fileParallelism: false,
  },
  resolve: sharedResolve,
});
