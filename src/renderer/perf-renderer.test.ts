/**
 * Cover for the renderer-side counters.
 *
 * The class is the renderer half of the perf log, and the two properties that
 * make it safe to ship are both testable without a browser: it must be
 * completely inert while disabled (an ordinary user never turns recording on),
 * and each drain must reset, so a window's figures describe that window rather
 * than everything since launch.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { RendererPerf } from './perf-renderer';

const instances: RendererPerf[] = [];

/** An enabled recorder, switched off after the test so its 10 ms probe timer
 *  cannot outlive it (a leaked interval would keep sampling — and, in a watch
 *  run, keep the process alive). */
function recording(): RendererPerf {
  const perf = new RendererPerf();
  perf.setEnabled(true);
  instances.push(perf);
  return perf;
}

afterEach(() => {
  for (const perf of instances.splice(0)) perf.setEnabled(false);
  delete (globalThis as { document?: unknown }).document;
});

/** A minimal `document` stand-in with a settable visibility state, so the
 *  hidden-page rule is testable without a browser. Installed on `globalThis`
 *  and removed by the suite's `afterEach`. */
function fakeDocument(): { setHidden: (hidden: boolean) => void } {
  const listeners: (() => void)[] = [];
  const page = {
    visibilityState: 'visible',
    addEventListener: (_event: string, listener: () => void) => listeners.push(listener),
    removeEventListener: (_event: string, listener: () => void) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  (globalThis as { document?: unknown }).document = page;
  return {
    setHidden: (hidden: boolean) => {
      page.visibilityState = hidden ? 'hidden' : 'visible';
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The loop-sample count a recorder has accumulated so far, read without
 *  draining it — `takeReport` resets, which these tests must not do mid-run. */
function countSamples(perf: RendererPerf): number {
  return (perf as unknown as { loopSamples: number[] }).loopSamples.length;
}

describe('RendererPerf', () => {
  it('records nothing while disabled', () => {
    const perf = new RendererPerf();
    expect(perf.isEnabled()).toBe(false);
    perf.endSpan('demoteSerialize', perf.startSpan());
    perf.count('demotes');
    expect(perf.takeReport()).toBeUndefined();
  });

  it('accumulates spans and counts', () => {
    const perf = recording();
    perf.endSpan('demoteSerialize', perf.startSpan());
    perf.endSpan('demoteSerialize', perf.startSpan());
    perf.endSpan('mount', perf.startSpan());
    perf.count('demotes');
    perf.count('demotes', 2);

    const report = perf.takeReport();
    expect(report?.spans?.demoteSerialize.n).toBe(2);
    expect(report?.spans?.mount.n).toBe(1);
    expect(report?.counts).toEqual({ demotes: 3 });
  });

  it('resets between drains', () => {
    const perf = recording();
    perf.count('promotes');
    expect(perf.takeReport()?.counts).toEqual({ promotes: 1 });

    const second = perf.takeReport();
    expect(second?.counts).toBeUndefined();
    expect(second?.spans).toBeUndefined();
    expect(second?.frames).toBe(0);
  });

  it('measures loop delay above the probe interval', async () => {
    const perf = recording();
    // A block that starts before the probe has fired once is not attributable to
    // it, so let it warm up first — the same property the main-process
    // histogram has.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const until = Date.now() + 80;
    while (Date.now() < until) {
      /* deliberate busy wait */
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    const loop = perf.takeReport()?.loop;
    expect(loop?.max).toBeGreaterThan(40);
    // An unstalled probe fires close enough to schedule that the median stays
    // near zero — the number would be useless if every tick read as delay.
    expect(loop?.p50).toBeLessThan(20);
  });

  it('reports a zeroed loop when no sample was taken', () => {
    // Percentiles over an empty sample list must be 0, never NaN: the decoder on
    // the main side rejects a non-finite field and would drop the whole report.
    const perf = recording();
    const report = perf.takeReport();
    expect(report?.loop).toEqual({ p50: 0, p99: 0, max: 0 });
    expect(report?.windowMs).toBeGreaterThanOrEqual(0);
  });

  it('withholds a window with nothing in it', () => {
    // With recording on the probe fires 100×/s and the frame chain runs
    // continuously, so "a sample exists" is true every window. If that counted
    // as reportable, main's idle gate could never fire and an idle app would
    // write ~11 MB/day of records saying nothing happened.
    const perf = recording();
    const idle = perf.takeReport()!;
    expect(RendererPerf.isReportable(idle)).toBe(false);

    perf.count('demotes');
    expect(RendererPerf.isReportable(perf.takeReport()!)).toBe(true);
  });

  it('treats a real stall, a dropped frame, or a peak as reportable', () => {
    const perf = recording();
    const base = perf.takeReport()!;
    expect(RendererPerf.isReportable({ ...base, loop: { p50: 0, p99: 0, max: 40 } })).toBe(true);
    expect(RendererPerf.isReportable({ ...base, longFrames: 1 })).toBe(true);
    expect(RendererPerf.isReportable({ ...base, maxima: { transitionBufferChars: 3 } })).toBe(true);
    // …and a sub-threshold wobble is not.
    expect(RendererPerf.isReportable({ ...base, loop: { p50: 0.2, p99: 1, max: 3 } })).toBe(false);
  });

  it('reports peaks by their maximum, not their sum', () => {
    const perf = recording();
    perf.observeMax('transitionBufferChars', 4);
    perf.observeMax('transitionBufferChars', 11);
    perf.observeMax('transitionBufferChars', 7);
    expect(perf.takeReport()?.maxima).toEqual({ transitionBufferChars: 11 });
  });

  it('carries the sample count and hidden time', () => {
    const perf = recording();
    const report = perf.takeReport()!;
    // No `document` in this environment, so the page is never hidden — the
    // fields must still be present and finite, or the main-side decoder rejects
    // the whole report.
    expect(report.hiddenMs).toBe(0);
    expect(Number.isFinite(report.samples)).toBe(true);
  });

  it('times a write through its completion callback, not its enqueue', async () => {
    // `term.write` queues the parse and returns, so bracketing the call measured
    // the enqueue (~0 ms) — C1's defect, reproduced on the renderer side.
    const perf = recording();
    let deliver: (() => void) | undefined;
    const term = {
      write(_data: string, callback?: () => void) {
        deliver = callback;
      },
    };
    perf.timeWrite(term, 'some bytes', 'termWrite');
    // Nothing recorded yet: the parse has not happened.
    expect(deliver).toBeTypeOf('function');
    await new Promise((resolve) => setTimeout(resolve, 20));
    deliver!();

    const span = perf.takeReport()?.spans?.termWrite;
    expect(span?.n).toBe(1);
    expect(span!.ms).toBeGreaterThan(10);
  });

  it('writes straight through while disabled', () => {
    const perf = new RendererPerf();
    let written = '';
    perf.timeWrite({ write: (data) => (written = data) }, 'bytes', 'termWrite');
    expect(written).toBe('bytes');
    expect(perf.takeReport()).toBeUndefined();
  });

  it('records no loop samples while the page is hidden, and says how long it was', async () => {
    // Electron's `backgroundThrottling` defaults on, so Chromium drops renderer
    // timers to ~1 Hz for an occluded window. Sampling through that reports
    // ~990 ms "stalls" that never happened — which would invert the one
    // question this module exists to answer. Hidden samples are discarded and
    // the hidden time is reported instead.
    const page = fakeDocument();
    const perf = recording();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const visibleSamples = countSamples(perf);

    page.setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    page.setHidden(false);

    const report = perf.takeReport()!;
    expect(report.hiddenMs).toBeGreaterThan(30);
    // ~6 probe firings happened while hidden and contributed nothing; the only
    // slack allowed is one sample racing the visibility flip itself.
    expect(report.samples).toBeLessThanOrEqual(visibleSamples + 1);
  });

  it('does not charge an occlusion gap to the first frame after it', () => {
    // `resetWindow` must clear `lastFrameAt`; otherwise the first frame after a
    // ten-minute occlusion is recorded as a ten-minute frame.
    const perf = recording();
    perf.takeReport();
    expect(perf.takeReport()?.frameMaxMs).toBe(0);
  });

  it('drops the window when recording stops', () => {
    const perf = recording();
    perf.count('demotes');
    perf.setEnabled(false);
    expect(perf.takeReport()).toBeUndefined();

    perf.setEnabled(true);
    instances.push(perf);
    expect(perf.takeReport()?.counts).toBeUndefined();
  });
});
