import { describe, expect, it } from 'vitest';
import { decideFit, MAX_FIT_ATTEMPTS, type ProposedDimensions } from './fit-when-ready';

describe('decideFit', () => {
  it('fits once proposeDimensions returns a finite grid', () => {
    expect(decideFit({ cols: 200, rows: 50 }, MAX_FIT_ATTEMPTS)).toBe('fit');
    // A ready measurement fits even on the very last attempt.
    expect(decideFit({ cols: 80, rows: 24 }, 0)).toBe('fit');
  });

  it('retries while proposeDimensions cannot compute and attempts remain', () => {
    // undefined = char cell still 0 (host was display:none at open) or no
    // laid-out parent yet: the exact race this loop exists to survive.
    expect(decideFit(undefined, MAX_FIT_ATTEMPTS)).toBe('retry');
    expect(decideFit(undefined, 1)).toBe('retry');
  });

  it('gives up when it still cannot compute and no attempts remain', () => {
    expect(decideFit(undefined, 0)).toBe('giveup');
  });

  it('treats a NaN/Infinity axis as not-ready (retry, then give up)', () => {
    const nanCols: ProposedDimensions = { cols: NaN, rows: 24 };
    const infRows: ProposedDimensions = { cols: 80, rows: Infinity };
    expect(decideFit(nanCols, 3)).toBe('retry');
    expect(decideFit(nanCols, 0)).toBe('giveup');
    expect(decideFit(infRows, 3)).toBe('retry');
  });
});
