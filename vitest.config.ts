import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * The two test files that measure real event-loop timing. Their assertions
 * compare against the deliberate busy-waits in other test files, so they flake
 * whenever anything else runs alongside (observed: perf-log p50, perf-renderer
 * 24.9 > 20). vitest 2.1.9 cannot isolate a subset in-process — `poolMatchGlobs`
 * to the default pool name is a no-op, and all pools are scheduled concurrently
 * — so the only reliable isolation is a second `vitest run`. These files are
 * excluded here and are the entire `include` of `vitest.perf.config.ts`;
 * `npm run test:unit` runs both invocations in sequence.
 *
 * Serializing the whole suite instead (`fileParallelism: false`, v4.101.3) also
 * worked, but cost 97.5 s of wall clock against 28.9 s parallel and doubled the
 * CI fast-leg vitest step from 35 s to 69 s. The split measures 31.7 s + 4.4 s.
 *
 * `tests/vitest-split-guard.test.ts` pins that both invocations stay wired up —
 * a bare `vitest run` covers only the first half.
 */
export const PERF_LOOP_DELAY_TESTS = [
  'src/main/perf-log.test.ts',
  'src/renderer/perf-renderer.test.ts',
] as const;

/** Alias block shared with `vitest.perf.config.ts`. */
export const sharedResolve = {
  alias: [
    { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
    // Vitest resolves packages under the `node` condition, which hands
    // solid-js its SSR build — one where `createEffect` never runs. A renderer
    // test would then drive a controller whose effects are all no-ops and
    // silently assert nothing (`controller.test.ts` exists precisely because
    // that wiring is where this codebase's regressions live). Pin the client
    // build. Exact-match regexes so `solid-js/web` is not swallowed by the
    // bare-specifier rule.
    { find: /^solid-js$/, replacement: resolve(__dirname, 'node_modules/solid-js/dist/dev.js') },
    {
      find: /^solid-js\/web$/,
      replacement: resolve(__dirname, 'node_modules/solid-js/web/dist/dev.js'),
    },
  ],
};

export default defineConfig({
  test: {
    // src/**/*.test.ts are the CLI/unit suites; tests/**/*.test.ts hosts the
    // docs-drift guards (the Playwright specs in tests/ are *.spec.ts and are
    // deliberately excluded).
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Spread the defaults — assigning `exclude` replaces them, which would
    // otherwise walk node_modules/ and dist/.
    exclude: [...configDefaults.exclude, ...PERF_LOOP_DELAY_TESTS],
    environment: 'node',
    reporters: ['default'],
  },
  resolve: sharedResolve,
});
