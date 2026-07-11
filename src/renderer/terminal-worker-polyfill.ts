// Polyfill `window` for @xterm/headless in a Web Worker environment.
// xterm-headless assumes a browser `window` global, but in a worker the global
// is `self`. This module must be imported before any xterm module so its
// top-level code sees the polyfill.
if (typeof window === 'undefined') {
  // @ts-expect-error — worker global is `self`, not `window`.
  globalThis.window = globalThis;
}
