import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IMarker, Terminal as HeadlessTerminal } from '@xterm/headless';
import { Terminal } from '@xterm/headless';

import { LOGGER_GRID_GEOMETRY, SessionLogger, type SessionContext } from './terminal-logger';
import { splitContent } from './logs-format';

/**
 * Microbenchmark for the append-only grid body (A3).
 *
 * Opt-in — `CONDASH_BENCH=1 npm run test:unit -- src/main/terminal-logger-bench.test.ts`.
 * It is a `.test.ts` so it runs the real module under the real TypeScript
 * config; it is skipped by default because it takes tens of seconds and its
 * numbers are machine-dependent.
 *
 * **Method, and why it is shaped this way.** A prior measurement in this
 * programme reported 3.9× from an un-warmed ascending sweep and had to be
 * withdrawn as a JIT artefact, so:
 *
 *   - both arms are warmed to steady state before any sample is kept;
 *   - the arms are **interleaved** flush by flush, and the order within each
 *     pair is chosen by a seeded PRNG, so neither arm gets a systematically
 *     colder JIT or page cache;
 *   - both arms are driven to buffer **saturation** first. A grid flush costs
 *     O(retained buffer), so a sample taken while the buffer is still filling is
 *     not the same measurement (`AGENTS.md`, § perf harness);
 *   - both terms are fed byte-identical input;
 *   - the report is a median and a p90, never a mean of a handful of samples.
 *
 * **What is reported, and what was withdrawn.** Per-flush wall time, split into
 * the ANSI parse both arms pay inside their own drain (measured on a third
 * saturated term and subtracted) and the body work that is actually under test.
 * Wall time includes the file write, which runs on the libuv threadpool rather
 * than on the event loop, so it is an upper bound on the main-thread stall.
 *
 * A per-arm `monitorEventLoopDelay` histogram was tried and **withdrawn**: an
 * `enable()` / `disable()` pair around a short window charges that window with
 * whatever blocked the loop just BEFORE `enable()`. Measured directly — a window
 * doing 1 ms of work, preceded by a 9 ms block outside it, reports p99 11.2 ms;
 * a window doing 9 ms preceded by 1 ms reports 12.0 ms. The instrument cannot
 * separate them, so it said more about which arm ran first than about the code.
 * Quote the body-only figures below for the stall, not a loop histogram.
 *
 * The baseline arm is a **pinned copy of the pre-change flush** (condash
 * `ac45273`, v4.98.1): the v4.97.1 frozen-prefix row walk, `rows.join('\n')`
 * over the whole retained buffer, the header/body compose, the duplicate
 * `Buffer.from(text, 'utf8')` encode, and the atomic tmp → rename rewrite. It is
 * a copy rather than a call into the old code because the old code is gone —
 * and it is checked against a from-scratch full render below, so a baseline that
 * is cheap because it is wrong cannot pass.
 */

const BENCH_ENABLED = process.env.CONDASH_BENCH === '1';

const { cols: COLS, rows: ROWS, scrollback: SCROLLBACK } = LOGGER_GRID_GEOMETRY;

/** Deterministic PRNG so an ordering is reproducible from the seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/** Translate every populated row, every time — the reference the pinned copy
 *  below is checked against. */
function fullRender(term: HeadlessTerminal): string {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    rows.push(line ? line.translateToString(true) : '');
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

/** Pinned copy of the v4.97.1 incremental row walk — the baseline arm's
 *  renderer. Do not "improve" it: its value is that it is what shipped. */
class LegacyGridRenderer {
  private frozenRows: string[] = [];
  private marker: IMarker | null = null;

  constructor(private readonly term: HeadlessTerminal) {
    this.term.buffer.onBufferChange(() => this.invalidate());
  }

  invalidate(): void {
    this.marker?.dispose();
    this.marker = null;
    this.frozenRows = [];
  }

  render(): string {
    const buffer = this.term.buffer.active;
    const rows = this.reusableRows(buffer.length);
    for (let y = rows.length; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      rows.push(line ? line.translateToString(true) : '');
    }
    this.rememberFrozenRows(rows);
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  private reusableRows(bufferLength: number): string[] {
    const marker = this.marker;
    if (!marker || marker.isDisposed) return [];
    const reusable = marker.line + 1;
    const evicted = this.frozenRows.length - reusable;
    if (evicted < 0 || reusable > bufferLength) return [];
    return this.frozenRows.slice(evicted);
  }

  private rememberFrozenRows(rows: string[]): void {
    this.marker?.dispose();
    this.marker = null;
    const buffer = this.term.buffer.active;
    const frozen = buffer.baseY;
    this.frozenRows = frozen > 0 ? rows.slice(0, frozen) : [];
    if (frozen === 0) return;
    this.marker = this.term.registerMarker(-1 - buffer.cursorY) ?? null;
  }
}

/** Pinned copy of the pre-change grid flush: drain the term, render, compose,
 *  encode twice, rewrite the whole file atomically. The drain is inside the
 *  flush because that is where `flushNow` has always had it — both arms must
 *  pay the queued ANSI parse in the same place or the comparison is rigged. */
async function legacyFlush(
  renderer: LegacyGridRenderer,
  term: HeadlessTerminal,
  path: string,
  headerLine: string,
): Promise<void> {
  await write(term, '');
  const body = renderer.render();
  const text = `${headerLine}\n\n${body}\n`;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  // The duplicate encode `recordWrite` used to do, purely for a length and a
  // 64-byte tail.
  const bytes = Buffer.from(text, 'utf8');
  void bytes.length;
  void bytes.subarray(bytes.length - 64);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index];
}

interface ArmResult {
  medianMs: number;
  p90Ms: number;
}

function summarise(samplesMs: number[]): ArmResult {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) };
}

describe.runIf(BENCH_ENABLED)('grid flush microbenchmark', () => {
  it(
    'append-only vs the pinned pre-change repaint, at production geometry',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'condash-logger-bench-'));
      try {
        const lines: string[] = [];
        for (const rowsPerFlush of [20, 100, 800, 5000]) {
          lines.push(await runOne(tmp, rowsPerFlush));
        }
        process.stdout.write(
          `\ngrid flush microbenchmark — ${COLS}x${ROWS}, scrollback ${SCROLLBACK}, saturated\n` +
            `${lines.join('\n')}\n`,
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    10 * 60_000,
  );
});

/** One workload point: `rowsPerFlush` new rows between flushes, both arms. */
async function runOne(tmpRoot: string, rowsPerFlush: number): Promise<string> {
  const WARMUP = 20;
  const SAMPLES = 40;
  const random = makeRandom(0xbe4c40 + rowsPerFlush);

  const ctx: SessionContext = {
    sid: `t-bench-${rowsPerFlush}`,
    side: 'my',
    cwd: '/x',
    spawn: { cmd: 'bash', argv: [] },
  };
  // 100 s debounce so only the explicit flushes fire.
  const appendLogger = new SessionLogger(
    tmpRoot,
    ctx,
    { enabled: true, markerIntervalSec: 0 },
    100_000,
  );
  appendLogger.spawn();
  await appendLogger.flushForTests();

  const legacyTerm = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
  });
  const legacyRenderer = new LegacyGridRenderer(legacyTerm);
  const legacyPath = join(tmpRoot, `legacy-${rowsPerFlush}.txt`);
  const legacyHeader = '# condash: {"sid":"t-bench","kind":"grid"}';

  let nextLine = 0;
  /** ~80 printable columns per row, one buffer row each — the shape the
   *  `realistic` load profile emits. */
  const makeChunk = (rows: number): string => {
    let chunk = '';
    for (let i = 0; i < rows; i++) {
      chunk += `line ${String(nextLine++).padStart(7, '0')} ${'abcdefgh'.repeat(8)}\r\n`;
    }
    return chunk;
  };
  // Saturate both buffers before anything is timed. A grid flush costs
  // O(retained buffer), so a sample taken while the buffer is still filling is
  // not the same measurement.
  const saturate = makeChunk(SCROLLBACK + ROWS + 200);
  appendLogger.output(saturate);
  void legacyTerm.write(saturate);
  await appendLogger.flushForTests();
  await legacyFlush(legacyRenderer, legacyTerm, legacyPath, legacyHeader);
  // BOTH arms must be doing the job, or a "faster" number below only means one
  // of them is doing less. Guarding the baseline alone is not enough: a mutated
  // append path that wrote nothing at all reported perfectly normal figures.
  expect(legacyRenderer.render()).toBe(fullRender(legacyTerm));
  const appendOutputIsRight = (): boolean =>
    splitContent(readFileSync(appendLogger.filePath()!, 'utf8')).text.endsWith(
      fullRender(legacyTerm),
    );
  expect(appendOutputIsRight(), 'append arm did not write the buffer it was fed').toBe(true);

  // What both arms pay for the queued ANSI parse, measured on a third saturated
  // term so it can be subtracted out of both. Reported, never assumed.
  const parseTerm = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
  });
  await write(parseTerm, makeChunk(SCROLLBACK + ROWS + 200));
  const parseMs: number[] = [];
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const chunk = makeChunk(rowsPerFlush);
    void parseTerm.write(chunk);
    const t0 = process.hrtime.bigint();
    await write(parseTerm, '');
    if (i >= WARMUP) parseMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  parseTerm.dispose();
  const parseMedian = percentile(
    [...parseMs].sort((a, b) => a - b),
    0.5,
  );

  const appendMs: number[] = [];
  const legacyMs: number[] = [];

  // Each arm is fed the same bytes immediately before ITS OWN flush, never both
  // at once: a chunk queued into the other arm's term would otherwise have its
  // parse callback land inside whichever window opened first, and the event-loop
  // figures would say more about the ordering than about the code.
  const timeAppend = async (chunk: string, keep: boolean): Promise<void> => {
    appendLogger.output(chunk);
    const t0 = process.hrtime.bigint();
    await appendLogger.flushForTests();
    if (keep) appendMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  };
  const timeLegacy = async (chunk: string, keep: boolean): Promise<void> => {
    void legacyTerm.write(chunk);
    const t0 = process.hrtime.bigint();
    await legacyFlush(legacyRenderer, legacyTerm, legacyPath, legacyHeader);
    if (keep) legacyMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  };

  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const chunk = makeChunk(rowsPerFlush);
    const keep = i >= WARMUP;
    // Randomised order so neither arm systematically meets a colder JIT, a
    // colder page cache, or a fuller write-back queue.
    if (random() < 0.5) {
      await timeAppend(chunk, keep);
      await timeLegacy(chunk, keep);
    } else {
      await timeLegacy(chunk, keep);
      await timeAppend(chunk, keep);
    }
  }

  // Re-checked after the measured phase, so a fault that only appears under load
  // cannot hide behind a fast number.
  expect(appendOutputIsRight(), 'append arm drifted from the buffer during the run').toBe(true);
  await appendLogger.close();
  legacyTerm.dispose();

  const append = summarise(appendMs);
  const legacy = summarise(legacyMs);
  const legacyBody = legacy.medianMs - parseMedian;
  const appendBody = append.medianMs - parseMedian;
  // A body-only figure at or below zero means the parse subtraction swamped the
  // measurement, not that the flush is infinitely fast. Say so — clamping the
  // denominator turns a reachable negative into a seven-digit speedup.
  const ratio =
    legacyBody > 0 && appendBody > 0
      ? `${(legacyBody / appendBody).toFixed(2)}x`
      : 'n/a (below the parse floor)';
  return (
    `  ${String(rowsPerFlush).padStart(5)} rows/flush | ` +
    `repaint ${legacy.medianMs.toFixed(2)} ms (p90 ${legacy.p90Ms.toFixed(2)}) | ` +
    `append ${append.medianMs.toFixed(2)} ms (p90 ${append.p90Ms.toFixed(2)}) | ` +
    `saved ${(legacy.medianMs - append.medianMs).toFixed(2)} ms/flush | ` +
    `shared ANSI parse ${parseMedian.toFixed(2)} ms | ` +
    `body-only ${legacyBody.toFixed(2)} → ${appendBody.toFixed(2)} ms (${ratio})`
  );
}
