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
 * - **One message per window, never per frame.** The drain rides the same 2.5 s
 *   cadence main flushes on, so the reporting cost is one `invoke` per 2.5 s —
 *   not one per animation frame, which would itself be the stall.
 * - **Comparable to main by construction.** The loop probe measures the gap
 *   between its own firings and reports the excess over its interval, which is
 *   what `loopDelayMs` does for `monitorEventLoopDelay` on main. A number from
 *   this module and a number from that one mean the same thing.
 */

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

/** Sentinel returned by {@link RendererPerf.startSpan} while disabled — `-1`
 *  rather than `0`, which is a legal `performance.now()` reading. */
const NO_SPAN = -1;

/** Accumulated wall time and call count for one renderer span. */
interface SpanTotals {
  ms: number;
  n: number;
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
      this.lastFrameAt = 0;
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
   * Take the window's counters and reset.
   *
   * @returns The report, or undefined while disabled.
   */
  takeReport(): RendererPerfReport | undefined {
    if (!this.enabled) return undefined;
    const now = performance.now();
    const samples = this.loopSamples;
    const report: RendererPerfReport = {
      windowMs: Math.round(now - this.windowStart),
      loop: {
        p50: percentile(samples, 50),
        p99: percentile(samples, 99),
        max: samples.length === 0 ? 0 : round3(Math.max(...samples)),
      },
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
    };
    this.resetWindow();
    return report;
  }

  /** Drop every accumulator and restamp the window. */
  private resetWindow(): void {
    this.loopSamples = [];
    this.frames = 0;
    this.longFrames = 0;
    this.frameMaxMs = 0;
    this.spans.clear();
    this.counts.clear();
    this.windowStart = performance.now();
  }

  /** One loop-delay sample: how much later than promised this timer fired. */
  private probeLoop(): void {
    const now = performance.now();
    const delay = now - this.lastProbeAt - LOOP_PROBE_MS;
    this.lastProbeAt = now;
    if (delay > 0 && this.loopSamples.length < MAX_LOOP_SAMPLES) this.loopSamples.push(delay);
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

  /** Ship the window to main. A failed send drops that window rather than
   *  retrying — an instrument must never queue work against the thread it
   *  measures. Main's reply doubles as the authority on whether to keep
   *  sampling, so recording turned off anywhere stops this side too. */
  private async drainAndSend(): Promise<void> {
    const report = this.takeReport();
    if (!report) return;
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
