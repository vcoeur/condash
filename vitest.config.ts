import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
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
