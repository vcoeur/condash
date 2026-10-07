/**
 * Descriptive statistics for the terminal-acceptance harness — pure math, no
 * imports, so the same numbers can be recomputed anywhere (spec, record file,
 * review) without dragging a dependency in.
 *
 * The harness reports median / IQR / range / n as the decision statistics and
 * p95 as a flagged descriptive only (the parent's correlation rule: counts
 * within a run are correlated, so tail percentiles of small populations
 * overstate certainty). Every function here is total over non-empty arrays and
 * throws on empty input — a distribution that cannot exist must fail loudly,
 * never read as zeros.
 */

export interface SampleSummary {
  /** Sample count — reported alongside every distribution, never implied. */
  n: number;
  median: number;
  /** Interquartile range as the [q25, q75] pair (Tukey hinges on the sorted
   *  sample; for n < 4 this equals [min, max]). */
  iqrLow: number;
  iqrHigh: number;
  min: number;
  max: number;
  /** 95th percentile, descriptive only — never a gate. */
  p95: number;
}

function sorted(samples: number[]): number[] {
  if (samples.length === 0) throw new Error('acceptance-stats: empty sample');
  return [...samples].sort((a, b) => a - b);
}

/** Nearest-rank percentile on a pre-sorted array (rank = ceil(p/100 × n)). */
function percentile(sortedSamples: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sortedSamples.length));
  return sortedSamples[rank - 1];
}

export function summarize(samples: number[]): SampleSummary {
  const s = sorted(samples);
  const half = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? s[half] : (s[half - 1] + s[half]) / 2;
  const qRank = Math.max(1, Math.ceil(0.25 * s.length));
  const q3Rank = Math.max(1, Math.ceil(0.75 * s.length));
  return {
    n: s.length,
    median,
    iqrLow: s[qRank - 1],
    iqrHigh: s[q3Rank - 1],
    min: s[0],
    max: s[s.length - 1],
    p95: percentile(s, 95),
  };
}

/** Pool several runs' samples into one distribution (per-run spread is kept in
 *  the record; pooling never discards it — the caller reports both). */
export function pooled(runs: number[][]): SampleSummary {
  return summarize(runs.flat());
}
