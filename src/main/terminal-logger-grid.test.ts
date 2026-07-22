import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';

import { GridBodyRenderer, SessionLogger, type SessionContext } from './terminal-logger';
import { splitContent } from './logs-format';

/** Small geometry keeps the fixtures readable while still exercising eviction:
 *  the buffer saturates after `SCROLLBACK + ROWS` rows, which is where the
 *  index-shifting the cache has to survive begins. */
const COLS = 40;
const ROWS = 10;
const SCROLLBACK = 30;

function newTerm(scrollback = SCROLLBACK): Terminal {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback, allowProposedApi: true });
}

/** Feed `data` and wait for xterm to finish parsing it, mirroring the drain the
 *  logger's flush does before rendering. */
function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/**
 * The pre-fix renderer: translate every populated row, every time. This is the
 * oracle — {@link GridBodyRenderer} is only correct if it returns exactly this,
 * so the assertions compare against it rather than against literal fixtures.
 */
function fullRender(term: Terminal): string {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    rows.push(line ? line.translateToString(true) : '');
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

interface TranslatingLine {
  translateToString(trimRight?: boolean): string;
}

/** Count `translateToString` calls by patching the shared `IBufferLine` view
 *  prototype — the row walk is what the fix removes, so the row count is the
 *  thing worth asserting on. */
function spyOnTranslate(term: Terminal): { count(): number; restore(): void } {
  const sample = term.buffer.active.getLine(0);
  if (!sample) throw new Error('buffer has no rows to spy on');
  const proto = Object.getPrototypeOf(sample) as TranslatingLine;
  const original = proto.translateToString;
  let calls = 0;
  proto.translateToString = function (this: TranslatingLine, trimRight?: boolean): string {
    calls++;
    return original.call(this, trimRight);
  };
  return {
    count: () => calls,
    restore: () => {
      proto.translateToString = original;
    },
  };
}

/** Deterministic PRNG so a fuzz failure is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

let restoreSpy: (() => void) | null = null;
afterEach(() => {
  restoreSpy?.();
  restoreSpy = null;
});

describe('GridBodyRenderer row walk', () => {
  it('re-translates only the rows that can still change, not the whole scrollback', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    // Saturate the scrollback so a full walk is the expensive thing.
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `row-${i}\r\n`);
    renderer.render(); // establishes the cache

    const bufferRows = term.buffer.active.length;
    expect(bufferRows).toBe(SCROLLBACK + ROWS);

    // Three more lines: three rows evicted, so the frozen prefix slides by three
    // and only the viewport plus those rows need re-translating.
    for (let i = 0; i < 3; i++) await write(term, `tail-${i}\r\n`);

    const spy = spyOnTranslate(term);
    restoreSpy = spy.restore;
    renderer.render();
    spy.restore();
    restoreSpy = null;

    // Pre-fix this was one call per buffer row, every flush.
    expect(spy.count()).toBeLessThanOrEqual(ROWS + 3);
    expect(spy.count()).toBeLessThan(bufferRows);
    term.dispose();
  });

  it('still walks every row on the first render, with no cache to draw on', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `row-${i}\r\n`);

    const spy = spyOnTranslate(term);
    restoreSpy = spy.restore;
    renderer.render();
    spy.restore();
    restoreSpy = null;

    expect(spy.count()).toBe(term.buffer.active.length);
    term.dispose();
  });
});

describe('GridBodyRenderer cache invariants', () => {
  // Both of these defend an invariant the implementation states in a comment but
  // that nothing else exercises: the review that found them confirmed the whole
  // suite — seeded fuzz included — stays green with either one broken.

  it('caches the frozen rows before the trailing-blank pop, not after', async () => {
    // `render()` snapshots the cache BEFORE dropping the trailing run of empty
    // rows, because that pop can reach back into the frozen prefix: a cleared
    // screen leaves the tail of scrollback blank. Snapshot after the pop and the
    // cache is short by the blank depth, then a later eviction pulls the slide
    // back to exactly zero so the arithmetic guard waves it through — and the
    // body emits the wrong scrollback rows with no error at all.
    //
    // The shape is routine: `clear`, then a long build log.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `row-${i}\r\n`);
    await write(term, '\x1b[2J');
    for (let i = 0; i < ROWS; i++) await write(term, `\r\n`);
    renderer.render();
    for (let i = 0; i < ROWS; i++) await write(term, `after-${i}\r\n`);

    expect(renderer.render()).toBe(fullRender(term));
  });

  it('keeps at most one live marker across many renders', async () => {
    // xterm walks every live marker on every evicted line, so leaking one per
    // flush degrades eviction without bound — a slow leak on a long-lived tab,
    // invisible to any output-equality test.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < 200; i++) {
      await write(term, `line-${i}\r\n`);
      renderer.render();
    }
    const markers = (term as unknown as { _core: { markers: unknown[] } })._core.markers;
    expect(markers.length).toBeLessThanOrEqual(1);
  });
});

describe('GridBodyRenderer output equals a full re-render', () => {
  it('matches while the buffer grows and once it starts evicting', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + ROWS + 40; i++) {
      await write(term, `line-${i}\r\n`);
      expect(renderer.render()).toBe(fullRender(term));
    }
    term.dispose();
  });

  it('matches when the viewport is rewritten in place without scrolling', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + ROWS + 5; i++) await write(term, `line-${i}\r\n`);
    renderer.render();
    // A TUI redrawing its viewport: no new lines, so nothing is evicted and the
    // whole frozen prefix is reused — but every viewport row changed.
    await write(term, '\x1b[3;1Hredrawn-row-three');
    expect(renderer.render()).toBe(fullRender(term));
    term.dispose();
  });

  it('matches after CSI L inserts at the viewport top and a later scroll evicts a row', async () => {
    // The regression that forces the marker to be pinned at `baseY - 1` rather
    // than at `baseY`: `CSI L` with the cursor on the viewport's top row
    // inserts at index `baseY`, which drags a marker pinned there one row down
    // into the viewport, and the eviction below then cancels the sign of that
    // slide so the arithmetic guard no longer rejects the cache. The result is a
    // body off by exactly one row — a silently dropped line, not a crash.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `fill-${i}\r\n`);
    renderer.render();
    await write(term, '\x1b[1;1H\x1b[1L');
    await write(term, `\x1b[${ROWS};1H\r\n`);
    expect(renderer.render()).toBe(fullRender(term));
    term.dispose();
  });

  // The two buffer-swap cases below deliberately build only a SHALLOW scrollback
  // before the swap. With a deep one the cached prefix is longer than the buffer
  // that replaces it, so `reusableRows`' arithmetic guard rejects the cache and
  // the render comes out right even without invalidation — the test would pass
  // over the bug. A shallow prefix fits inside the replacement buffer, so only
  // the invalidation itself can save the output.
  const SHALLOW = ROWS + 4;

  it('matches across an alternate-screen switch and back', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SHALLOW; i++) await write(term, `normal-${i}\r\n`);
    renderer.render();

    await write(term, '\x1b[?1049h'); // enter alt screen — a different buffer
    await write(term, 'alt screen contents\r\n');
    expect(renderer.render()).toBe(fullRender(term));

    await write(term, '\x1b[?1049l'); // back to the normal buffer
    await write(term, 'back on normal\r\n');
    expect(renderer.render()).toBe(fullRender(term));
    term.dispose();
  });

  it('matches after a full reset (RIS) swaps the buffer out', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SHALLOW; i++) await write(term, `before-${i}\r\n`);
    renderer.render();
    await write(term, '\x1bc'); // RIS — BufferSet.reset() installs brand new buffers
    await write(term, 'after reset\r\n');
    expect(renderer.render()).toBe(fullRender(term));
    term.dispose();
  });

  it('matches after CSI 3 J clears the scrollback out from under the cache', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + 5; i++) await write(term, `kept-${i}\r\n`);
    renderer.render();
    await write(term, '\x1b[3J'); // drop everything above the viewport
    await write(term, 'after clear\r\n');
    expect(renderer.render()).toBe(fullRender(term));
    term.dispose();
  });

  it('matches over a randomised control-sequence stream', async () => {
    const random = makeRandom(0xc0ffee);
    const pick = (n: number): number => Math.floor(random() * n);
    const pieces: (() => string)[] = [
      () => `line-${pick(1000)}\r\n`,
      () => 'x'.repeat(pick(120) + 1) + '\r\n', // wraps into several buffer rows
      () => `\x1b[${pick(ROWS) + 1};${pick(COLS) + 1}Hoverwrite-${pick(100)}`,
      () => '\x1b[2J', // erase display
      () => '\x1b[3J', // erase scrollback
      () => '\x1b[?1049h', // alt screen on
      () => '\x1b[?1049l', // alt screen off
      () => `\x1b[${pick(ROWS) + 1};${ROWS}r`, // DECSTBM scroll region
      () => '\x1b[r', // reset scroll region
      () => `\x1b[${pick(4) + 1}L`, // insert lines
      () => `\x1b[${pick(4) + 1}M`, // delete lines
      () => `\x1b[${pick(4) + 1}S`, // scroll up
      () => `\x1b[${pick(4) + 1}T`, // scroll down
      () => '\x1bc', // full reset
      () => '\r\n'.repeat(pick(60) + 1), // bulk eviction
    ];

    for (let run = 0; run < 40; run++) {
      const term = newTerm();
      const renderer = new GridBodyRenderer(term);
      for (let step = 0; step < 60; step++) {
        const chunk = pieces[pick(pieces.length)]();
        await write(term, chunk);
        expect(renderer.render(), `run ${run} step ${step}`).toBe(fullRender(term));
      }
      term.dispose();
    }
    // 40 runs is what fits comfortably in the suite; the same fuzz was driven to
    // 400 runs across several seeds (72k comparisons) while developing the fix.
  }, 30_000);
});

describe('SessionLogger grid body on disk', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'condash-logger-grid-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const ctx: SessionContext = {
    sid: 't-grid',
    side: 'my',
    cwd: '/x',
    spawn: { cmd: 'bash', argv: [] },
  };

  it('writes the same bytes the full re-render would, across many flushes', async () => {
    const logger = new SessionLogger(
      tmp,
      ctx,
      { enabled: true, scrollback: SCROLLBACK, markerIntervalSec: 0 },
      50,
    );
    logger.spawn();
    // A second terminal fed the identical byte stream is the oracle: same
    // geometry, same input, so a full render of it is what the log must hold.
    // The logger's headless term is fixed at 200x50 (COLS/ROWS in the module
    // under test), so the oracle has to match that, not this file's geometry.
    const oracle = new Terminal({
      cols: 200,
      rows: 50,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });

    const chunks = [
      'plain line one\r\n',
      'y'.repeat(450) + '\r\n', // wraps across buffer rows
      // Enough to saturate the 50-row viewport plus the scrollback, so the run
      // covers both the growing and the evicting regime.
      ...Array.from({ length: SCROLLBACK + 50 + 15 }, (_, i) => `bulk-${i}\r\n`),
      '\x1b[4;1Hin-place redraw',
      '\x1b[1;1H\x1b[2L', // insert lines at the viewport top
      'tail after inserts\r\n',
    ];
    for (const chunk of chunks) {
      logger.output(chunk);
      await write(oracle, chunk);
      await logger.flushForTests();
    }
    await logger.close();

    const { text } = splitContent(readFileSync(logger.filePath()!, 'utf8'));
    expect(text).toBe(fullRender(oracle));
    // Guard the fixture itself: a body this test could pass on trivially (an
    // empty one) would make the comparison meaningless.
    expect(text).toContain('tail after inserts');
    oracle.dispose();
  });
});
