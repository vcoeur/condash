/**
 * The live-xterm registry's two re-theme entry points.
 *
 * `scheduleXtermThemeRefresh` is what stops the Settings theme picker from
 * re-theming every open terminal on each arrow-key repeat — the coalescing is
 * the whole point, so it is asserted by call count, not just by "it eventually
 * ran".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  liveTerms,
  refreshAllXtermThemes,
  type RefreshableXterm,
  scheduleXtermThemeRefresh,
} from './xterm-registry';

/** A term that only counts how often it was asked to re-read its theme. */
function countingTerm(): RefreshableXterm & { calls: number } {
  return {
    calls: 0,
    refreshTheme() {
      this.calls += 1;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  liveTerms.clear();
});

afterEach(() => {
  // Drain any timer this test scheduled so it can't fire inside the next one.
  vi.runAllTimers();
  vi.useRealTimers();
  liveTerms.clear();
});

describe('refreshAllXtermThemes', () => {
  it('refreshes every registered term immediately', () => {
    const first = countingTerm();
    const second = countingTerm();
    liveTerms.add(first);
    liveTerms.add(second);

    refreshAllXtermThemes();

    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it('keeps going when one term throws', () => {
    const healthy = countingTerm();
    liveTerms.add({
      refreshTheme() {
        throw new Error('disposed mid-flip');
      },
    });
    liveTerms.add(healthy);

    expect(() => refreshAllXtermThemes()).not.toThrow();
    expect(healthy.calls).toBe(1);
  });
});

describe('scheduleXtermThemeRefresh', () => {
  it('collapses a burst of selections into one refresh', () => {
    const term = countingTerm();
    liveTerms.add(term);

    // Six cards' worth of ArrowRight, at a key-repeat cadence well inside the
    // coalescing window. Before the fix this was six full per-terminal passes.
    for (let i = 0; i < 6; i += 1) {
      scheduleXtermThemeRefresh();
      vi.advanceTimersByTime(30);
    }
    expect(term.calls).toBe(0);

    vi.runAllTimers();
    expect(term.calls).toBe(1);
  });

  it('still refreshes — the settled selection is never dropped', () => {
    const term = countingTerm();
    liveTerms.add(term);

    scheduleXtermThemeRefresh();
    vi.runAllTimers();

    expect(term.calls).toBe(1);
  });

  it('refreshes again for a selection made after the window closed', () => {
    const term = countingTerm();
    liveTerms.add(term);

    scheduleXtermThemeRefresh();
    vi.runAllTimers();
    scheduleXtermThemeRefresh();
    vi.runAllTimers();

    expect(term.calls).toBe(2);
  });

  it('picks up a terminal opened while the window was still running down', () => {
    const early = countingTerm();
    liveTerms.add(early);
    scheduleXtermThemeRefresh();

    const late = countingTerm();
    liveTerms.add(late);
    vi.runAllTimers();

    expect(early.calls).toBe(1);
    expect(late.calls).toBe(1);
  });
});
