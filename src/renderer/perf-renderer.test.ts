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
});

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
