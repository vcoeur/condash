import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // src/**/*.test.ts are the CLI/unit suites; tests/**/*.test.ts hosts the
    // docs-drift guards (the Playwright specs in tests/ are *.spec.ts and are
    // deliberately excluded).
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    // The perf loop-delay tests measure real event-loop timing against a busy
    // machine: under the default threaded pool, other test files' deliberate
    // busy-waits inflate the p50 and the timing assertions flake. Run them in
    // their own single-fork child so nothing else competes with their loop.
    poolMatchGlobs: [
      ['src/main/perf-log.test.ts', 'forks'],
      ['src/renderer/perf-renderer.test.ts', 'forks'],
    ],
    poolOptions: {
      forks: { singleFork: true },
    },
  },
  resolve: {
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
  },
});
