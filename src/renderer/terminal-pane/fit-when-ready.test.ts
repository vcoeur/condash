import { describe, expect, it } from 'vitest';
import { decideFit, MAX_FIT_ATTEMPTS, type ProposedDimensions } from './fit-when-ready';
import { decideRefreshAction } from './nudge-machine';

/** A host laid out at a real size (the steady state). */
const laidOut = { width: 1200, height: 400 };

describe('decideFit', () => {
  it('fits once a laid-out host proposes a real grid', () => {
    expect(decideFit({ cols: 200, rows: 50 }, MAX_FIT_ATTEMPTS, laidOut)).toBe('fit');
    // A ready measurement fits even on the very last attempt.
    expect(decideFit({ cols: 80, rows: 24 }, 0, laidOut)).toBe('fit');
  });

  it('retries while proposeDimensions cannot compute and attempts remain', () => {
    // undefined = char cell still 0 (host was display:none at open) or no
    // laid-out parent yet: the exact race this loop exists to survive.
    expect(decideFit(undefined, MAX_FIT_ATTEMPTS, laidOut)).toBe('retry');
    expect(decideFit(undefined, 1, laidOut)).toBe('retry');
  });

  it('gives up when it still cannot compute and no attempts remain', () => {
    expect(decideFit(undefined, 0, laidOut)).toBe('giveup');
  });

  it('treats a NaN/Infinity axis as not-ready (retry, then give up)', () => {
    const nanCols: ProposedDimensions = { cols: NaN, rows: 24 };
    const infRows: ProposedDimensions = { cols: 80, rows: Infinity };
    expect(decideFit(nanCols, 3, laidOut)).toBe('retry');
    expect(decideFit(nanCols, 0, laidOut)).toBe('giveup');
    expect(decideFit(infRows, 3, laidOut)).toBe('retry');
  });

  it('rejects the clamp floor a rendered zero-height host proposes', () => {
    // `proposeDimensions` clamps instead of failing, so a host that is rendered
    // (not display:none, so no NaN) but zero-height returns this finite pair.
    // Accepting it committed `term.resize(2, 1)` to the pty.
    const clampFloor: ProposedDimensions = { cols: 2, rows: 1 };
    expect(decideFit(clampFloor, MAX_FIT_ATTEMPTS, { width: 1200, height: 0 })).toBe('retry');
    expect(decideFit(clampFloor, 0, { width: 1200, height: 0 })).toBe('giveup');
  });

  it('rejects a zero-height host even when the proposal looks plausible', () => {
    // Belt to the grid floor's braces: the host box is the direct evidence, so a
    // stale/optimistic proposal cannot smuggle a fit past an unlaid-out host.
    expect(decideFit({ cols: 200, rows: 50 }, MAX_FIT_ATTEMPTS, { width: 1200, height: 0 })).toBe(
      'retry',
    );
    expect(decideFit({ cols: 200, rows: 50 }, MAX_FIT_ATTEMPTS, { width: 0, height: 400 })).toBe(
      'retry',
    );
    expect(decideFit({ cols: 200, rows: 50 }, MAX_FIT_ATTEMPTS, undefined)).toBe('retry');
  });

  it('rejects the clamp floor on a host with a non-zero but sub-cell box', () => {
    // A host a few px tall measures non-zero yet leaves no room for a cell once
    // its padding is removed — the grid floor is what catches this one.
    expect(decideFit({ cols: 2, rows: 1 }, MAX_FIT_ATTEMPTS, { width: 20, height: 6 })).toBe(
      'retry',
    );
  });

  it('fits a genuinely small — but usable — grid', () => {
    // The floor rejects 2×1 only; one cell above it is a real measurement.
    expect(decideFit({ cols: 3, rows: 2 }, MAX_FIT_ATTEMPTS, { width: 40, height: 40 })).toBe(
      'fit',
    );
  });
});

describe('the zero-height trap (property)', () => {
  it('a zero-height host never disables its own repaint', () => {
    // The defect this fix closes, asserted end to end over the two pure
    // decisions: a rendered zero-height host proposes the clamp floor; accepting
    // it left the terminal at rows = 1, which `decideRefreshAction` then skips as
    // `tooShort` — the bad geometry suppressed the nudge that would have
    // recovered it. Rejecting the fit leaves the grid at its 80×24 default, so
    // the repaint still runs and the ResizeObserver can refit once the host
    // settles.
    const zeroHeightHost = { width: 1200, height: 0 };
    const clampFloor: ProposedDimensions = { cols: 2, rows: 1 };
    expect(decideFit(clampFloor, MAX_FIT_ATTEMPTS, zeroHeightHost)).not.toBe('fit');

    const rowsAfterRejectedFit = 24; // the constructor default, left untouched
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'alternate',
        rows: rowsAfterRejectedFit,
        onlyIfAltBuffer: false,
      }),
    ).toEqual({ kind: 'nudge' });
  });
});
