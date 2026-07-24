/**
 * Main-process performance counters.
 *
 * The 2026-07-21 performance audit established exact complexity for every stage
 * of the terminal byte path but measured no constants — so which stage actually
 * dominates wall-clock (the OSC scan, the structured clone, the headless-xterm
 * parse) stayed a guess, and GC pressure was invisible entirely. This module is
 * the measuring instrument: it accumulates cheap counters in memory and flushes
 * a compact JSONL record on the cadence the caller already runs.
 *
 * ## Design constraints
 *
 * - **Off by default** (`terminal.perf.enabled`), like disk logging. When
 *   disabled every entry point is an immediate return, so an ordinary user pays
 *   nothing and the "instrumentation is the overhead" objection stays moot.
 * - **No timer of its own.** The caller flushes from an existing tick.
 * - **Nothing superlinear.** Counters are scalar adds; the only per-chunk work
 *   is one `hrtime.bigint()` pair, and only while enabled.
 * - **Event-loop delay comes from `monitorEventLoopDelay`**, a native histogram
 *   the runtime maintains itself. It is the single highest-value counter here:
 *   it measures the reported symptom (UI lag) directly on the thread the audit
 *   identified as the bottleneck, rather than inferring it from a proxy.
 *
 * ## What schema 3 added, and why
 *
 * Re-reading 11.1 h of production records (2026-07-22 → 24) found the instrument
 * blind in four directions, two of which changed what earlier records mean:
 *
 * 1. **The flush was measured in part** — `gridRenderMs` covers the grid render
 *    and nothing after it, though the rest of a flush is O(retained size) too.
 *    {@link PerfLog.recordFlush} adds the whole-flush span and its breakdown.
 * 2. **Windows with no pty traffic were discarded**, which is exactly where the
 *    unexplained stalls live — see {@link PerfLog.takeRecord}.
 * 3. **Nothing outside the byte path was timed**: the dashboard summarizer, the
 *    repo watchers, the git-status path, IPC dispatch, GC — see
 *    {@link MainSpanName} and the `main` block.
 * 4. **The renderer was invisible**, so no record could say whether a stall was
 *    main's or the renderer's — see `src/renderer/perf-renderer.ts` and the
 *    `renderer` block.
 */

import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  type IntervalHistogram,
} from 'node:perf_hooks';
import { dirname, join } from 'node:path';

import {
  delayAboveInterval,
  IDLE_LOOP_MAX_MS as SHARED_IDLE_LOOP_MAX_MS,
} from '../shared/loop-delay';
import type { PerfVitals, RendererPerfReport } from '../shared/types';

/** Per-session accumulators, reset on every flush. */
interface SessionCounters {
  /** Bytes read off the pty. */
  bytes: number;
  /** Chunks read off the pty. */
  chunks: number;
  /** Nanoseconds spent in the OSC transcript scan. */
  oscNs: bigint;
  /** Nanoseconds spent in the disk logger's headless-xterm parse. */
  logParseNs: bigint;
  /** Nanoseconds spent rendering the grid body for a disk-log flush. */
  gridRenderNs: bigint;
  /** Grid-body renders performed (each walks the whole scrollback). */
  gridRenders: number;
  /** Nanoseconds of ELAPSED time in the disk logger's flush, end to end. */
  flushNs: bigint;
  /** Nanoseconds the flush actually held the main thread. */
  syncNs: bigint;
  /** Disk-log flushes performed (a flush that did work, skip or write). */
  flushes: number;
  /** Nanoseconds spent joining the file text out of header + body + footer. */
  composeNs: bigint;
  /** Nanoseconds spent re-encoding the written text for the bookkeeping. */
  encodeNs: bigint;
  /** Nanoseconds spent in the write itself (open + write + rename). */
  writeNs: bigint;
  /** Coalesced `termData` batches sent to the renderer. */
  batches: number;
  /** Times the pty was paused by backpressure. */
  pauses: number;
  /** Times the pause watchdog force-resumed a pty. */
  watchdogs: number;
  /** Highest un-acked byte count seen this window. */
  inFlightPeak: number;
}

/**
 * Sub-span breakdown of one disk-log flush, in nanoseconds.
 *
 * `gridRenderMs` measured only `GridBodyRenderer.render()`, but everything after
 * it in the same flush is O(retained size) too — the compose join copies the
 * whole body, `writeFile` encodes it to UTF-8, and the bookkeeping encodes it
 * again. Reading the render span as "the cost of a flush" therefore understated
 * it, and the parts an optimisation would remove sat entirely outside the
 * measurement.
 *
 * **Two clocks, and only one of them is a cost.** `syncNs` is the thread-holding
 * part — the answer to "how much of `loop.max` was this flush". `totalNs` is
 * elapsed time across five libuv round trips, so it absorbs whatever *else* the
 * loop is doing: measured in review on a 1.05 MB body, the same write took 2.0 ms
 * on an idle loop and **209 ms** with an unrelated 26 ms block per turn — and 26
 * ms is the production median grid render. Reading `totalNs` as cost would let
 * session B's render inflate session A's flush and make "share of `loop.max`
 * explained by measured work" approach 100 % by construction — the instrument
 * confirming itself, which is the exact failure this instrument exists to
 * prevent.
 */
export interface FlushSpans {
  /** Elapsed wall time of the whole flush, entry to end of bookkeeping.
   *  Includes queueing behind unrelated event-loop work. Never subtract it from
   *  or compare it against `loop.max`. */
  totalNs: bigint;
  /** Main-thread block time of the flush: every synchronous stretch between its
   *  awaits, summed. This is the flush's cost, and the superset of
   *  `gridRenderNs + composeNs + encodeNs`. */
  syncNs: bigint;
  /** `composeFileContent`'s join. Synchronous. */
  composeNs: bigint;
  /** The bookkeeping's re-encode of the written text, plus the incremental
   *  append's encode. Synchronous. */
  encodeNs: bigint;
  /** The write proper: mkdir + open + writeFile (+ fsync) + rename, or the
   *  incremental append. **Elapsed**, not cost — mostly libuv round trips, and
   *  inflated by unrelated loop work exactly as `totalNs` is. The calling
   *  thread's own encode inside `writeFile` is real block time but is not
   *  separable from the outside; `encodeNs` measures a same-sized encode. */
  writeNs: bigint;
}

/**
 * Main-thread work outside the terminal byte path, named for the record.
 *
 * 20 % of the ≥ 100 ms stalls in the 2026-07-22→24 dataset contain under 1 ms of
 * measured terminal work, so the instrument could see that they happened but
 * never what they were. A closed union rather than a free string: the field set
 * of a record is then a documented list, and a typo at a call site is a compile
 * error instead of a phantom series.
 *
 * **Every span is elapsed wall time**, not event-loop block time. `gitStatus`
 * spends most of its span waiting on a subprocess, during which main is free.
 * Two spans — `transcriptRead` and `dashRecentText` (which contains it) — are
 * synchronous end to end and so *are* block time; every other one is "this work
 * was in flight during this window", to be correlated with `loop.max`, never
 * subtracted from it.
 *
 * **The spans nest and may overlap, so `sum(main.spans.*.ms)` double-counts.**
 * `repoRecompute` contains `gitStatus` and `gitUpstream`; `dashRecentText`
 * contains `transcriptRead`. Concurrent same-name spans (five repos recomputing
 * at once) also sum past `windowMs`. Read them per name, not as a total.
 */
export type MainSpanName =
  /** `tabRecentText` — the summarizer's per-tab text assembly (sidecar read,
   *  transcript tail render, or ANSI clean of the raw buffer). **Synchronous end
   *  to end**, and contains `transcriptRead`.
   *
   *  There is deliberately no span for the dashboard *tick* as a whole: its wall
   *  time is dominated by the LLM round-trip, so it would report seconds of
   *  network latency in a field read as main-thread cost. The tick's blocking
   *  parts are this span and `dashProvenance`. */
  | 'dashRecentText'
  /** `deriveProvenance` — the config walk plus the serial README header reads. */
  | 'dashProvenance'
  /** `readFileTranscript` — the blocking `readSync` of a tab's sidecar.
   *  Synchronous; nested inside `dashRecentText` on the dashboard path. */
  | 'transcriptRead'
  /** A repo watcher's debounced recompute. **Contains** `gitStatus` and
   *  `gitUpstream` — the same wall time appears in all three buckets. */
  | 'repoRecompute'
  /** A `git status` cache miss. */
  | 'gitStatus'
  /** An upstream-tracking cache miss (two more git spawns). */
  | 'gitUpstream'
  /** The Code pane's per-file dirty details (`git status` + `diff --numstat`). */
  | 'gitDetails';

/** Accumulated wall time and call count for one span name or IPC channel. */
interface SpanTotals {
  ns: bigint;
  n: number;
}

/** GC pauses observed over the window, via `PerformanceObserver`. */
interface GcTotals {
  n: number;
  ms: number;
  maxMs: number;
}

/** Renderer-side counters merged from `perfRendererReport` messages. */
interface RendererTotals {
  reports: number;
  windowMs: number;
  loopP50: number;
  loopP99: number;
  loopMax: number;
  samples: number;
  hiddenMs: number;
  frames: number;
  longFrames: number;
  frameMaxMs: number;
  spans: Map<string, SpanTotals>;
  counts: Map<string, number>;
  maxima: Map<string, number>;
}

/** One flushed record. Shape is the on-disk contract for `.condash/perf/`. */
export interface PerfRecord {
  /** Schema version of this record.
   *
   *  Present from v2 onward; a record without it was written by v4.96.0, whose
   *  `loop` values carry a fixed ~10 ms offset (the sampler's own resolution was
   *  not subtracted). Since records are appended to a per-DAY file, upgrading
   *  mid-day produces one file holding both meanings — so anything aggregating
   *  `loop` must discriminate rather than average across the boundary. */
  schema: number;
  /** ISO timestamp of the flush. */
  t: string;
  /** Milliseconds covered by this window. */
  windowMs: number;
  /** Event-loop delay over the window, in milliseconds **above the sampler's own
   *  10 ms interval** — see `loopDelayMs`. Delays below that interval are not
   *  resolvable and read as 0. */
  loop: { p50: number; p99: number; max: number };
  /** Main-process heap use at flush time, in bytes. */
  heapUsed: number;
  /** Live sessions with any activity this window, keyed by session id. Empty
   *  for a window in which no session moved bytes — those windows are recorded
   *  too (see {@link PerfLog.takeRecord}). */
  sessions: Record<string, SessionRecord>;
  /** Main-thread work outside the terminal byte path. Omitted when nothing was
   *  timed and GC could not be observed. */
  main?: MainRecord;
  /** Renderer-side counters, present when the renderer reported at least once
   *  in this window. */
  renderer?: RendererRecord;
}

/** Per-session slice of a flushed record; zero-valued fields are omitted. */
export interface SessionRecord {
  bytes: number;
  chunks: number;
  oscMs?: number;
  logParseMs?: number;
  gridRenderMs?: number;
  gridRenders?: number;
  /** **The flush's cost**: main-thread block time, summed over the flush's
   *  synchronous stretches. Superset of `gridRenderMs + composeMs + encodeMs`.
   *  This is the field to read against `loop.max`. */
  syncFlushMs?: number;
  /** **Elapsed** wall time of the flush, across five libuv round trips — so it
   *  includes queueing behind unrelated event-loop work and can exceed the
   *  flush's own cost by 100× under load. Useful for "how long did the log lag
   *  the buffer", useless as main-thread cost. See {@link FlushSpans}. */
  flushMs?: number;
  flushes?: number;
  composeMs?: number;
  encodeMs?: number;
  /** Elapsed, like `flushMs` — mostly libuv round trips. Not block time. */
  writeMs?: number;
  batches?: number;
  pauses?: number;
  watchdogs?: number;
  inFlightPeak?: number;
}

/** Accumulated wall time (ms) and call count for one span. */
export interface SpanRecord {
  ms: number;
  n: number;
}

/** Main-thread work outside the terminal byte path, for one window. */
export interface MainRecord {
  /** Named spans (see {@link MainSpanName}); only those that ran are present.
   *  They nest and may overlap — do not sum them. */
  spans?: Record<string, SpanRecord>;
  /** `ipcMain.handle` dispatch **elapsed** time, bucketed by channel.
   *
   *  Wall clock across the whole handler, attributed to the window it *finished*
   *  in — so `dashboardTestConnection` (an LLM round trip) or `autoSyncNow` (a
   *  git sweep) can report several seconds inside a 2500 ms window. `ms` may
   *  exceed `windowMs`; that is the handler waiting, not main blocking. The
   *  instrument's own transport (`perfRendererReport`) is excluded, since a
   *  measurement of itself is not a measurement of the app. */
  ipc?: Record<string, SpanRecord>;
  /** GC pauses observed this window. **Absent means unobservable**, not zero:
   *  the block is emitted (with `n: 0`) whenever the observer is installed, so
   *  a reader can tell "no GC" from "no GC observer". */
  gc?: GcTotals;
}

/** Renderer-side counters for one window, merged from the renderer's reports. */
export interface RendererRecord extends RendererPerfReport {
  /** Renderer reports merged into this record. Normally 1 — the renderer drains
   *  on the same 2.5 s cadence main flushes on, but the two clocks are
   *  independent, so a window can hold 0 or 2. With more than one, the counters
   *  are summed and the loop percentiles are the WORST of the merged reports,
   *  never an average. */
  reports: number;
}

const emptyCounters = (): SessionCounters => ({
  bytes: 0,
  chunks: 0,
  oscNs: 0n,
  logParseNs: 0n,
  gridRenderNs: 0n,
  gridRenders: 0,
  flushNs: 0n,
  syncNs: 0n,
  flushes: 0,
  composeNs: 0n,
  encodeNs: 0n,
  writeNs: 0n,
  batches: 0,
  pauses: 0,
  watchdogs: 0,
  inFlightPeak: 0,
});

const emptyRendererTotals = (): RendererTotals => ({
  reports: 0,
  windowMs: 0,
  loopP50: 0,
  loopP99: 0,
  loopMax: 0,
  samples: 0,
  hiddenMs: 0,
  frames: 0,
  longFrames: 0,
  frameMaxMs: 0,
  spans: new Map(),
  counts: new Map(),
  maxima: new Map(),
});

/** Nanoseconds → milliseconds, rounded to 3 decimals. Undefined for zero so a
 *  quiet counter stays out of the record rather than padding every line. */
function ms(ns: bigint): number | undefined {
  if (ns === 0n) return undefined;
  return Math.round(Number(ns) / 1e3) / 1e3;
}

/** Drop zero-valued optional fields so a record stays readable and small. */
function positive(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

/** Add one observation to a span bucket, creating it on first use. */
function addSpan(buckets: Map<string, SpanTotals>, key: string, ns: bigint): void {
  const entry = buckets.get(key);
  if (entry) {
    entry.ns += ns;
    entry.n += 1;
    return;
  }
  buckets.set(key, { ns, n: 1 });
}

/** Render span buckets for the record, or undefined when nothing ran — an empty
 *  object on every line would cost more than it says. */
function spanRecords(buckets: Map<string, SpanTotals>): Record<string, SpanRecord> | undefined {
  if (buckets.size === 0) return undefined;
  const out: Record<string, SpanRecord> = {};
  for (const [key, totals] of buckets) {
    out[key] = { ms: Math.round(Number(totals.ns) / 1e3) / 1e3, n: totals.n };
  }
  return out;
}

/** Strip undefined-valued keys, so an absent counter is genuinely absent from
 *  the object rather than present-but-undefined. */
function omitUndefined<T extends Record<string, number | undefined>>(
  fields: T,
): Partial<Record<keyof T, number>> {
  const out: Partial<Record<keyof T, number>> = {};
  for (const [key, value] of Object.entries(fields) as [keyof T, number | undefined][]) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Current `PerfRecord.schema`. Bump whenever the MEANING of a recorded field
 *  changes, not merely when one is added — v2 exists because `loop` switched
 *  from a raw histogram reading to delay above the sampler's interval, which is
 *  invisible in the shape but makes the two incomparable.
 *
 *  v3 changes the meaning of the record SET rather than of any one field: v2
 *  emitted a record only when some session moved bytes, so every per-window
 *  distribution taken over a v2 file is conditioned on "a tab was talking".
 *  v3 emits a record for any window worth reporting, including ones with no
 *  terminal traffic at all — exactly the population the unexplained stalls live
 *  in. Mixing the two silently changes what a percentile is over.
 *
 *  v4 narrows `gridRenderMs`. Through v3 it bracketed a grid flush building its
 *  whole body — a row walk plus `rows.join('\n')` over the entire retained
 *  buffer, i.e. O(retained size). From v4 the grid body is appended, so the same
 *  span brackets a row walk over the NEW rows plus a join of those and the live
 *  tail: O(new output). The field name, the units and `gridRenders` are all
 *  unchanged, which is precisely why this needs a schema bump — a v3 and a v4
 *  file look identical and mean different things, and averaging them would read
 *  as an improvement that is partly a redefinition. `syncFlushMs` (added in v3's
 *  #467 work) is the field to compare across the boundary: its meaning — the
 *  flush's main-thread block time summed over its synchronous stretches — is the
 *  same on both sides, and the append path (v4) fills it exactly as the repaint
 *  path did. `gridRenderMs` shrank because the body it builds shrank; the
 *  flush's total cost `syncFlushMs` measures the same thing throughout. */
export const PERF_SCHEMA_VERSION = 4;

/**
 * Loop-delay floor below which a window with no counted activity is dropped.
 *
 * v2 discarded every window in which no session moved bytes, which censored the
 * 20 % of ≥ 100 ms stalls that contain no terminal work — the ones C3's spans
 * exist to name. So the rule inverts: a window is emitted whenever there is
 * anything to report, and the ONLY suppression left is a window that is idle on
 * every counter AND whose worst loop delay is under this bound. At 2.5 s per
 * window a fully idle app would otherwise write ~35 k records/day (~11 MB); with
 * it, an idle app writes nothing and a stalling one writes everything.
 *
 * The same bound governs the renderer's drain — see `shared/loop-delay.ts`. The
 * two decisions compose, and the first version of this gate was unreachable
 * precisely because they did not: the renderer sent a report every window, and a
 * report was activity.
 */
const IDLE_LOOP_MAX_MS = SHARED_IDLE_LOOP_MAX_MS;

/** Sampling resolution (ms) of the event-loop histogram — and, crucially, the
 *  floor it reports. See {@link loopDelayMs}. Exported so a test asserts against
 *  the real bound rather than a hardcoded twin that would silently stop
 *  discriminating if the resolution ever changed. */
export const LOOP_RESOLUTION_MS = 10;

/**
 * Convert a raw histogram reading (ns) to milliseconds of delay **in excess of
 * the sampler's own interval**.
 *
 * `monitorEventLoopDelay` records the observed gap between its own timer
 * firings, not the excess over the expected gap, so on a perfectly idle loop it
 * reports the resolution. Measured on an idle process: resolution 10 → p50
 * 10.109 ms, p99 10.297 ms, min 10.027 ms; resolution 20 → p50 20.120 ms. A 100
 * ms hard block at resolution 10 reads max 106.50 ms, so the relationship is
 * approximately `reported ≈ true_delay + resolution`. Approximately, not
 * exactly: subtracting a flat 10 reports that 100 ms block as 96.5 ms, a few
 * percent low. The residual is well inside the noise these figures are read at,
 * and far smaller than the ~10 ms bias it replaces — but the number is an
 * estimate of delay, not a measurement of it.
 *
 * Reporting the raw value put a fixed ~10 ms — around 61 % of a 16.7 ms frame
 * budget — on the pane's headline "main loop p99" for a completely idle app.
 * That is both the symptom this instrumentation was built to investigate and a
 * plausible-looking magnitude for it, so the instrument was positioned to
 * confirm the hypothesis it was meant to test, while masking any genuine delay
 * below the floor.
 *
 * Subtracting the resolution rather than lowering it keeps the sampler's own
 * cost off the thread being measured — a 1 ms resolution means a timer firing
 * 1000×/s on the main loop, which is itself a perturbation.
 *
 * @param nanoseconds A raw reading from the interval histogram.
 * @returns Milliseconds of delay above the sampling interval, floored at 0 and
 *   rounded to microsecond precision.
 */
export function loopDelayMs(nanoseconds: number): number {
  return delayAboveInterval(nanoseconds / 1e6, LOOP_RESOLUTION_MS);
}

/**
 * Accumulates main-process performance counters and flushes them as JSONL.
 *
 * Every mutator is a no-op while disabled, so callers can instrument hot paths
 * unconditionally without branching at each site.
 */
export class PerfLog {
  private counters = new Map<string, SessionCounters>();
  private histogram: IntervalHistogram | undefined;
  private windowStart = 0;
  private enabled = false;
  /** Conception receiving the records. The filename is day-stamped per flush. */
  private conceptionPath: string | undefined;
  /** Set once a write fails, so a broken path doesn't retry every flush. */
  private writeFailed = false;
  /** Named main-thread spans for the window, keyed by {@link MainSpanName}. */
  private mainSpans = new Map<string, SpanTotals>();
  /** `ipcMain.handle` dispatch time for the window, keyed by channel. */
  private ipcSpans = new Map<string, SpanTotals>();
  /** GC pauses for the window; undefined while no observer is installed. */
  private gc: GcTotals | undefined;
  private gcObserver: PerformanceObserver | undefined;
  /** Renderer reports merged since the last record. */
  private renderer: RendererTotals | undefined;

  /**
   * @param now Injectable clock, for deterministic tests.
   */
  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Turn recording on or off. Enabling starts the event-loop histogram and
   * opens the window; disabling stops and discards it.
   *
   * @param enabled Whether to record.
   * @param conceptionPath Conception whose `.condash/perf/` receives the
   *   records; required when enabling. The day-stamped filename is derived per
   *   flush, so a run spanning midnight rolls over on its own.
   */
  setEnabled(enabled: boolean, conceptionPath?: string): void {
    // The destination can change while recording stays on — a conception switch
    // repoints it — so the path is updated on every call, not only on the
    // off→on edge. An early return keyed solely on `enabled` would keep writing
    // into the previous conception's `.condash/perf/`.
    if (enabled) this.conceptionPath = conceptionPath;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      // A fresh run gets a fresh write attempt: leaving the latch set would mean
      // one transient disk error silently disabled recording for the process
      // lifetime, with the pane still showing "Recording" and nothing on disk.
      this.writeFailed = false;
      this.histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
      this.histogram.enable();
      this.windowStart = this.now().getTime();
      this.observeGc();
    } else {
      this.histogram?.disable();
      this.histogram = undefined;
      this.counters.clear();
      this.mainSpans.clear();
      this.ipcSpans.clear();
      this.renderer = undefined;
      this.gcObserver?.disconnect();
      this.gcObserver = undefined;
      this.gc = undefined;
    }
  }

  /**
   * Start observing GC pauses, if the runtime exposes them.
   *
   * GC was the one cost the 2026-07-21 audit named and never measured: a major
   * collection blocks the same thread every terminal tab shares, and nothing in
   * the instrument could see it. `PerformanceObserver` reports each pause after
   * the fact, at no cost to the collection itself.
   *
   * Failure is silent but *visible in the data*: with no observer the record
   * carries no `main.gc` block at all, which a reader must not confuse with a
   * window that had no GC (that reads `n: 0`).
   */
  private observeGc(): void {
    if (this.gcObserver) return;
    try {
      const observer = new PerformanceObserver((list) => {
        const gc = this.gc;
        if (!gc) return;
        for (const entry of list.getEntries()) {
          gc.n += 1;
          gc.ms += entry.duration;
          if (entry.duration > gc.maxMs) gc.maxMs = entry.duration;
        }
      });
      observer.observe({ entryTypes: ['gc'] });
      this.gcObserver = observer;
      this.gc = { n: 0, ms: 0, maxMs: 0 };
    } catch {
      // No 'gc' entry type on this runtime — records simply carry no gc block.
    }
  }

  /** Whether recording is currently on. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether a record write has failed since recording was last enabled. The
   *  latch means recording is on in name only — nothing further will be
   *  written — so a display must be able to say so rather than keep claiming
   *  it is recording. Cleared by the next off→on toggle. */
  hasWriteFailed(): boolean {
    return this.writeFailed;
  }

  /** Event-loop delay percentiles (ms) for the window so far, WITHOUT resetting
   *  it. `takeRecord` is the resetting read; this one exists so a display can
   *  poll without stealing data from the recorded windows. */
  peekLoop(): { p50: number; p99: number; max: number } | undefined {
    if (!this.enabled || !this.histogram) return undefined;
    return {
      p50: loopDelayMs(this.histogram.percentile(50)),
      p99: loopDelayMs(this.histogram.percentile(99)),
      max: loopDelayMs(this.histogram.max),
    };
  }

  /** Counters for `id`, creating them on first use. */
  private forSession(id: string): SessionCounters {
    let entry = this.counters.get(id);
    if (!entry) {
      entry = emptyCounters();
      this.counters.set(id, entry);
    }
    return entry;
  }

  /** Record a pty chunk and the time spent scanning it for OSC transcript frames. */
  recordChunk(id: string, bytes: number, oscNs: bigint): void {
    if (!this.enabled) return;
    const c = this.forSession(id);
    c.bytes += bytes;
    c.chunks += 1;
    c.oscNs += oscNs;
  }

  /** Record time spent in the disk logger's headless-xterm ANSI parse — the
   *  duplicate of the renderer's parse that the audit ranked as the worst
   *  main-thread item when logging is on. */
  recordLogParse(id: string, ns: bigint): void {
    if (!this.enabled) return;
    this.forSession(id).logParseNs += ns;
  }

  /** Record a grid-body render (walks the entire scrollback, O(scrollback) and
   *  independent of new bytes). */
  recordGridRender(id: string, ns: bigint): void {
    if (!this.enabled) return;
    const c = this.forSession(id);
    c.gridRenderNs += ns;
    c.gridRenders += 1;
  }

  /**
   * Record one disk-log flush, whole-span plus the sub-spans inside it.
   *
   * Sibling of `recordGridRender` rather than a replacement for it: 11 h of
   * baseline is keyed to `gridRenderMs` meaning exactly `GridBodyRenderer`, so
   * widening that field in place would have made the series incomparable across
   * the change. `syncFlushMs` is the cost superset — `syncFlushMs −
   * gridRenderMs − composeMs − encodeMs` is the flush's unattributed block time
   * (the guards, the header compose, the bookkeeping). `flushMs` is elapsed and
   * is a different quantity entirely; see {@link FlushSpans}.
   *
   * @param id Session id.
   * @param spans The flush's timing breakdown.
   */
  recordFlush(id: string, spans: FlushSpans): void {
    if (!this.enabled) return;
    const c = this.forSession(id);
    c.flushNs += spans.totalNs;
    c.syncNs += spans.syncNs;
    c.flushes += 1;
    c.composeNs += spans.composeNs;
    c.encodeNs += spans.encodeNs;
    c.writeNs += spans.writeNs;
  }

  /**
   * Open a wall-clock span.
   *
   * @returns A start stamp to hand back to {@link endSpan} / {@link endIpc}, or
   *   `0n` while disabled — which makes the matching end call a no-op, so a call
   *   site needs no `isEnabled()` branch of its own.
   */
  startSpan(): bigint {
    return this.enabled ? process.hrtime.bigint() : 0n;
  }

  /**
   * Close a span opened by {@link startSpan} and add it to the window.
   *
   * @param name Which span (see {@link MainSpanName}).
   * @param start The stamp {@link startSpan} returned; `0n` records nothing.
   */
  endSpan(name: MainSpanName, start: bigint): void {
    if (start === 0n || !this.enabled) return;
    addSpan(this.mainSpans, name, process.hrtime.bigint() - start);
  }

  /**
   * Close an `ipcMain.handle` dispatch span, bucketed by channel.
   *
   * @param channel The IPC channel that was dispatched.
   * @param start The stamp {@link startSpan} returned; `0n` records nothing.
   */
  endIpc(channel: string, start: bigint): void {
    if (start === 0n || !this.enabled) return;
    addSpan(this.ipcSpans, channel, process.hrtime.bigint() - start);
  }

  /**
   * Merge one renderer report into the window.
   *
   * The renderer drains on its own 2.5 s timer, so a main window usually holds
   * exactly one report but may hold none or two. Counters sum; the loop
   * percentiles take the worst of the merged reports rather than an average,
   * because averaging percentiles is meaningless and the number this exists to
   * answer — "was the renderer stalled?" — must not be diluted by a quiet
   * neighbour.
   *
   * @param report The renderer's counters since its previous drain.
   */
  recordRendererReport(report: RendererPerfReport): void {
    if (!this.enabled) return;
    const totals = (this.renderer ??= emptyRendererTotals());
    totals.reports += 1;
    totals.windowMs += report.windowMs;
    totals.loopP50 = Math.max(totals.loopP50, report.loop.p50);
    totals.loopP99 = Math.max(totals.loopP99, report.loop.p99);
    totals.loopMax = Math.max(totals.loopMax, report.loop.max);
    totals.samples += report.samples;
    totals.hiddenMs += report.hiddenMs;
    totals.frames += report.frames;
    totals.longFrames += report.longFrames;
    totals.frameMaxMs = Math.max(totals.frameMaxMs, report.frameMaxMs);
    for (const [name, span] of Object.entries(report.spans ?? {})) {
      const entry = totals.spans.get(name) ?? { ns: 0n, n: 0 };
      entry.ns += BigInt(Math.round(span.ms * 1e6));
      entry.n += span.n;
      totals.spans.set(name, entry);
    }
    for (const [name, count] of Object.entries(report.counts ?? {})) {
      totals.counts.set(name, (totals.counts.get(name) ?? 0) + count);
    }
    // Peaks merge by max — summing two windows' buffer depths would report a
    // depth that never existed.
    for (const [name, peak] of Object.entries(report.maxima ?? {})) {
      const seen = totals.maxima.get(name);
      if (seen === undefined || peak > seen) totals.maxima.set(name, peak);
    }
  }

  /** Record a coalesced `termData` batch leaving main. */
  recordBatch(id: string, inFlight: number): void {
    if (!this.enabled) return;
    const c = this.forSession(id);
    c.batches += 1;
    if (inFlight > c.inFlightPeak) c.inFlightPeak = inFlight;
  }

  /** Record a backpressure pause. */
  recordPause(id: string): void {
    if (!this.enabled) return;
    this.forSession(id).pauses += 1;
  }

  /** Record a pause-watchdog force-resume — a signal the renderer stopped
   *  acking, i.e. it is saturated. */
  recordWatchdog(id: string): void {
    if (!this.enabled) return;
    this.forSession(id).watchdogs += 1;
  }

  /**
   * Build the record for the window just ended and reset the accumulators.
   * Exposed separately from `flush` so tests can assert the shape without
   * touching disk.
   *
   * A window is recorded whenever there is **anything** to report — a session
   * that moved bytes, a timed main-thread span, an IPC dispatch, an observed GC,
   * a renderer report, or a loop delay at or above {@link IDLE_LOOP_MAX_MS}.
   * Only a window that is idle on every one of those is dropped. Until v3 the
   * gate was "some session moved bytes", which threw away every stall that had
   * no terminal work in it — 20 % of the ≥ 100 ms stalls in the baseline, and
   * precisely the ones nothing else could explain.
   *
   * @returns The record, or undefined when disabled or the window was idle.
   */
  takeRecord(): PerfRecord | undefined {
    if (!this.enabled || !this.histogram) return undefined;
    const at = this.now();
    const loop = {
      p50: loopDelayMs(this.histogram.percentile(50)),
      p99: loopDelayMs(this.histogram.percentile(99)),
      max: loopDelayMs(this.histogram.max),
    };
    const idle =
      this.counters.size === 0 &&
      this.mainSpans.size === 0 &&
      this.ipcSpans.size === 0 &&
      (this.gc?.n ?? 0) === 0 &&
      this.rendererIsIdle() &&
      loop.max < IDLE_LOOP_MAX_MS;
    if (idle) {
      // Nothing to record, but the window must still close. Leaving the
      // histogram un-reset let one spike (a GC pause, a git-status stall) sit in
      // `max` indefinitely once tabs went quiet — so the pane's headline number
      // was least trustworthy exactly when the app was idle enough to read it —
      // and made the next record's `windowMs` span the whole idle stretch.
      this.resetWindow(at);
      return undefined;
    }
    const sessions: Record<string, SessionRecord> = {};
    for (const [id, c] of this.counters) {
      // Spread-if-present rather than assigning undefined: an undefined-valued
      // key still exists on the object (JSON.stringify drops it, but every
      // in-process reader — notably the perf panel — sees it), so a quiet
      // session would carry ten dead keys.
      sessions[id] = {
        bytes: c.bytes,
        chunks: c.chunks,
        ...omitUndefined({
          oscMs: ms(c.oscNs),
          logParseMs: ms(c.logParseNs),
          gridRenderMs: ms(c.gridRenderNs),
          gridRenders: positive(c.gridRenders),
          syncFlushMs: ms(c.syncNs),
          flushMs: ms(c.flushNs),
          flushes: positive(c.flushes),
          composeMs: ms(c.composeNs),
          encodeMs: ms(c.encodeNs),
          writeMs: ms(c.writeNs),
          batches: positive(c.batches),
          pauses: positive(c.pauses),
          watchdogs: positive(c.watchdogs),
          inFlightPeak: positive(c.inFlightPeak),
        }),
      };
    }
    const main = this.takeMainRecord();
    const renderer = this.takeRendererRecord();
    const record: PerfRecord = {
      schema: PERF_SCHEMA_VERSION,
      t: at.toISOString(),
      windowMs: at.getTime() - this.windowStart,
      loop,
      heapUsed: process.memoryUsage().heapUsed,
      sessions,
      ...(main ? { main } : {}),
      ...(renderer ? { renderer } : {}),
    };
    this.resetWindow(at);
    return record;
  }

  /**
   * Whether the renderer's merged block says nothing happened.
   *
   * The renderer already withholds an empty drain, but the idle gate must not
   * depend on that: the first version of this code treated *any* report as
   * activity, and since the renderer reported unconditionally the gate could
   * never fire — an idle app wrote ~11 MB/day of records saying nothing had
   * happened, while three separate docs claimed it wrote nothing. Applying the
   * same threshold on both sides makes the property hold whichever side is
   * older.
   */
  private rendererIsIdle(): boolean {
    const totals = this.renderer;
    if (!totals) return true;
    return (
      totals.loopMax < IDLE_LOOP_MAX_MS &&
      totals.longFrames === 0 &&
      totals.spans.size === 0 &&
      totals.counts.size === 0 &&
      totals.maxima.size === 0
    );
  }

  /** Close the window: drop the accumulators, reset the histogram, restamp the
   *  start. Shared by the recorded and the suppressed-idle paths so the two can
   *  never diverge on what "the window ended" means. */
  private resetWindow(at: Date): void {
    this.counters.clear();
    this.mainSpans.clear();
    this.ipcSpans.clear();
    this.renderer = undefined;
    if (this.gc) this.gc = { n: 0, ms: 0, maxMs: 0 };
    this.histogram?.reset();
    this.windowStart = at.getTime();
  }

  /** The window's `main` block, or undefined when nothing was timed and GC is
   *  unobservable. */
  private takeMainRecord(): MainRecord | undefined {
    const spans = spanRecords(this.mainSpans);
    const ipc = spanRecords(this.ipcSpans);
    if (!spans && !ipc && !this.gc) return undefined;
    return {
      ...(spans ? { spans } : {}),
      ...(ipc ? { ipc } : {}),
      // Emitted even at n: 0 — see MainRecord.gc. Rounded so a record does not
      // carry sixteen digits of float noise per window.
      ...(this.gc
        ? {
            gc: {
              n: this.gc.n,
              ms: Math.round(this.gc.ms * 1e3) / 1e3,
              maxMs: Math.round(this.gc.maxMs * 1e3) / 1e3,
            },
          }
        : {}),
    };
  }

  /** The window's `renderer` block, or undefined when the renderer did not
   *  report (recording off on that side, or no window yet). */
  private takeRendererRecord(): RendererRecord | undefined {
    const totals = this.renderer;
    if (!totals) return undefined;
    const spans = spanRecords(totals.spans);
    const counts = Object.fromEntries(totals.counts);
    return {
      reports: totals.reports,
      windowMs: totals.windowMs,
      loop: { p50: totals.loopP50, p99: totals.loopP99, max: totals.loopMax },
      samples: totals.samples,
      hiddenMs: totals.hiddenMs,
      frames: totals.frames,
      longFrames: totals.longFrames,
      frameMaxMs: totals.frameMaxMs,
      ...(spans ? { spans } : {}),
      ...(Object.keys(counts).length > 0 ? { counts } : {}),
      ...(totals.maxima.size > 0 ? { maxima: Object.fromEntries(totals.maxima) } : {}),
    };
  }

  /**
   * Append the current window's record to the JSONL file. Best-effort: a write
   * failure disables further attempts rather than surfacing to the caller,
   * because instrumentation must never break the thing it measures.
   */
  async flush(): Promise<void> {
    const record = this.takeRecord();
    if (!record || !this.conceptionPath || this.writeFailed) return;
    // Recompute the day-stamped path per flush rather than caching it at
    // enable time: a session left recording across midnight would otherwise keep
    // appending to yesterday's file, breaking the documented one-file-per-day
    // contract precisely on the long runs worth studying.
    const path = perfLogPath(this.conceptionPath, this.now());
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      this.writeFailed = true;
    }
  }
}

/** Read the current vitals without disturbing the recording window. */
export function readVitals(log: PerfLog): PerfVitals {
  return {
    recording: log.isEnabled(),
    // Report the write state, not just the intent. Swallowing a write error is
    // right for an instrument, but a pane that keeps saying "Recording" after
    // the disk filled lets the user believe they captured a long run and walk
    // away with nothing.
    writeFailed: log.hasWriteFailed(),
    loop: log.peekLoop(),
    heapUsed: process.memoryUsage().heapUsed,
  };
}

/** Path of the perf JSONL for a conception, one file per day. */
export function perfLogPath(conceptionPath: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return join(perfLogRoot(conceptionPath), `${day}.jsonl`);
}

/** Directory holding a conception's perf records. */
export function perfLogRoot(conceptionPath: string): string {
  return join(conceptionPath, '.condash', 'perf');
}

/** Days of perf records to keep. Short on purpose: these are diagnostic traces
 *  taken during a specific investigation, not history worth carrying. */
const PERF_RETENTION_DAYS = 14;
/** Ceiling for the whole perf directory. Recording produces roughly 10 MB/day
 *  with two active tabs and ~80 MB/day with twenty, so this bounds even a
 *  recording session left on and forgotten. */
const PERF_MAX_DIR_BYTES = 200 * 1024 * 1024;

export interface PerfJanitorResult {
  scanned: number;
  deleted: string[];
  remainingBytes: number;
}

/**
 * Prune `<conception>/.condash/perf/`.
 *
 * The day-stamped filename bounds a single *file*, never the directory, and
 * nothing else pruned it — so recording left on accumulated without limit, in a
 * directory no UI reports the size of. Mirrors the terminal-log janitor: evict
 * by age, then oldest-first until under the cap.
 *
 * **Today's file is never a victim.** A live recorder is appending to it, and
 * deleting it mid-session throws away the run the user is in the middle of
 * capturing — the same rule the log janitor applies to the current day-dir.
 *
 * Errors are swallowed per-file: a janitor must never break app start.
 *
 * @param conceptionPath Conception whose perf directory to prune.
 * @param now Clock, injectable for tests.
 * @returns What was scanned, what was deleted, and the surviving byte total.
 */
export async function runPerfJanitor(
  conceptionPath: string,
  now: Date = new Date(),
): Promise<PerfJanitorResult> {
  const root = perfLogRoot(conceptionPath);
  const result: PerfJanitorResult = { scanned: 0, deleted: [], remainingBytes: 0 };

  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return result; // no perf dir → nothing to do
  }

  const today = perfLogPath(conceptionPath, now).slice(root.length + 1);
  const files: { name: string; day: string; bytes: number }[] = [];
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!match) continue;
    try {
      files.push({ name, day: match[1], bytes: (await stat(join(root, name))).size });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  result.scanned = files.length;
  if (files.length === 0) return result;

  // UTC arithmetic throughout: filenames are stamped with `toISOString`, so
  // deriving the cutoff with local-time `setDate` mixed two calendars and made
  // retention wobble by a day across a DST change when the clock sat near the
  // UTC date boundary.
  const cutoffDay = new Date(now.getTime() - PERF_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  /** Delete a record, reporting whether it actually went. The caller's byte
   *  accounting depends on the answer — assuming success let a permission
   *  failure under-count the directory and stop the cap pass early. */
  const drop = async (file: { name: string; bytes: number }): Promise<boolean> => {
    try {
      await rm(join(root, file.name), { force: true });
      result.deleted.push(file.name);
      return true;
    } catch {
      return false; // left in place; retried on the next sweep
    }
  };

  // Oldest first, so the cap pass evicts in the right order.
  files.sort((a, b) => (a.day < b.day ? -1 : 1));
  // `<=` keeps exactly PERF_RETENTION_DAYS days including today. With `<` the
  // cutoff day itself survived, so 14 days of retention kept 15.
  for (const file of files) {
    if (file.name !== today && file.day <= cutoffDay) await drop(file);
  }

  const survivors = files.filter((f) => !result.deleted.includes(f.name));
  let total = survivors.reduce((sum, f) => sum + f.bytes, 0);
  for (const file of survivors) {
    if (total <= PERF_MAX_DIR_BYTES) break;
    if (file.name === today) continue;
    if (await drop(file)) total -= file.bytes;
  }
  result.remainingBytes = total;
  return result;
}

/** Process-wide instance. Terminal hot paths call into it unconditionally; it
 *  short-circuits while disabled. */
export const perfLog = new PerfLog();
