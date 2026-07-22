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
 */

import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { dirname, join } from 'node:path';

import type { PerfVitals } from '../shared/types';

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
  /** Coalesced `termData` batches sent to the renderer. */
  batches: number;
  /** Times the pty was paused by backpressure. */
  pauses: number;
  /** Times the pause watchdog force-resumed a pty. */
  watchdogs: number;
  /** Highest un-acked byte count seen this window. */
  inFlightPeak: number;
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
  /** Live sessions with any activity this window, keyed by session id. */
  sessions: Record<string, SessionRecord>;
}

/** Per-session slice of a flushed record; zero-valued fields are omitted. */
export interface SessionRecord {
  bytes: number;
  chunks: number;
  oscMs?: number;
  logParseMs?: number;
  gridRenderMs?: number;
  gridRenders?: number;
  batches?: number;
  pauses?: number;
  watchdogs?: number;
  inFlightPeak?: number;
}

const emptyCounters = (): SessionCounters => ({
  bytes: 0,
  chunks: 0,
  oscNs: 0n,
  logParseNs: 0n,
  gridRenderNs: 0n,
  gridRenders: 0,
  batches: 0,
  pauses: 0,
  watchdogs: 0,
  inFlightPeak: 0,
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
 *  invisible in the shape but makes the two incomparable. */
export const PERF_SCHEMA_VERSION = 2;

/** Sampling resolution (ms) of the event-loop histogram — and, crucially, the
 *  floor it reports. See {@link loopDelayMs}. */
const LOOP_RESOLUTION_MS = 10;

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
function loopDelayMs(nanoseconds: number): number {
  const rawMs = nanoseconds / 1e6;
  return Math.max(0, Math.round((rawMs - LOOP_RESOLUTION_MS) * 1e3) / 1e3);
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
    } else {
      this.histogram?.disable();
      this.histogram = undefined;
      this.counters.clear();
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
   * @returns The record, or undefined when disabled or nothing happened.
   */
  takeRecord(): PerfRecord | undefined {
    if (!this.enabled || !this.histogram) return undefined;
    const at = this.now();
    if (this.counters.size === 0) {
      // Nothing to record, but the window must still close. Leaving the
      // histogram un-reset let one spike (a GC pause, a git-status stall) sit in
      // `max` indefinitely once tabs went quiet — so the pane's headline number
      // was least trustworthy exactly when the app was idle enough to read it —
      // and made the next record's `windowMs` span the whole idle stretch.
      this.histogram.reset();
      this.windowStart = at.getTime();
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
          batches: positive(c.batches),
          pauses: positive(c.pauses),
          watchdogs: positive(c.watchdogs),
          inFlightPeak: positive(c.inFlightPeak),
        }),
      };
    }
    const record: PerfRecord = {
      schema: PERF_SCHEMA_VERSION,
      t: at.toISOString(),
      windowMs: at.getTime() - this.windowStart,
      loop: {
        p50: loopDelayMs(this.histogram.percentile(50)),
        p99: loopDelayMs(this.histogram.percentile(99)),
        max: loopDelayMs(this.histogram.max),
      },
      heapUsed: process.memoryUsage().heapUsed,
      sessions,
    };
    this.counters.clear();
    this.histogram.reset();
    this.windowStart = at.getTime();
    return record;
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
