import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [solid()],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  server: {
    port: 5600,
    strictPort: true,
  },
  preview: {
    port: 5601,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome130',
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // xterm's headless build still references `window` in a few places
        // (e.g. `"requestIdleCallback" in window`). In a Web Worker the global
        // is `self`, so alias `window` before any module code runs.
        banner: 'self.window = self;',
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // Vite's worker bundler does not resolve @xterm/headless through its
      // package.json module field, so point it at the ESM build explicitly.
      '@xterm/headless': resolve(__dirname, 'node_modules/@xterm/headless/lib-headless/xterm-headless.mjs'),
    },
  },
});
