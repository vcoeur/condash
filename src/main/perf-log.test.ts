import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PerfLog, perfLogPath, perfLogRoot, runPerfJanitor } from './perf-log';

/** A PerfLog on a controllable clock, already recording. */
function recording(): { log: PerfLog; advance: (ms: number) => void } {
  let t = new Date('2026-07-21T10:00:00.000Z').getTime();
  const log = new PerfLog(() => new Date(t));
  log.setEnabled(true, '/tmp/does-not-matter');
  return { log, advance: (ms: number) => (t += ms) };
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
    log.recordBatch('a', 10);
    log.recordPause('a');
    log.recordWatchdog('a');
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
    // Without the resolution subtraction these read ~10.1 / ~10.3.
    expect(loop!.p50).toBeLessThan(5);
    expect(loop!.p99).toBeLessThan(5);
    // Never negative, however quiet the loop was.
    expect(loop!.p50).toBeGreaterThanOrEqual(0);
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

  /** A conception dir seeded with perf files of the given day → size. */
  async function seed(files: Record<string, number>): Promise<string> {
    const conception = await mkdtemp(join(tmpdir(), 'condash-perf-janitor-'));
    const root = perfLogRoot(conception);
    await mkdir(root, { recursive: true });
    for (const [day, bytes] of Object.entries(files)) {
      await writeFile(join(root, `${day}.jsonl`), 'x'.repeat(bytes), 'utf8');
    }
    return conception;
  }

  it('does nothing when there is no perf directory', async () => {
    const conception = await mkdtemp(join(tmpdir(), 'condash-perf-janitor-'));
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
