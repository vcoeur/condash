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

import { appendFile, mkdir } from 'node:fs/promises';
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
  /** ISO timestamp of the flush. */
  t: string;
  /** Milliseconds covered by this window. */
  windowMs: number;
  /** Event-loop delay over the window, in milliseconds. */
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
  private filePath: string | undefined;
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
   * @param filePath Destination JSONL file; required when enabling.
   */
  setEnabled(enabled: boolean, filePath?: string): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.filePath = filePath;
      this.histogram = monitorEventLoopDelay({ resolution: 10 });
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

  /** Event-loop delay percentiles (ms) for the window so far, WITHOUT resetting
   *  it. `takeRecord` is the resetting read; this one exists so a display can
   *  poll without stealing data from the recorded windows. */
  peekLoop(): { p50: number; p99: number; max: number } | undefined {
    if (!this.enabled || !this.histogram) return undefined;
    return {
      p50: Math.round(this.histogram.percentile(50) / 1e3) / 1e3,
      p99: Math.round(this.histogram.percentile(99) / 1e3) / 1e3,
      max: Math.round(this.histogram.max / 1e3) / 1e3,
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
    if (this.counters.size === 0) return undefined;
    const at = this.now();
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
      t: at.toISOString(),
      windowMs: at.getTime() - this.windowStart,
      loop: {
        p50: Math.round(this.histogram.percentile(50) / 1e3) / 1e3,
        p99: Math.round(this.histogram.percentile(99) / 1e3) / 1e3,
        max: Math.round(this.histogram.max / 1e3) / 1e3,
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
    if (!record || !this.filePath || this.writeFailed) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      this.writeFailed = true;
    }
  }
}

/** Read the current vitals without disturbing the recording window. */
export function readVitals(log: PerfLog): PerfVitals {
  return {
    recording: log.isEnabled(),
    loop: log.peekLoop(),
    heapUsed: process.memoryUsage().heapUsed,
  };
}

/** Path of the perf JSONL for a conception, one file per day. */
export function perfLogPath(conceptionPath: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return join(conceptionPath, '.condash', 'perf', `${day}.jsonl`);
}

/** Process-wide instance. Terminal hot paths call into it unconditionally; it
 *  short-circuits while disabled. */
export const perfLog = new PerfLog();
