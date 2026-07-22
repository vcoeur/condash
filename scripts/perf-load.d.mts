/**
 * Types for the one export `scripts/perf-load.mjs` offers to TypeScript.
 *
 * The harness is plain ESM run by bare `node` and stays that way; this exists
 * only so `src/main/terminal-logger-harness-mirror.test.ts` can import its
 * mirrored logger geometry under `tsc`. Shapes only — the values are the whole
 * point of that test and must come from the script itself.
 */

export declare const LOGGER_GEOMETRY_MIRROR: {
  cols: number;
  rows: number;
  scrollback: number;
  flushMs: number;
};
