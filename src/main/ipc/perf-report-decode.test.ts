/**
 * Cover for the renderer perf-report decoder.
 *
 * The report crosses the IPC boundary and is then written into a file read back
 * as evidence, so the decoder's job is to keep a malformed number out of the
 * record entirely — once written, `NaN` in a merged maximum is indistinguishable
 * from a measurement.
 */
import { describe, expect, it } from 'vitest';

import { decodeRendererReport } from './perf-report-decode';

/** A well-formed report; tests override one field at a time. */
const VALID = {
  windowMs: 2500,
  loop: { p50: 0.5, p99: 12, max: 80 },
  samples: 248,
  hiddenMs: 0,
  frames: 140,
  longFrames: 2,
  frameMaxMs: 90,
};

describe('decodeRendererReport', () => {
  it('accepts a well-formed report', () => {
    expect(decodeRendererReport(VALID)).toEqual(VALID);
  });

  it('rejects a non-object payload', () => {
    expect(decodeRendererReport(null)).toBeNull();
    expect(decodeRendererReport('report')).toBeNull();
    expect(decodeRendererReport([VALID])).toBeNull();
  });

  it('rejects a missing loop block', () => {
    const { loop: _loop, ...rest } = VALID;
    expect(decodeRendererReport(rest)).toBeNull();
  });

  it('rejects a report missing the visibility fields', () => {
    // `samples` and `hiddenMs` are what tell a reader a window was throttled
    // rather than stalled, so a report without them is not decodable — it would
    // be indistinguishable from a fully-measured one.
    const { samples: _samples, ...noSamples } = VALID;
    expect(decodeRendererReport(noSamples)).toBeNull();
    const { hiddenMs: _hidden, ...noHidden } = VALID;
    expect(decodeRendererReport(noHidden)).toBeNull();
  });

  it('keeps well-formed peaks', () => {
    const decoded = decodeRendererReport({ ...VALID, maxima: { transitionBufferChars: 12 } });
    expect(decoded?.maxima).toEqual({ transitionBufferChars: 12 });
  });

  it('rejects non-finite and negative numbers', () => {
    expect(decodeRendererReport({ ...VALID, frames: Number.NaN })).toBeNull();
    expect(decodeRendererReport({ ...VALID, windowMs: Number.POSITIVE_INFINITY })).toBeNull();
    expect(decodeRendererReport({ ...VALID, frameMaxMs: -1 })).toBeNull();
    expect(decodeRendererReport({ ...VALID, loop: { p50: 0, p99: 0, max: 'slow' } })).toBeNull();
  });

  it('keeps the good spans and drops the bad ones', () => {
    // One malformed span must not cost the window its loop figures — those are
    // the numbers the whole renderer instrument exists for.
    const decoded = decodeRendererReport({
      ...VALID,
      spans: {
        demoteSerialize: { ms: 300, n: 1 },
        broken: { ms: Number.NaN, n: 1 },
        alsoBroken: 'not a span',
      },
    });
    expect(decoded?.spans).toEqual({ demoteSerialize: { ms: 300, n: 1 } });
    expect(decoded?.loop).toEqual(VALID.loop);
  });

  it('drops an entirely malformed span map rather than failing the report', () => {
    const decoded = decodeRendererReport({ ...VALID, spans: 'nope', counts: { demotes: -3 } });
    expect(decoded).not.toBeNull();
    expect(decoded?.spans).toBeUndefined();
    expect(decoded?.counts).toBeUndefined();
  });

  it('keeps counts that are finite and non-negative', () => {
    const decoded = decodeRendererReport({ ...VALID, counts: { demotes: 3, promotes: 0 } });
    expect(decoded?.counts).toEqual({ demotes: 3, promotes: 0 });
  });
});
