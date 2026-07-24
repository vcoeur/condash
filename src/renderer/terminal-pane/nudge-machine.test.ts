import { describe, expect, it } from 'vitest';
import {
  createNudgeRegistry,
  decideRefreshAction,
  REPAINT_NUDGE_MS,
  refreshOnSwitchTargets,
  type ActiveByColumn,
  type RefreshAction,
} from './nudge-machine';
import { activeIdsAfterDrop } from './visibility-plan';

const ids = (left: string | null, right: string | null): ActiveByColumn => ({ left, right });

describe('refreshOnSwitchTargets', () => {
  it('fires on a genuine switch to a different tab in a column', () => {
    const targets = refreshOnSwitchTargets(ids('a', null), ids('b', null), true);
    expect(targets).toEqual([{ id: 'b', onlyIfAltBuffer: false }]);
  });

  it('fires on a column first activation (previous null)', () => {
    // A restored-on-boot tab, the first spawn into a column, and the tab
    // promoted after a close all arrive with `previous === null`. Each hydrates
    // from a snapshot exactly like a switched-to tab, so each needs the repaint;
    // skipping them was why "the first tab I land on looks wrong until I hit
    // Refresh".
    expect(refreshOnSwitchTargets(ids(null, null), ids('a', null), true)).toEqual([
      { id: 'a', onlyIfAltBuffer: false },
    ]);
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
});

describe('REPAINT_NUDGE_MS', () => {
  it('outlasts a Bubbletea-class resize debounce (~100 ms), or the nudge no-ops', () => {
    expect(REPAINT_NUDGE_MS).toBeGreaterThan(100);
  });
});

describe('createNudgeRegistry', () => {
  // Stand-ins for two DOM Terminals of the SAME session: a switch away and back
  // destroys the first and builds the second.
  const oldHandle = { name: 'old' };
  const newHandle = { name: 'new' };

  it('holds only the handle that claimed it', () => {
    const registry = createNudgeRegistry<object>();
    registry.claim('a', oldHandle);
    expect(registry.isHeldBy('a', oldHandle)).toBe(true);
    expect(registry.isHeldBy('a', newHandle)).toBe(false);
    expect(registry.isHeldBy('b', oldHandle)).toBe(false);
  });

  it("a stale handle's claim does not block the replacement handle's fit", () => {
    // Switch A→B (nudge claims B's handle), switch away inside the hold (the
    // handle is disposed), switch back (a NEW handle). Keyed by id alone, the
    // stale claim made the promote's fit a no-op and the new terminal was never
    // fitted — "rapid switching leaves a small terminal".
    const registry = createNudgeRegistry<object>();
    registry.claim('b', oldHandle);
    expect(registry.isHeldBy('b', newHandle)).toBe(false);
  });

  it("a stale timer's release does not clear a live nudge's guard", () => {
    // The disposed handle's timer fires after the new handle has claimed its own
    // nudge. Keyed by id alone it deleted the entry, and the next chained fit
    // restored the full size and collapsed the live dip before the TUI sampled
    // it — the exact failure the guard exists to prevent.
    const registry = createNudgeRegistry<object>();
    registry.claim('b', oldHandle);
    registry.claim('b', newHandle);
    registry.release('b', oldHandle);
    expect(registry.isHeldBy('b', newHandle)).toBe(true);
    registry.release('b', newHandle);
    expect(registry.isHeldBy('b', newHandle)).toBe(false);
  });
});

describe('closing the active tab (property)', () => {
  it('the tab that takes over gets a repaint target', () => {
    // The top repro candidate, asserted over the two pure decisions the
    // controller composes: closing the active tab — or an agent's clean exit
    // auto-closing its own — must leave the promoted neighbour with a nudge, or
    // it hydrates garbled and only manual Refresh fixes it.
    const tabs = [
      { id: 'a', column: 'left' as const },
      { id: 'b', column: 'left' as const },
    ];
    const before = ids('b', null);
    const after = activeIdsAfterDrop(before, tabs, new Set(['b']));

    expect(after).toEqual(ids('a', null));
    expect(refreshOnSwitchTargets(before, after, undefined)).toEqual([
      { id: 'a', onlyIfAltBuffer: false },
    ]);
  });

  it('one write, one target — the split write produced a targetless step', () => {
    // Why the write has to be atomic. Publishing `{left: null}` and the fallback
    // as two writes makes the detector run twice: the first step is targetless
    // (no active tab at all) and the second is the one that used to be dropped
    // for having a null predecessor. Every observer of the signal — not just the
    // nudge — sees that phantom "no active tab" state in between.
    const before = ids('b', null);
    const intermediate = ids(null, null);
    expect(refreshOnSwitchTargets(before, intermediate, undefined)).toEqual([]);
    expect(activeIdsAfterDrop(before, [{ id: 'a', column: 'left' }], new Set(['b']))).not.toEqual(
      intermediate,
    );
  });
});
