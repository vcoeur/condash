import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';

import {
  GridBodyRenderer,
  SessionLogger,
  type GridBodyDelta,
  type SessionContext,
} from './terminal-logger';
import { splitContent } from './logs-format';

/** Small geometry keeps the fixtures readable while still exercising eviction:
 *  the buffer saturates after `SCROLLBACK + ROWS` rows, which is where the
 *  index-shifting the append watermark has to survive begins. */
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
 * The repaint renderer: translate every populated row, every time. This is the
 * oracle. An appended body is not equal to it — it also holds output the buffer
 * has since evicted — but it must always END with it: every flush leaves on disk
 * exactly what the repaint would have written, plus older history in front.
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

/** The writer's half of the contract: appended rows accumulate, the tail is
 *  replaced wholesale. Mirrors what `SessionLogger` puts on disk, so a renderer
 *  bug shows up as a wrong body rather than as wrong bookkeeping. */
class GridBodyModel {
  private readonly frozen: string[] = [];
  private tail: string[] = [];

  apply(delta: GridBodyDelta): void {
    this.frozen.push(...delta.frozen);
    this.tail = delta.tail;
  }

  body(): string {
    return [...this.frozen, ...this.tail].join('\n');
  }

  frozenRows(): readonly string[] {
    return this.frozen;
  }
}

/** Render + commit one flush's delta into `model`. */
function flush(renderer: GridBodyRenderer, model: GridBodyModel): void {
  const delta = renderer.renderDelta();
  renderer.commit();
  model.apply(delta);
}

interface TranslatingLine {
  translateToString(trimRight?: boolean): string;
}

/** Count `translateToString` calls by patching the shared `IBufferLine` view
 *  prototype — the row walk is what stays bounded, so the row count is the
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
  it('translates only the rows not already on disk, not the whole scrollback', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    // Saturate the scrollback so a full walk is the expensive thing.
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `row-${i}\r\n`);
    flush(renderer, model); // establishes the append watermark

    const bufferRows = term.buffer.active.length;
    expect(bufferRows).toBe(SCROLLBACK + ROWS);

    // Three more lines: three rows evicted, so the watermark slides by three and
    // only the viewport plus those rows need re-translating.
    for (let i = 0; i < 3; i++) await write(term, `tail-${i}\r\n`);

    const spy = spyOnTranslate(term);
    restoreSpy = spy.restore;
    flush(renderer, model);
    spy.restore();
    restoreSpy = null;

    expect(spy.count()).toBeLessThanOrEqual(ROWS + 3);
    expect(spy.count()).toBeLessThan(bufferRows);
    term.dispose();
  });

  it('still walks every row on the first render, with nothing on disk yet', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `row-${i}\r\n`);

    const spy = spyOnTranslate(term);
    restoreSpy = spy.restore;
    renderer.renderDelta();
    spy.restore();
    restoreSpy = null;

    expect(spy.count()).toBe(term.buffer.active.length);
    term.dispose();
  });
});

describe('GridBodyRenderer append watermark', () => {
  it('keeps at most one live marker across many flushes', async () => {
    // xterm walks every live marker on every evicted line, so leaking one per
    // flush degrades eviction without bound — a slow leak on a long-lived tab,
    // invisible to any output-equality test.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < 200; i++) {
      await write(term, `line-${i}\r\n`);
      flush(renderer, model);
    }
    const markers = (term as unknown as { _core: { markers: unknown[] } })._core.markers;
    expect(markers.length).toBeLessThanOrEqual(1);
  });

  it('an abandoned delta is re-offered in full — a failed write appends nothing twice', async () => {
    // The writer abandons a delta whenever the file guard fails or the write
    // errors. The watermark must still describe the FILE, so the next render
    // offers the same rows again rather than skipping past them.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    for (let i = 0; i < SCROLLBACK + ROWS + 5; i++) await write(term, `row-${i}\r\n`);
    const first = renderer.renderDelta();
    renderer.abandon();
    const second = renderer.renderDelta();
    renderer.commit();
    expect(second.frozen).toEqual(first.frozen);
    expect(second.tail).toEqual(first.tail);
    // And after the commit the same render yields nothing new.
    const third = renderer.renderDelta();
    renderer.commit();
    expect(third.frozen).toEqual([]);
    term.dispose();
  });

  it('never appends a trailing blank row, so the appended region is byte-stable', async () => {
    // `\x1b[2J` then newlines pushes blank rows into scrollback. Freezing them
    // would put trailing blanks in the immutable region, where the body's
    // trailing-blank trim can never reach them again.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `row-${i}\r\n`);
    await write(term, '\x1b[2J');
    for (let i = 0; i < ROWS; i++) await write(term, '\r\n');
    flush(renderer, model);
    const frozen = model.frozenRows();
    expect(frozen.length).toBeGreaterThan(0);
    expect(frozen[frozen.length - 1]).not.toBe('');
    expect(model.body()).toBe(fullRender(term));

    for (let i = 0; i < ROWS; i++) await write(term, `after-${i}\r\n`);
    flush(renderer, model);
    expect(model.body().endsWith(fullRender(term))).toBe(true);
    term.dispose();
  });
});

describe('GridBodyRenderer body ends with the repaint it replaces', () => {
  /** The invariant every case below asserts. */
  function expectSuffix(model: GridBodyModel, term: Terminal, where: string): void {
    const body = model.body();
    const snapshot = fullRender(term);
    expect(
      body.endsWith(snapshot),
      `${where}\n--- body ---\n${body}\n--- want suffix ---\n${snapshot}`,
    ).toBe(true);
  }

  it('matches exactly while the buffer grows, and keeps history once it evicts', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SCROLLBACK + ROWS + 40; i++) {
      await write(term, `line-${i}\r\n`);
      flush(renderer, model);
      expectSuffix(model, term, `step ${i}`);
      // Nothing has been evicted yet, so the body IS the repaint, byte for byte.
      if (i < SCROLLBACK + ROWS - 1) expect(model.body()).toBe(fullRender(term));
    }
    // Past saturation the body keeps what the repaint dropped.
    expect(model.body()).toContain('line-0');
    expect(fullRender(term)).not.toContain('line-0');
    term.dispose();
  });

  it('matches when the viewport is rewritten in place without scrolling', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SCROLLBACK + ROWS + 5; i++) await write(term, `line-${i}\r\n`);
    flush(renderer, model);
    // A TUI redrawing its viewport: no new lines, so nothing freezes and the
    // whole tail is rewritten — but every viewport row changed.
    await write(term, '\x1b[3;1Hredrawn-row-three');
    flush(renderer, model);
    expectSuffix(model, term, 'in-place redraw');
    term.dispose();
  });

  it('matches after CSI L inserts at the viewport top and a later scroll evicts a row', async () => {
    // The regression that forces the marker to be pinned inside the frozen
    // region rather than at `baseY`: `CSI L` with the cursor on the viewport's
    // top row inserts at index `baseY`, which drags a marker pinned there one
    // row down into the viewport, and the eviction below then cancels the sign
    // of that slide so the guard no longer rejects it. The result is a body off
    // by exactly one row — a silently dropped line, not a crash.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SCROLLBACK + ROWS + 20; i++) await write(term, `fill-${i}\r\n`);
    flush(renderer, model);
    await write(term, '\x1b[1;1H\x1b[1L');
    await write(term, `\x1b[${ROWS};1H\r\n`);
    flush(renderer, model);
    expectSuffix(model, term, 'CSI L then eviction');
    term.dispose();
  });

  // The two buffer-swap cases below deliberately build only a SHALLOW scrollback
  // before the swap. With a deep one the replacement buffer is shorter than the
  // stale watermark, so the guard rejects it and the body comes out right even
  // without the swap hook — the test would pass over the bug.
  const SHALLOW = ROWS + 4;

  it('matches across an alternate-screen switch and back', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SHALLOW; i++) await write(term, `normal-${i}\r\n`);
    flush(renderer, model);
    const beforeAlt = model.body();

    await write(term, '\x1b[?1049h'); // enter alt screen — a different buffer
    await write(term, 'alt screen contents\r\n');
    flush(renderer, model);
    expectSuffix(model, term, 'alt screen');
    // The alt screen has no scrollback, so nothing of it is ever frozen.
    expect(model.frozenRows().join('\n')).not.toContain('alt screen contents');

    await write(term, '\x1b[?1049l'); // back to the normal buffer
    await write(term, 'back on normal\r\n');
    flush(renderer, model);
    expectSuffix(model, term, 'back from alt screen');
    // The normal buffer's history survived the round trip — the watermark was
    // not thrown away and its rows were not appended a second time.
    expect(model.body().startsWith(beforeAlt.split('\n')[0])).toBe(true);
    expect(model.body().match(/normal-0/g) ?? []).toHaveLength(1);
    term.dispose();
  });

  it('matches after a full reset (RIS) swaps the buffer out', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SHALLOW; i++) await write(term, `before-${i}\r\n`);
    flush(renderer, model);
    await write(term, '\x1bc'); // RIS — BufferSet.reset() installs brand new buffers
    await write(term, 'after reset\r\n');
    flush(renderer, model);
    expectSuffix(model, term, 'after RIS');
    term.dispose();
  });

  it('matches when RIS is followed by enough output to make the stale watermark plausible', async () => {
    // The reason the reset is caught in `onBufferChange` rather than at render
    // time: a fresh buffer has `baseY === 0`, which rejects any watermark — but
    // by the next flush the new output has pushed `baseY` well past the stale
    // line, and a render-time check alone would wave it through.
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SHALLOW; i++) await write(term, `before-${i}\r\n`);
    flush(renderer, model);
    await write(term, '\x1bc');
    for (let i = 0; i < SCROLLBACK + ROWS + 5; i++) await write(term, `fresh-${i}\r\n`);
    flush(renderer, model);
    expectSuffix(model, term, 'RIS then regrowth');
    term.dispose();
  });

  it('matches after CSI 3 J clears the scrollback out from under the watermark', async () => {
    const term = newTerm();
    const renderer = new GridBodyRenderer(term);
    const model = new GridBodyModel();
    for (let i = 0; i < SCROLLBACK + 5; i++) await write(term, `kept-${i}\r\n`);
    flush(renderer, model);
    await write(term, '\x1b[3J'); // drop everything above the viewport
    await write(term, 'after clear\r\n');
    flush(renderer, model);
    expectSuffix(model, term, 'after CSI 3J');
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
      const model = new GridBodyModel();
      for (let step = 0; step < 60; step++) {
        const chunk = pieces[pick(pieces.length)]();
        await write(term, chunk);
        flush(renderer, model);
        expectSuffix(model, term, `run ${run} step ${step}`);
      }
      term.dispose();
    }
    // 40 runs is what fits comfortably in the suite; the same fuzz was driven to
    // 400 runs across several seeds while developing the change.
  }, 30_000);

  it('never duplicates or reorders a row over the full control-sequence stream', async () => {
    // The `endsWith` oracle above cannot see a duplicated append: re-appending
    // rows that are already on disk still leaves the repaint as the body's
    // suffix. The unique-line fuzz below can, but it emits no control sequence
    // at all — so between them the interesting case, duplication UNDER a buffer
    // swap, was uncovered. This is that case: every emitted row carries a unique
    // token, and the whole control-sequence vocabulary runs over it.
    //
    // The oracle is "no token appears twice", and only that. Loss is legitimate
    // here (2J, 3J, RIS and eviction all destroy rows) and so, it turns out, is
    // reordering: leaving the alternate screen RESTORES the pre-excursion
    // cursor, so the next line can land above rows that are older than it —
    // measured, with the headless buffer itself reading `46,44,45`, which is a
    // terminal doing its job and not a writer losing track. Duplication is the
    // half that can only come from the writer: nothing in the vocabulary copies
    // content — inserts add blanks, deletes and scrolls move rows — and it is
    // exactly the failure the `endsWith` oracle is blind to, because re-writing
    // rows that are already on disk still leaves the repaint as the suffix.
    const random = makeRandom(0x7ab1e5);
    const pick = (n: number): number => Math.floor(random() * n);
    let next = 0;
    const token = (): string => `T${next++}|`;
    const pieces: (() => string)[] = [
      () => `${token()}line\r\n`,
      () => token() + 'x'.repeat(pick(120) + 1) + '\r\n', // wraps into several rows
      // Deliberately NOT token-bearing: a cursor-addressed write puts new text
      // ABOVE older text by design, so a token there would break monotonicity
      // for a reason that has nothing to do with the writer. Tokens ride only
      // the paths that append in order.
      () => `\x1b[${pick(ROWS) + 1};1Hoverwrite-${pick(100)}`,
      () => '\x1b[2J',
      () => '\x1b[3J',
      () => '\x1b[?1049h',
      () => '\x1b[?1049l',
      () => `\x1b[${pick(ROWS) + 1};${ROWS}r`,
      () => '\x1b[r',
      () => `\x1b[${pick(4) + 1}L`,
      () => `\x1b[${pick(4) + 1}M`,
      () => `\x1b[${pick(4) + 1}S`,
      () => `\x1b[${pick(4) + 1}T`,
      () => '\x1bc',
      () => Array.from({ length: pick(20) + 1 }, () => `${token()}bulk\r\n`).join(''),
    ];

    for (let run = 0; run < 20; run++) {
      const term = newTerm();
      const renderer = new GridBodyRenderer(term);
      const model = new GridBodyModel();
      for (let step = 0; step < 60; step++) {
        await write(term, pieces[pick(pieces.length)]());
        flush(renderer, model);
        const countTokens = (text: string): Map<number, number> => {
          const counts = new Map<number, number>();
          for (const match of text.match(/T(\d+)\|/g) ?? []) {
            const id = Number(match.slice(1, -1));
            counts.set(id, (counts.get(id) ?? 0) + 1);
          }
          return counts;
        };
        for (const [id, count] of countTokens(model.body())) {
          expect(count, `run ${run} step ${step}: token ${id} appears ${count}x in the body`).toBe(
            1,
          );
        }
        // Tighter still on the half that is written once and never revisited.
        for (const [id, count] of countTokens(model.frozenRows().join('\n'))) {
          expect(
            count,
            `run ${run} step ${step}: token ${id} appears ${count}x in the appended history`,
          ).toBe(1);
        }
      }
      term.dispose();
    }
  }, 30_000);

  it('loses nothing to an alternate-screen excursion, and repeats nothing after it', async () => {
    // A TUI opening and closing over a shell session. The normal buffer's rows
    // are untouched by the alt screen, so nothing may go missing across the
    // round trip — and the watermark that survives it must not re-append what it
    // already wrote. Alt frames have no scrollback, so they may never reach the
    // appended history at all.
    const random = makeRandom(0xa17e54);
    const pick = (n: number): number => Math.floor(random() * n);
    for (let run = 0; run < 8; run++) {
      const term = newTerm();
      const renderer = new GridBodyRenderer(term);
      const model = new GridBodyModel();
      let next = 0;
      for (let step = 0; step < 30; step++) {
        if (pick(3) === 0) {
          await write(term, '\x1b[?1049h');
          for (let i = 0; i < pick(ROWS) + 1; i++) await write(term, `ALTFRAME-${i}\r\n`);
          flush(renderer, model);
          // While the alt screen is up it IS the body's tail, and none of it is
          // frozen — the normal buffer's history sits underneath, untouched.
          expect(model.frozenRows().join('\n')).not.toContain('ALTFRAME');
          await write(term, '\x1b[?1049l');
        }
        let chunk = '';
        for (let i = 0; i < pick(SCROLLBACK) + 1; i++) chunk += `line-${next++}\r\n`;
        await write(term, chunk);
        flush(renderer, model);
        const body = model.body();
        const seen = (body.match(/line-(\d+)/g) ?? []).map((m) => Number(m.slice('line-'.length)));
        expect(seen, `run ${run} step ${step}`).toEqual(Array.from({ length: next }, (_, i) => i));
        expect(body, `run ${run} step ${step}`).not.toContain('ALTFRAME');
      }
      term.dispose();
    }
  }, 30_000);

  it('never duplicates or reorders a line over a randomised burst stream', async () => {
    // The suffix invariant above cannot see a duplicated append: re-appending
    // rows that are already on disk still leaves the repaint as the body's
    // suffix. Unique line numbers can. Bursts stay under the buffer size, so
    // nothing is evicted between flushes and no line may go missing either.
    const random = makeRandom(0x5eed17);
    const pick = (n: number): number => Math.floor(random() * n);
    for (let run = 0; run < 8; run++) {
      const term = newTerm();
      const renderer = new GridBodyRenderer(term);
      const model = new GridBodyModel();
      let next = 0;
      for (let step = 0; step < 40; step++) {
        const burst = pick(SCROLLBACK) + 1;
        let chunk = '';
        for (let i = 0; i < burst; i++) chunk += `line-${next++}\r\n`;
        await write(term, chunk);
        flush(renderer, model);
      }
      const seen = (model.body().match(/line-(\d+)/g) ?? []).map((m) =>
        Number(m.slice('line-'.length)),
      );
      expect(seen, `run ${run}`).toEqual(Array.from({ length: next }, (_, i) => i));
      term.dispose();
    }
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

  /** A second terminal fed the identical byte stream is the oracle: same
   *  geometry, same input, so a full render of it is what the repaint would have
   *  written. The logger's headless term is fixed at 200x50 (COLS/ROWS in the
   *  module under test), so the oracle has to match that, not this file's
   *  geometry. */
  function newOracle(scrollback = SCROLLBACK): Terminal {
    return new Terminal({ cols: 200, rows: 50, scrollback, allowProposedApi: true });
  }

  it('ends every flush with exactly the bytes the repaint would have written', async () => {
    const logger = new SessionLogger(
      tmp,
      ctx,
      { enabled: true, scrollback: SCROLLBACK, markerIntervalSec: 0 },
      50,
    );
    logger.spawn();
    const oracle = newOracle();

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
      const inflight = splitContent(readFileSync(logger.filePath()!, 'utf8')).text;
      expect(inflight.endsWith(fullRender(oracle))).toBe(true);
    }
    await logger.close();

    const { text } = splitContent(readFileSync(logger.filePath()!, 'utf8'));
    expect(text.endsWith(fullRender(oracle))).toBe(true);
    // Guard the fixture itself: a body this test could pass on trivially (an
    // empty one) would make the comparison meaningless.
    expect(text).toContain('tail after inserts');
    // And the appended history holds what the repaint had already dropped.
    expect(text).toContain('plain line one');
    expect(fullRender(oracle)).not.toContain('plain line one');
    oracle.dispose();
  });

  it('is byte-identical to a full repaint while nothing has been evicted', async () => {
    const logger = new SessionLogger(
      tmp,
      ctx,
      { enabled: true, scrollback: SCROLLBACK, markerIntervalSec: 0 },
      50,
    );
    logger.spawn();
    const oracle = newOracle();
    for (let i = 0; i < 20; i++) {
      const chunk = `line-${i}\r\n`;
      logger.output(chunk);
      await write(oracle, chunk);
      await logger.flushForTests();
      expect(splitContent(readFileSync(logger.filePath()!, 'utf8')).text).toBe(fullRender(oracle));
    }
    await logger.close();
    oracle.dispose();
  });

  it('keeps output the scrollback has evicted, with no line duplicated or lost', async () => {
    const logger = new SessionLogger(
      tmp,
      ctx,
      { enabled: true, scrollback: SCROLLBACK, markerIntervalSec: 0 },
      50,
    );
    logger.spawn();
    // 40 flushes of 20 rows each against a 30 + 50 row buffer: every flush stays
    // well under one buffer's worth, so nothing may go missing.
    const total = 40 * 20;
    for (let burst = 0; burst < 40; burst++) {
      let chunk = '';
      for (let i = 0; i < 20; i++) chunk += `line-${burst * 20 + i}\r\n`;
      logger.output(chunk);
      await logger.flushForTests();
    }
    await logger.close();
    const { text } = splitContent(readFileSync(logger.filePath()!, 'utf8'));
    const seen = (text.match(/line-(\d+)/g) ?? []).map((m) => Number(m.slice('line-'.length)));
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it('lays the file out exactly as a full rewrite would — timeline block and footer included', async () => {
    // The append path spells the file's shape (body separators, the trailing
    // `<!-- timeline -->` block, the footer's blank line) without ever holding
    // the body, so it could drift from `composeFileContent`. Run the same input
    // through both and compare the bytes: the second logger's file is deleted
    // before every flush, which fails the integrity guard and forces the full
    // rewrite. Total output stays under the scrollback, so neither body has lost
    // anything and they must be byte-identical.
    const clock = { now: new Date(2026, 4, 30, 20, 0, 0) };
    const make = (sid: string): SessionLogger =>
      new SessionLogger(
        tmp,
        { ...ctx, sid },
        { enabled: true, scrollback: SCROLLBACK, markerIntervalSec: 60 },
        50,
        () => clock.now,
      );
    const appended = make('t-appended');
    const rewritten = make('t-rewritten');
    appended.spawn();
    rewritten.spawn();
    await appended.flushForTests();
    await rewritten.flushForTests();

    const chunks = ['first\r\n', 'second line\r\n', '\x1b[2;1Hredraw', 'third\r\n'];
    for (const [i, chunk] of chunks.entries()) {
      clock.now = new Date(2026, 4, 30, 20, i + 1, 5); // past the marker interval
      appended.output(chunk);
      rewritten.output(chunk);
      await appended.flushForTests();
      rmSync(rewritten.filePath()!, { force: true });
      await rewritten.flushForTests();
    }
    appended.exit(0);
    rewritten.exit(0);
    await appended.close();
    await rewritten.close();

    const withoutHeader = (path: string): string => {
      const raw = readFileSync(path, 'utf8');
      return raw.slice(raw.indexOf('\n'));
    };
    const body = withoutHeader(appended.filePath()!);
    expect(body).toBe(withoutHeader(rewritten.filePath()!));
    expect(body).toContain('<!-- timeline -->');
    expect(body).toContain('"exitCode":0');
  });

  it('writes header + blank and nothing else for a session that never output', async () => {
    const logger = new SessionLogger(tmp, ctx, { enabled: true, markerIntervalSec: 0 }, 50);
    logger.spawn();
    await logger.flushForTests();
    const raw = readFileSync(logger.filePath()!, 'utf8');
    expect(raw.endsWith('}\n\n')).toBe(true);
    expect(splitContent(raw).text).toBe('');
    await logger.close();
  });

  it('trims the oldest half of the history once the body passes its byte cap', async () => {
    // The cap is injected small so the trim is reachable without pushing
    // megabytes through a headless xterm.
    const cap = 4096;
    const logger = new SessionLogger(
      tmp,
      ctx,
      { enabled: true, scrollback: SCROLLBACK, markerIntervalSec: 0 },
      50,
      () => new Date(),
      cap,
    );
    logger.spawn();
    for (let burst = 0; burst < 30; burst++) {
      let chunk = '';
      for (let i = 0; i < 20; i++) chunk += `line-${String(burst * 20 + i).padStart(5, '0')}\r\n`;
      logger.output(chunk);
      await logger.flushForTests();
      const size = readFileSync(logger.filePath()!, 'utf8').length;
      // Cap plus one live buffer's worth of tail, generously bounded.
      expect(size).toBeLessThan(cap * 2 + 80 * (SCROLLBACK + 50));
    }
    await logger.close();
    const { text } = splitContent(readFileSync(logger.filePath()!, 'utf8'));
    const seen = (text.match(/line-(\d+)/g) ?? []).map((m) => Number(m.slice('line-'.length)));
    // The oldest lines are gone, the newest survive, and what remains is still a
    // contiguous, in-order run — a trim cuts at a row boundary, never mid-body.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(30 * 20 - 1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => seen[0] + i));
  });
});
