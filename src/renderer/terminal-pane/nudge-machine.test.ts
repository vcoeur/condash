import { describe, expect, it } from 'vitest';
import {
  decideRefreshAction,
  REPAINT_NUDGE_MS,
  refreshOnSwitchTargets,
  type ActiveByColumn,
  type RefreshAction,
} from './nudge-machine';

const ids = (left: string | null, right: string | null): ActiveByColumn => ({ left, right });

describe('refreshOnSwitchTargets', () => {
  it('fires on a genuine switch to a different tab in a column', () => {
    const targets = refreshOnSwitchTargets(ids('a', null), ids('b', null), true);
    expect(targets).toEqual([{ id: 'b', onlyIfAltBuffer: false }]);
  });

  it('skips first-open (previous null) so a freshly-mounted tab is not nudged', () => {
    expect(refreshOnSwitchTargets(ids(null, null), ids('a', null), true)).toEqual([]);
  });

  it('ignores a no-op re-assert of the same id — a visibility flip racing the nudge', () => {
    // The active-id signal re-fires with an unchanged value (e.g. a promote
    // re-asserting the active tab); previous === next must produce no target.
    expect(refreshOnSwitchTargets(ids('a', null), ids('a', null), true)).toEqual([]);
  });

  it('fires per column independently', () => {
    const targets = refreshOnSwitchTargets(ids('a', 'x'), ids('b', 'y'), true);
    expect(targets).toEqual([
      { id: 'b', onlyIfAltBuffer: false },
      { id: 'y', onlyIfAltBuffer: false },
    ]);
  });

  it('only the column that actually switched yields a target', () => {
    const targets = refreshOnSwitchTargets(ids('a', 'x'), ids('a', 'y'), true);
    expect(targets).toEqual([{ id: 'y', onlyIfAltBuffer: false }]);
  });

  it('does not fire when a tab is closed (next null)', () => {
    expect(refreshOnSwitchTargets(ids('a', null), ids(null, null), true)).toEqual([]);
  });

  it('default (undefined) nudges unconditionally — onlyIfAltBuffer false', () => {
    expect(refreshOnSwitchTargets(ids('a', null), ids('b', null), undefined)).toEqual([
      { id: 'b', onlyIfAltBuffer: false },
    ]);
  });

  it('autoRefreshOnTabSwitch false restricts each target to alt-buffer tabs', () => {
    expect(refreshOnSwitchTargets(ids('a', null), ids('b', null), false)).toEqual([
      { id: 'b', onlyIfAltBuffer: true },
    ]);
  });
});

describe('decideRefreshAction', () => {
  it('skips when no live terminal exists (tab closed / demoted mid-hydration)', () => {
    const action: RefreshAction = decideRefreshAction({ mounted: false, onlyIfAltBuffer: false });
    expect(action).toEqual({ kind: 'skip' });
  });

  it('nudges a normal-buffer shell when the alt-buffer gate is off', () => {
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'normal',
        rows: 24,
        onlyIfAltBuffer: false,
      }),
    ).toEqual({ kind: 'nudge' });
  });

  it('focus-only (altGate) for a normal-buffer tab under the alt-buffer opt-out', () => {
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'normal',
        rows: 24,
        onlyIfAltBuffer: true,
      }),
    ).toEqual({ kind: 'focus-only', reason: 'altGate' });
  });

  it('nudges an alt-buffer TUI even under the alt-buffer opt-out', () => {
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'alternate',
        rows: 24,
        onlyIfAltBuffer: true,
      }),
    ).toEqual({ kind: 'nudge' });
  });

  it('focus-only (tooShort) for a ≤1-row terminal, which cannot give up a row', () => {
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'normal',
        rows: 1,
        onlyIfAltBuffer: false,
      }),
    ).toEqual({ kind: 'focus-only', reason: 'tooShort' });
  });

  it('treats a missing row count as too short (fails safe to focus-only)', () => {
    expect(
      decideRefreshAction({ mounted: true, bufferType: 'alternate', onlyIfAltBuffer: false }),
    ).toEqual({ kind: 'focus-only', reason: 'tooShort' });
  });

  it('the alt-buffer gate is checked before the row count', () => {
    // A short normal-buffer tab under the opt-out reports altGate, not tooShort —
    // it never reaches the row check (matches the controller's ordering).
    expect(
      decideRefreshAction({ mounted: true, bufferType: 'normal', rows: 1, onlyIfAltBuffer: true }),
    ).toEqual({ kind: 'focus-only', reason: 'altGate' });
  });

  it('stands down on an exact frame, because the nudge would shear its bottom row', () => {
    // The nudge shrinks a row and grows it back; on the alternate buffer xterm
    // pops the bottom line and pushes a blank one, so nudging a frame that is
    // already the pty's screen can only damage it.
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'alternate',
        rows: 24,
        onlyIfAltBuffer: false,
        frameIsExact: true,
        allowExactSkip: true,
      }),
    ).toEqual({ kind: 'focus-only', reason: 'frameExact' });
  });

  it('still nudges an exact frame for a caller that may not skip (manual Refresh)', () => {
    // The user pressing Refresh is the signal that the screen is wrong, whatever
    // the geometry bookkeeping says.
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'alternate',
        rows: 24,
        onlyIfAltBuffer: false,
        frameIsExact: true,
      }),
    ).toEqual({ kind: 'nudge' });
  });

  it('nudges when the frame is not known to be exact', () => {
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'alternate',
        rows: 24,
        onlyIfAltBuffer: false,
        frameIsExact: false,
        allowExactSkip: true,
      }),
    ).toEqual({ kind: 'nudge' });
  });

  it('the alt-buffer gate is still checked before the exact-frame gate', () => {
    expect(
      decideRefreshAction({
        mounted: true,
        bufferType: 'normal',
        rows: 24,
        onlyIfAltBuffer: true,
        frameIsExact: true,
        allowExactSkip: true,
      }),
    ).toEqual({ kind: 'focus-only', reason: 'altGate' });
  });
});

describe('REPAINT_NUDGE_MS', () => {
  it('outlasts a Bubbletea-class resize debounce (~100 ms), or the nudge no-ops', () => {
    expect(REPAINT_NUDGE_MS).toBeGreaterThan(100);
  });
});
