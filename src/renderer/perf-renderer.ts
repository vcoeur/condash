/**
 * Renderer-side performance counters — the missing half of the perf log.
 *
 * `perf-log.ts` measures the **main** process, so 11 h of production records
 * could say that a stall happened but never whether the user's UI froze because
 * main blocked or because the renderer did. Every Axis-B option in the
 * 2026-07-24 review is unranked for exactly that reason: the only renderer
 * evidence that existed was one CDP trace of an 8-tab flood. This module mirrors
 * the main-process instrument on this side and ships its counters through the
 * same JSONL record.
 *
 * ## Design constraints (the same three the main-process module holds itself to)
 *
 * - **Off by default and inert when off.** Nothing samples, nothing allocates
 *   and no IPC is sent unless main says it is recording. Every entry point is a
 *   compare-and-return in that state.
 * - **One message per window, never per frame** — and none at all for a window
 *   with nothing in it. The drain rides the same 2.5 s cadence main flushes on,
 *   so the reporting cost is one `invoke` per 2.5 s while something is
 *   happening, not one per animation frame, which would itself be the stall.
 * - **Comparable to main by construction.** The loop probe measures the gap
 *   between its own firings and reports the excess over its interval through the
 *   *same* function main uses (`shared/loop-delay.ts`). A number from this
 *   module and a number from that one mean the same thing.
 *
 * ## The throttling trap
 *
 * Electron's `backgroundThrottling` defaults to true, so Chromium drops renderer
 * timers to roughly 1 Hz whenever the window is occluded, minimised or hidden. A
 * naive probe then reports ~990 ms of "event-loop delay" that never happened,
 * for as long as the user looks at another window — inverting the one question
 * this module exists to answer. So samples taken while the page is hidden are
 * **not recorded at all**, the clock restarts on the way back to visible, and
 * every report carries `hiddenMs` plus its `samples` count so a reader can see
 * both that a window was partly hidden and whether the sampler ran at its
 * nominal rate.
 */

import { delayAboveInterval, IDLE_LOOP_MAX_MS } from '@shared/loop-delay';
import type { RendererPerfReport } from '@shared/types';

/** Loop-probe interval (ms). Matches the main process's histogram resolution,
 *  so both sides report delay above the same floor. */
const LOOP_PROBE_MS = 10;

/** Drain cadence (ms). Matches main's sampler tick so a report normally lands in
 *  the window it describes. */
const REPORT_MS = 2500;

/** Frame gap (ms) at or above which a frame counts as long. The long-task
 *  threshold, so a "long frame" here means the same thing it does in a CDP
 *  trace. */
const LONG_FRAME_MS = 50;

/** Ceiling on retained loop samples per window. A drain that never runs (main
 *  stopped recording without telling us) must not grow an unbounded array; at
 *  the probe interval this is ~40 s of samples. */
const MAX_LOOP_SAMPLES = 4000;

/** Drains after which an idle renderer sends one report anyway, purely to hear
 *  main's `recording` reply. 12 × 2.5 s = 30 s. Main's own gate discards an idle
 *  renderer block, so this costs a message and never a record; it is the
 *  backstop for a `perfState` push that never arrived. */
const KEEPALIVE_DRAINS = 12;

/** Sentinel returned by {@link RendererPerf.startSpan} while disabled — `-1`
 *  rather than `0`, which is a legal `performance.now()` reading. */
const NO_SPAN = -1;

/** Accumulated wall time and call count for one renderer span. */
interface SpanTotals {
  ms: number;
  n: number;
}

/** The slice of xterm's `Terminal` {@link RendererPerf.timeWrite} needs.
 *  Structural so the module never imports xterm — it is loaded lazily on first
 *  terminal open and must stay out of the boot chunk. */
export interface XtermWriteTarget {
  write(data: string, callback?: () => void): void;
}

/**
 * Renderer counters for the current window.
 *
 * A singleton, like `perfLog` on main: the instrumented call sites (the terminal
 * controller, the worker manager) are scattered and must not each be handed a
 * reference.
 */
export class RendererPerf {
  private enabled = false;
  private loopTimer: ReturnType<typeof setInterval> | undefined;
  private reportTimer: ReturnType<typeof setInterval> | undefined;
  private rafHandle: number | undefined;
  private loopSamples: number[] = [];
  private lastProbeAt = 0;
  private lastFrameAt = 0;
  private frames = 0;
  private longFrames = 0;
  private frameMaxMs = 0;
  private windowStart = 0;
  private spans = new Map<string, SpanTotals>();
  private counts = new Map<string, number>();
  private maxima = new Map<string, number>();
  /** Ms of the current window spent hidden, closed on each visibility change. */
  private hiddenMs = 0;
  /** When the page went hidden, or undefined while visible. */
  private hiddenSince: number | undefined;
  /** Drains since the last report actually sent — see {@link KEEPALIVE_DRAINS}. */
  private silentDrains = 0;
  private visibilityListener: (() => void) | undefined;

  /** Whether counters are being collected. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start or stop collecting.
   *
   * @param enabled Whether main is recording. Turning it off drops everything
   *   accumulated so far rather than reporting a partial window against a
   *   recorder that has stopped.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.resetWindow();
      this.lastProbeAt = performance.now();
      this.hiddenSince = this.pageHidden() ? performance.now() : undefined;
      this.watchVisibility();
      this.loopTimer = setInterval(() => this.probeLoop(), LOOP_PROBE_MS);
      this.reportTimer = setInterval(() => void this.drainAndSend(), REPORT_MS);
      this.scheduleFrame();
    } else {
      if (this.loopTimer) clearInterval(this.loopTimer);
      if (this.reportTimer) clearInterval(this.reportTimer);
      if (this.rafHandle !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.rafHandle);
      }
      this.loopTimer = undefined;
      this.reportTimer = undefined;
      this.rafHandle = undefined;
      this.unwatchVisibility();
      this.hiddenSince = undefined;
      this.resetWindow();
    }
  }

  /**
   * Open a span.
   *
   * @returns A start stamp for {@link endSpan}, or a sentinel while disabled —
   *   which makes the matching `endSpan` a no-op, so call sites need no branch.
   */
  startSpan(): number {
    return this.enabled ? performance.now() : NO_SPAN;
  }

  /**
   * Close a span opened by {@link startSpan}.
   *
   * @param name Span name, as it will appear in `renderer.spans`.
   * @param start The stamp {@link startSpan} returned.
   */
  endSpan(name: string, start: number): void {
    if (start === NO_SPAN || !this.enabled) return;
    const elapsed = performance.now() - start;
    const entry = this.spans.get(name);
    if (entry) {
      entry.ms += elapsed;
      entry.n += 1;
    } else {
      this.spans.set(name, { ms: elapsed, n: 1 });
    }
  }

  /**
   * Count a renderer event (a demote, a promote, a worker RPC timeout).
   *
   * @param name Counter name, as it will appear in `renderer.counts`.
   * @param by How much to add. Defaults to 1.
   */
  count(name: string, by = 1): void {
    if (!this.enabled) return;
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }

  /**
   * Observe a level whose interesting value is its peak, not its total — the
   * transition buffer's depth being the case that matters (an unbounded
   * renderer-side buffer is the G5 hazard, and a sum of depths would say
   * nothing about it).
   *
   * @param name Name, as it will appear in `renderer.maxima`.
   * @param value The current level.
   */
  observeMax(name: string, value: number): void {
    if (!this.enabled) return;
    const seen = this.maxima.get(name);
    if (seen === undefined || value > seen) this.maxima.set(name, value);
  }

  /**
   * Time an xterm write, which is asynchronous.
   *
   * `Terminal.write` queues the data and processes it later, yielding every
   * 12 ms, so bracketing the call itself measures the enqueue (≈ 0 ms) and not
   * the parse — the same "the span stops before the work does" defect this
   * whole change exists to correct, reproduced on the renderer side. The
   * callback fires when the data has actually been processed.
   *
   * The resulting span is therefore **elapsed until processed**, including the
   * parser's own yields: an upper bound on block time, not block time.
   *
   * @param term The terminal to write into.
   * @param data The chunk.
   * @param name Span name, as it will appear in `renderer.spans`.
   */
  timeWrite(term: XtermWriteTarget, data: string, name: string): void {
    if (!this.enabled) {
      term.write(data);
      return;
    }
    const span = this.startSpan();
    term.write(data, () => this.endSpan(name, span));
  }

  /**
   * Take the window's counters and reset.
   *
   * @returns The report, or undefined while disabled.
   */
  takeReport(): RendererPerfReport | undefined {
    if (!this.enabled) return undefined;
    const now = performance.now();
    this.closeHiddenSlice(now);
    const samples = this.loopSamples;
    const report: RendererPerfReport = {
      windowMs: Math.round(now - this.windowStart),
      loop: {
        p50: percentile(samples, 50),
        p99: percentile(samples, 99),
        max: samples.length === 0 ? 0 : round3(Math.max(...samples)),
      },
      samples: samples.length,
      hiddenMs: Math.round(this.hiddenMs),
      frames: this.frames,
      longFrames: this.longFrames,
      frameMaxMs: round3(this.frameMaxMs),
      ...(this.spans.size > 0
        ? {
            spans: Object.fromEntries(
              [...this.spans].map(([name, totals]) => [
                name,
                { ms: round3(totals.ms), n: totals.n },
              ]),
            ),
          }
        : {}),
      ...(this.counts.size > 0 ? { counts: Object.fromEntries(this.counts) } : {}),
      ...(this.maxima.size > 0 ? { maxima: Object.fromEntries(this.maxima) } : {}),
    };
    this.resetWindow();
    return report;
  }

  /**
   * Whether a report is worth sending.
   *
   * Deliberately NOT "did anything arrive": with recording on, the probe fires
   * 100×/s and the frame chain runs continuously, so "some sample exists" is
   * true in every window and would make main's idle gate unreachable — an idle
   * app then writes ~11 MB/day of records saying nothing happened. The test is
   * the same one main applies: a real delay, a dropped frame, or some named
   * work.
   *
   * @param report A drained report.
   * @returns True when the window carries something a reader could use.
   */
  static isReportable(report: RendererPerfReport): boolean {
    return (
      report.loop.max >= IDLE_LOOP_MAX_MS ||
      report.longFrames > 0 ||
      report.spans !== undefined ||
      report.counts !== undefined ||
      report.maxima !== undefined
    );
  }

  /** Drop every accumulator and restamp the window. */
  private resetWindow(): void {
    this.loopSamples = [];
    this.frames = 0;
    this.longFrames = 0;
    this.frameMaxMs = 0;
    this.hiddenMs = 0;
    // Without this, the first frame after an occlusion charges the whole
    // occluded stretch to one gap: ten minutes behind another window would be
    // recorded as a ten-minute frame.
    this.lastFrameAt = 0;
    this.spans.clear();
    this.counts.clear();
    this.maxima.clear();
    this.windowStart = performance.now();
  }

  /** True while the page is hidden — occluded, minimised, or on another tab. */
  private pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  /** Fold any open hidden stretch into `hiddenMs`, restarting it if still
   *  hidden so a window that never becomes visible still accounts for itself. */
  private closeHiddenSlice(now: number): void {
    if (this.hiddenSince === undefined) return;
    this.hiddenMs += now - this.hiddenSince;
    this.hiddenSince = now;
  }

  /** Follow page visibility: stop trusting the probe while hidden, and restart
   *  both clocks on the way back so the first visible sample is not the
   *  throttled gap that spans the occlusion. */
  private watchVisibility(): void {
    if (typeof document === 'undefined' || this.visibilityListener) return;
    const listener = (): void => {
      const now = performance.now();
      if (this.pageHidden()) {
        this.hiddenSince = now;
      } else {
        this.closeHiddenSlice(now);
        this.hiddenSince = undefined;
        this.lastProbeAt = now;
        this.lastFrameAt = 0;
      }
    };
    document.addEventListener('visibilitychange', listener);
    this.visibilityListener = listener;
  }

  /** Stop following visibility changes. */
  private unwatchVisibility(): void {
    if (!this.visibilityListener || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.visibilityListener);
    this.visibilityListener = undefined;
  }

  /** One loop-delay sample: how much later than promised this timer fired.
   *  Samples taken while the page is hidden are discarded rather than recorded
   *  — Chromium throttles the timer to ~1 Hz there, and a 990 ms "delay" that
   *  is really the browser saving power would be the loudest number in the
   *  file. */
  private probeLoop(): void {
    const now = performance.now();
    const gap = now - this.lastProbeAt;
    this.lastProbeAt = now;
    if (this.pageHidden()) return;
    // Every sample is kept, floored at 0 — the same population main's histogram
    // reports. Dropping the non-positive ones biased the renderer's median above
    // main's while both claimed to mean the same thing.
    if (this.loopSamples.length < MAX_LOOP_SAMPLES) {
      this.loopSamples.push(delayAboveInterval(gap, LOOP_PROBE_MS));
    }
  }

  /** One animation-frame sample. Re-arms itself; an occluded window simply
   *  stops delivering frames, which reads as `frames: 0` rather than as a
   *  stall. A host with no frame source (a unit test) simply reports no
   *  frames — every other counter still works. */
  private scheduleFrame(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    this.rafHandle = requestAnimationFrame((at) => {
      if (!this.enabled) return;
      if (this.lastFrameAt > 0) {
        const gap = at - this.lastFrameAt;
        this.frames += 1;
        if (gap >= LONG_FRAME_MS) this.longFrames += 1;
        if (gap > this.frameMaxMs) this.frameMaxMs = gap;
      }
      this.lastFrameAt = at;
      this.scheduleFrame();
    });
  }

  /** Ship the window to main, unless there is nothing in it. A failed send drops
   *  that window rather than retrying — an instrument must never queue work
   *  against the thread it measures. Main's reply doubles as the authority on
   *  whether to keep sampling, so recording turned off anywhere stops this side
   *  too; an idle renderer sends one report every {@link KEEPALIVE_DRAINS}
   *  drains so that authority is still heard. */
  private async drainAndSend(): Promise<void> {
    const report = this.takeReport();
    if (!report) return;
    this.silentDrains += 1;
    const keepalive = this.silentDrains >= KEEPALIVE_DRAINS;
    if (!RendererPerf.isReportable(report) && !keepalive) return;
    this.silentDrains = 0;
    try {
      const { recording } = await window.condash.perfRendererReport(report);
      if (!recording) this.setEnabled(false);
    } catch {
      /* window tearing down, or main not listening — skip this window */
    }
  }
}

/** Round to microsecond precision, matching the main-process record. */
function round3(ms: number): number {
  return Math.round(ms * 1e3) / 1e3;
}

/** Percentile of an unsorted sample list; 0 for an empty one. Sorts a copy —
 *  the caller's array is the live accumulator. */
function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return round3(sorted[index]);
}

/** Process-wide instance. Instrumented call sites use it unconditionally; it
 *  short-circuits while disabled. */
export const rendererPerf = new RendererPerf();

/**
 * Wire the renderer counters to main's recording state.
 *
 * Reads the state once at mount (the push below may have fired before the
 * window existed) and then follows main's `perfState` broadcasts, so flipping
 * recording from the Performance pane, the Settings modal, or a hand-edited
 * `settings.json` all start and stop this side.
 *
 * @returns An unsubscribe function that also stops sampling.
 */
export function startRendererPerf(): () => void {
  const off = window.condash.onPerfState(({ recording }) => rendererPerf.setEnabled(recording));
  void window.condash
    .perfVitals()
    .then((vitals) => rendererPerf.setEnabled(vitals.recording))
    .catch(() => undefined);
  return () => {
    off();
    rendererPerf.setEnabled(false);
  };
}
