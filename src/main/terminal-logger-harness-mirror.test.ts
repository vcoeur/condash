import { describe, expect, it } from 'vitest';

import { LOGGER_GRID_GEOMETRY } from './terminal-logger';
// The harness runs `main()` only when invoked as a script, so importing it here
// reads its constants without launching Electron.
import { LOGGER_GEOMETRY_MIRROR } from '../../scripts/perf-load.mjs';

/**
 * Lock the four logger constants `scripts/perf-load.mjs` hand-copies.
 *
 * The harness cannot import them: it is plain ESM run by bare `node`, this
 * module is TypeScript, and its relative imports are extensionless under
 * `moduleResolution: Bundler`, which Node's type stripping does not resolve. So
 * it keeps a copy — and until 2026-07-23 a comment there claimed
 * `terminal-logger-grid.test.ts` asserted the identity. It does not: that test
 * runs its own toy geometry (40 cols, 10 rows, scrollback 30) and asserts only
 * the SHAPE `bufferRows === SCROLLBACK + ROWS`, never the production values, and
 * nothing at all covered `scripts/`.
 *
 * That gap is the failure class the harness's own doctrine ("every precondition
 * is asserted, never assumed") exists to prevent. Changing `COLS` to 120 here
 * would have left the harness reporting rows-per-flush for a geometry the logger
 * no longer has — a wrong regime, which is exactly how the flood profile spent
 * four weeks looking like a valid reading — under a fully green suite.
 *
 * Values, not shape: a `scrollback + rows` identity holds for any numbers, and
 * it is the numbers the harness's arithmetic is built on.
 */
describe('perf-load harness geometry mirror', () => {
  it('matches the logger constant for constant', () => {
    expect(LOGGER_GEOMETRY_MIRROR).toEqual({
      cols: LOGGER_GRID_GEOMETRY.cols,
      rows: LOGGER_GRID_GEOMETRY.rows,
      scrollback: LOGGER_GRID_GEOMETRY.scrollback,
      flushMs: LOGGER_GRID_GEOMETRY.flushMs,
    });
  });

  it('agrees on the 5050-row buffer every turnover figure divides by', () => {
    const harnessBufferRows = LOGGER_GEOMETRY_MIRROR.scrollback + LOGGER_GEOMETRY_MIRROR.rows;
    expect(harnessBufferRows).toBe(LOGGER_GRID_GEOMETRY.scrollback + LOGGER_GRID_GEOMETRY.rows);
    // The literal the header comments, AGENTS.md and docs/reference/config.md
    // all quote. If this moves, those prose figures are stale too.
    expect(harnessBufferRows).toBe(5050);
  });
});
