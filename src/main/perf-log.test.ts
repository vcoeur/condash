import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';

import type { RendererPerfReport } from '../shared/types';
import { PerfLog, loopDelayMs, perfLogPath, perfLogRoot, runPerfJanitor } from './perf-log';

/** Every recorder this suite enables, switched off after each test: enabling
 *  installs an event-loop histogram AND a GC PerformanceObserver, and leaving
 *  either armed leaks a live handle into the next test's timings. */
const openLogs: PerfLog[] = [];
afterEach(() => {
  for (const log of openLogs.splice(0)) log.setEnabled(false);
});

/** A PerfLog on a controllable clock, already recording. */
function recording(): { log: PerfLog; advance: (ms: number) => void } {
  let t = new Date('2026-07-21T10:00:00.000Z').getTime();
  const log = new PerfLog(() => new Date(t));
  log.setEnabled(true, '/tmp/does-not-matter');
  openLogs.push(log);
  return { log, advance: (ms: number) => (t += ms) };
}

/** A renderer report with every required field, overridable per test. */
function rendererReport(patch: Partial<RendererPerfReport> = {}): RendererPerfReport {
  return {
    windowMs: 2500,
    loop: { p50: 0, p99: 0, max: 0 },
    frames: 0,
    longFrames: 0,
    frameMaxMs: 0,
    ...patch,
  };
}

/** Block the main thread long enough for the 10 ms histogram to sample it, then
 *  yield so the sample lands before the caller reads it.
 *
 *  The leading await is load-bearing: `monitorEventLoopDelay` measures the gap
 *  between its OWN firings, so a block that starts before the histogram has
 *  fired once is not attributed to it at all (measured — a block taken in the
 *  same tick as `enable()` reads as the bare 10 ms floor). */
async function stallLoop(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberate busy wait — a timer would not delay the loop */
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('PerfLog', () => {
  it('records nothing while disabled', () => {
    const log = new PerfLog();
    expect(log.isEnabled()).toBe(false);
    // Every mutator must be a safe no-op, so hot paths can call unconditionally
    // rather than branching at each site.
    log.recordChunk('a', 1000, 5000n);
    log.recordLogParse('a', 5000n);
    log.recordGridRender('a', 5000n);
    log.recordFlush('a', { totalNs: 5000n, composeNs: 1n, encodeNs: 1n, writeNs: 1n });
    log.recordBatch('a', 10);
    log.recordPause('a');
    log.recordWatchdog('a');
    log.endSpan('gitStatus', log.startSpan());
    log.endIpc('listRepos', log.startSpan());
    log.recordRendererReport(rendererReport({ loop: { p50: 1, p99: 2, max: 3 } }));
    expect(log.takeRecord()).toBeUndefined();
  });

  it('returns no record when nothing happened in the window', () => {
    const { log } = recording();
    expect(log.takeRecord()).toBeUndefined();
  });

  it('reports an idle loop as ~0 delay, not as the sampler resolution', async () => {
    // `monitorEventLoopDelay` records the gap between its own firings, so a raw
    // reading has a floor equal to its resolution (measured: 10.1–10.3 ms at
    // resolution 10). Reporting that raw put a fixed ~10 ms on the pane's
    // headline "main loop p99" for a completely idle app — 61% of a frame
    // budget, and exactly the symptom the instrument exists to hunt.
    const { log } = recording();
    // Real idle time, not the fake clock: the histogram runs on its own timer.
    await new Promise((resolve) => setTimeout(resolve, 120));
    log.recordChunk('sid-1', 10, 0n);

    const loop = log.takeRecord()?.loop;
    expect(loop).toBeDefined();
    // Anchored on the sampler's resolution, not on an arbitrary threshold. A raw
    // (un-subtracted) reading has a hard floor at the resolution — measured min
    // 10.027 ms — so anything below it proves the subtraction ran. p50 is the
    // statistic to assert: this test shares a machine with whatever else is
    // running, and real delay lands on the tail, so a p99 bound fails under load
    // while testing nothing extra. The exact arithmetic is pinned deterministically
    // by the `loopDelayMs` cases below.
    expect(loop!.p50).toBeLessThan(10);
    // Never negative, however quiet the loop was.
    expect(loop!.p50).toBeGreaterThanOrEqual(0);
    expect(loop!.p99).toBeGreaterThanOrEqual(0);
  });

  it('subtracts the sampler resolution from a raw histogram reading', () => {
    // The measured idle readings this exists to neutralise: resolution 10 gives
    // p50 10.109 / p99 10.297 / min 10.027 on a genuinely idle process.
    expect(loopDelayMs(10.109e6)).toBeCloseTo(0.109, 3);
    expect(loopDelayMs(10.297e6)).toBeCloseTo(0.297, 3);
    expect(loopDelayMs(10.027e6)).toBeCloseTo(0.027, 3);
    // A real block stays legible: a 100 ms hard block reads ~106.5 raw.
    expect(loopDelayMs(106.5e6)).toBeCloseTo(96.5, 3);
    // Floored at zero — a reading below the resolution is not negative delay.
    expect(loopDelayMs(9.4e6)).toBe(0);
    expect(loopDelayMs(0)).toBe(0);
  });

  it('accumulates per-session byte and chunk counts', () => {
    const { log } = recording();
    log.recordChunk('sid-1', 4096, 1_000_000n);
    log.recordChunk('sid-1', 2048, 500_000n);
    log.recordChunk('sid-2', 100, 0n);

    const record = log.takeRecord();
    expect(record?.sessions['sid-1']).toMatchObject({ bytes: 6144, chunks: 2, oscMs: 1.5 });
    expect(record?.sessions['sid-2']).toMatchObject({ bytes: 100, chunks: 1 });
  });

  it('omits zero-valued counters instead of padding every line', () => {
    const { log } = recording();
    log.recordChunk('sid-1', 10, 0n);
    const session = log.takeRecord()?.sessions['sid-1'];
    expect(session).toEqual({ bytes: 10, chunks: 1 });
    expect(Object.keys(session!)).not.toContain('pauses');
    expect(Object.keys(session!)).not.toContain('oscMs');
  });

  it('tracks the in-flight high-water mark, not the last value', () => {
    const { log } = recording();
    log.recordBatch('sid-1', 64_000);
    log.recordBatch('sid-1', 256_000);
    log.recordBatch('sid-1', 1_000);
    const session = log.takeRecord()?.sessions['sid-1'];
    expect(session?.inFlightPeak).toBe(256_000);
    expect(session?.batches).toBe(3);
  });

  it('counts pauses and watchdog resumes separately', () => {
    // A watchdog fire means the renderer stopped acking — a saturation signal
    // distinct from ordinary backpressure, so the two must not be conflated.
    const { log } = recording();
    log.recordChunk('sid-1', 1, 0n);
    log.recordPause('sid-1');
    log.recordPause('sid-1');
    log.recordWatchdog('sid-1');
    const session = log.takeRecord()?.sessions['sid-1'];
    expect(session?.pauses).toBe(2);
    expect(session?.watchdogs).toBe(1);
  });

  it('separates logger parse time from grid render time', () => {
    // These are different costs with different scaling — parse is O(bytes),
    // grid render is O(scrollback) and independent of new bytes. Collapsing them
    // would hide which one dominates.
    const { log } = recording();
    log.recordChunk('sid-1', 1, 0n);
    log.recordLogParse('sid-1', 2_000_000n);
    log.recordGridRender('sid-1', 8_000_000n);
    const session = log.takeRecord()?.sessions['sid-1'];
    expect(session?.logParseMs).toBe(2);
    expect(session?.gridRenderMs).toBe(8);
    expect(session?.gridRenders).toBe(1);
  });

  it('measures the whole flush, not just the grid render', () => {
    // `gridRenderMs` brackets GridBodyRenderer.render() alone, but the compose
    // join, the write and the bookkeeping's re-encode are all O(retained size)
    // and were outside every span — so the headline per-flush cost was
    // understated and the parts an optimisation would remove could not be
    // scored at all. `flushMs` is the superset; the sub-spans attribute inside
    // it.
    const { log } = recording();
    log.recordGridRender('sid-1', 8_000_000n);
    log.recordFlush('sid-1', {
      totalNs: 30_000_000n,
      composeNs: 6_000_000n,
      encodeNs: 4_000_000n,
      writeNs: 9_000_000n,
    });
    const session = log.takeRecord()?.sessions['sid-1'];
    expect(session).toMatchObject({
      gridRenderMs: 8,
      flushMs: 30,
      flushes: 1,
      composeMs: 6,
      encodeMs: 4,
      writeMs: 9,
    });
    // A flush-only session still gets its bytes/chunks keys, zero-valued.
    expect(session?.bytes).toBe(0);
  });

  it('sums flush sub-spans across the window', () => {
    const { log } = recording();
    for (let i = 0; i < 3; i++) {
      log.recordFlush('sid-1', {
        totalNs: 10_000_000n,
        composeNs: 1_000_000n,
        encodeNs: 2_000_000n,
        writeNs: 3_000_000n,
      });
    }
    expect(log.takeRecord()?.sessions['sid-1']).toMatchObject({
      flushes: 3,
      flushMs: 30,
      composeMs: 3,
      encodeMs: 6,
      writeMs: 9,
    });
  });

  it('records a window whose only activity is a main-thread span', async () => {
    // The v2 gate was "some session moved bytes", so a window holding a
    // 2 s git-status stall and no terminal output was thrown away — exactly the
    // population these spans exist to name (C4/C7).
    const { log } = recording();
    const span = log.startSpan();
    await new Promise((resolve) => setTimeout(resolve, 12));
    log.endSpan('gitStatus', span);

    const record = log.takeRecord();
    expect(record).toBeDefined();
    expect(record?.sessions).toEqual({});
    expect(record?.main?.spans?.gitStatus.n).toBe(1);
    expect(record?.main?.spans?.gitStatus.ms).toBeGreaterThan(5);
  });

  it('records a window whose only activity is a loop stall', async () => {
    const { log } = recording();
    await stallLoop(80);

    const record = log.takeRecord();
    expect(record).toBeDefined();
    expect(record?.sessions).toEqual({});
    expect(record?.loop.max).toBeGreaterThan(20);
  });

  it('still drops a window that is idle on every counter', () => {
    // The one suppression rule left: no counters at all AND a loop max under
    // the 5 ms floor. Without it a fully idle app would write a record every
    // 2.5 s forever.
    const { log } = recording();
    expect(log.takeRecord()).toBeUndefined();
  });

  it('buckets ipc dispatch by channel', async () => {
    const { log } = recording();
    const first = log.startSpan();
    await new Promise((resolve) => setTimeout(resolve, 5));
    log.endIpc('listRepos', first);
    log.endIpc('listRepos', log.startSpan());
    log.endIpc('readNote', log.startSpan());

    const ipc = log.takeRecord()?.main?.ipc;
    expect(ipc?.listRepos.n).toBe(2);
    expect(ipc?.readNote.n).toBe(1);
    expect(ipc?.listRepos.ms).toBeGreaterThan(ipc!.readNote.ms);
  });

  it('reports GC as observed-but-zero rather than as absent', () => {
    // "No GC block" must mean "this runtime cannot observe GC", never "no GC
    // happened" — the two would otherwise be indistinguishable in the file.
    const { log } = recording();
    log.recordChunk('sid-1', 1, 0n);
    const gc = log.takeRecord()?.main?.gc;
    // `supportedEntryTypes` is a runtime property of the constructor that the
    // bundled @types/node does not declare.
    const supported = (PerformanceObserver as unknown as { supportedEntryTypes: string[] })
      .supportedEntryTypes;
    if (supported.includes('gc')) {
      expect(gc).toBeDefined();
      expect(gc?.n).toBeGreaterThanOrEqual(0);
    } else {
      expect(gc).toBeUndefined();
    }
  });

  it('merges renderer reports, summing counters and keeping the worst latency', () => {
    // Two reports can land in one main window (the two 2.5 s clocks are
    // independent). Counters sum; percentiles take the worst, never an average —
    // the question is "did the renderer stall", and a quiet neighbour must not
    // dilute the answer.
    const { log } = recording();
    log.recordRendererReport(
      rendererReport({
        loop: { p50: 1, p99: 40, max: 120 },
        frames: 100,
        longFrames: 2,
        frameMaxMs: 90,
        spans: { demoteSerialize: { ms: 300, n: 1 } },
        counts: { demotes: 1 },
      }),
    );
    log.recordRendererReport(
      rendererReport({
        loop: { p50: 3, p99: 5, max: 9 },
        frames: 140,
        longFrames: 0,
        frameMaxMs: 20,
        spans: { demoteSerialize: { ms: 100, n: 2 } },
        counts: { demotes: 2, promotes: 1 },
      }),
    );

    const renderer = log.takeRecord()?.renderer;
    expect(renderer?.reports).toBe(2);
    expect(renderer?.loop).toEqual({ p50: 3, p99: 40, max: 120 });
    expect(renderer?.frames).toBe(240);
    expect(renderer?.longFrames).toBe(2);
    expect(renderer?.frameMaxMs).toBe(90);
    expect(renderer?.spans?.demoteSerialize).toEqual({ ms: 400, n: 3 });
    expect(renderer?.counts).toEqual({ demotes: 3, promotes: 1 });
  });

  it('does not carry a renderer block into the next window', () => {
    const { log } = recording();
    log.recordRendererReport(rendererReport({ frames: 10 }));
    expect(log.takeRecord()?.renderer?.frames).toBe(10);

    log.recordChunk('sid-1', 1, 0n);
    expect(log.takeRecord()?.renderer).toBeUndefined();
  });

  it('omits the main block entirely when nothing outside the byte path ran', () => {
    const { log } = recording();
    log.recordChunk('sid-1', 10, 0n);
    const main = log.takeRecord()?.main;
    // GC observation, when available, is the only reason a quiet window carries
    // a main block at all.
    expect(main?.spans).toBeUndefined();
    expect(main?.ipc).toBeUndefined();
  });

  it('stamps the window duration from the clock', () => {
    const { log, advance } = recording();
    log.recordChunk('sid-1', 1, 0n);
    advance(2500);
    expect(log.takeRecord()?.windowMs).toBe(2500);
  });

  it('resets accumulators between windows', () => {
    const { log, advance } = recording();
    log.recordChunk('sid-1', 500, 0n);
    advance(1000);
    log.takeRecord();

    log.recordChunk('sid-1', 20, 0n);
    advance(1000);
    const second = log.takeRecord();
    expect(second?.sessions['sid-1'].bytes).toBe(20);
    expect(second?.windowMs).toBe(1000);
  });

  it('carries event-loop delay percentiles and heap use', () => {
    const { log } = recording();
    log.recordChunk('sid-1', 1, 0n);
    const record = log.takeRecord();
    expect(record?.loop).toEqual(
      expect.objectContaining({
        p50: expect.any(Number),
        p99: expect.any(Number),
        max: expect.any(Number),
      }),
    );
    expect(record?.heapUsed).toBeGreaterThan(0);
  });

  it('drops accumulated counters when recording is turned off', () => {
    const { log } = recording();
    log.recordChunk('sid-1', 999, 0n);
    log.setEnabled(false);
    log.setEnabled(true, '/tmp/does-not-matter');
    expect(log.takeRecord()).toBeUndefined();
  });

  it('closes the window even when nothing happened, so an idle stretch is not folded in', () => {
    // An empty window used to return early BEFORE resetting the histogram and
    // advancing windowStart. One spike then sat in `max` for as long as tabs
    // stayed quiet — the pane's headline number was least trustworthy exactly
    // when the app was idle enough to read it — and the next real record's
    // windowMs spanned the whole idle stretch.
    const { log, advance } = recording();
    advance(60_000);
    expect(log.takeRecord()).toBeUndefined();

    advance(2500);
    log.recordChunk('sid-1', 10, 0n);
    expect(log.takeRecord()?.windowMs).toBe(2500);
  });
});

describe('perfLogPath', () => {
  it('files records by UTC day under .condash/perf', () => {
    const path = perfLogPath('/home/alice/conception', new Date('2026-07-21T23:30:00.000Z'));
    expect(path).toBe('/home/alice/conception/.condash/perf/2026-07-21.jsonl');
  });
});

describe('runPerfJanitor', () => {
  const NOW = new Date('2026-07-22T10:00:00.000Z');

  // Every temp conception this suite mints, torn down after each test. The
  // maxDirMb cases seed ~500 MB apiece, so leaking them fills the disk fast: a
  // day of repeated `vitest run`s left 125 dirs / 14 GB in /tmp and a full disk
  // that failed unrelated tests with ENOSPC. mkdtemp does not clean up after
  // itself — the test must.
  const tempConceptions: string[] = [];
  afterEach(async () => {
    await Promise.all(
      tempConceptions.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
  async function makeConception(): Promise<string> {
    const conception = await mkdtemp(join(tmpdir(), 'condash-perf-janitor-'));
    tempConceptions.push(conception);
    return conception;
  }

  /** A conception dir seeded with perf files of the given day → size. */
  async function seed(files: Record<string, number>): Promise<string> {
    const conception = await makeConception();
    const root = perfLogRoot(conception);
    await mkdir(root, { recursive: true });
    for (const [day, bytes] of Object.entries(files)) {
      await writeFile(join(root, `${day}.jsonl`), 'x'.repeat(bytes), 'utf8');
    }
    return conception;
  }

  it('does nothing when there is no perf directory', async () => {
    const conception = await makeConception();
    await expect(runPerfJanitor(conception, NOW)).resolves.toMatchObject({
      scanned: 0,
      deleted: [],
    });
  });

  it('evicts records past the retention window', async () => {
    const conception = await seed({
      '2026-07-01': 10, // 21 days old
      '2026-07-06': 10, // 16 days old
      '2026-07-20': 10, // 2 days old
    });
    const result = await runPerfJanitor(conception, NOW);
    expect(result.deleted).toEqual(['2026-07-01.jsonl', '2026-07-06.jsonl']);
    expect(await readdir(perfLogRoot(conception))).toEqual(['2026-07-20.jsonl']);
  });

  it('keeps exactly the retention window, inclusive of today', async () => {
    // Boundary: with a `<` compare against today−14 the cutoff day itself
    // survived, so 14 days of retention silently kept 15.
    const conception = await seed({
      '2026-07-08': 10, // today − 14: the boundary, must go
      '2026-07-09': 10, // today − 13: the oldest keeper
      '2026-07-22': 10, // today
    });
    const result = await runPerfJanitor(conception, NOW);
    expect(result.deleted).toEqual(['2026-07-08.jsonl']);
    expect(await readdir(perfLogRoot(conception))).toEqual([
      '2026-07-09.jsonl',
      '2026-07-22.jsonl',
    ]);
  });

  it('evicts oldest-first while over the directory cap', async () => {
    // Three 90 MB days = 270 MB, over the 200 MB ceiling; dropping the oldest
    // one brings it under, so the second must survive.
    const big = 90 * 1024 * 1024;
    const conception = await seed({
      '2026-07-20': big,
      '2026-07-21': big,
      '2026-07-22': big,
    });
    const result = await runPerfJanitor(conception, NOW);
    expect(result.deleted).toEqual(['2026-07-20.jsonl']);
    expect(result.remainingBytes).toBe(2 * big);
  });

  it("never deletes today's file, even to get under the cap", async () => {
    // A live recorder is appending to it: evicting today throws away the run
    // the user is in the middle of capturing.
    const huge = 500 * 1024 * 1024;
    const conception = await seed({ '2026-07-22': huge });
    const result = await runPerfJanitor(conception, NOW);
    expect(result.deleted).toEqual([]);
    expect(await readdir(perfLogRoot(conception))).toEqual(['2026-07-22.jsonl']);
  });

  it('ignores files that are not day-stamped records', async () => {
    const conception = await seed({ '2026-07-01': 10 });
    await writeFile(join(perfLogRoot(conception), 'notes.txt'), 'keep me', 'utf8');
    await runPerfJanitor(conception, NOW);
    expect(await readdir(perfLogRoot(conception))).toEqual(['notes.txt']);
  });
});
