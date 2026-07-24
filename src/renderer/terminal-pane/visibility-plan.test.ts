import { describe, expect, it } from 'vitest';
import {
  activeIdsAfterDrop,
  desiredDomIds,
  domVisibility,
  planVisibility,
  shouldPromoteOnFocus,
  type MountedTab,
  type VisibilityPlan,
} from './visibility-plan';
import type { Column } from './types';

describe('desiredDomIds', () => {
  it('collects each column active id, left before right', () => {
    expect([...desiredDomIds({ left: 'a', right: 'b' })]).toEqual(['a', 'b']);
  });

  it('drops null columns', () => {
    expect([...desiredDomIds({ left: 'a', right: null })]).toEqual(['a']);
    expect([...desiredDomIds({ left: null, right: null })]).toEqual([]);
  });

  it('the same tab active in both columns collapses to one desired id', () => {
    expect([...desiredDomIds({ left: 'a', right: 'a' })]).toEqual(['a']);
  });
});

describe('planVisibility', () => {
  const empty: ReadonlySet<string> = new Set();

  it('promotes a desired tab that is not yet mounted', () => {
    const plan: VisibilityPlan = planVisibility({
      desired: ['a'],
      mounted: [],
      transitioning: empty,
    });
    expect(plan).toEqual({ toPromote: ['a'], toDemote: [] });
  });

  it('demotes a mounted tab that is no longer desired', () => {
    expect(planVisibility({ desired: [], mounted: ['a'], transitioning: empty })).toEqual({
      toPromote: [],
      toDemote: ['a'],
    });
  });

  it('leaves a desired-and-mounted tab alone', () => {
    expect(planVisibility({ desired: ['a'], mounted: ['a'], transitioning: empty })).toEqual({
      toPromote: [],
      toDemote: [],
    });
  });

  it('promotes the new active and demotes the old on a switch', () => {
    // Steady state: 'a' visible; user switches to 'b'.
    expect(planVisibility({ desired: ['b'], mounted: ['a'], transitioning: empty })).toEqual({
      toPromote: ['b'],
      toDemote: ['a'],
    });
  });

  it('never promotes a mid-transition tab (in-flight hydrate)', () => {
    expect(planVisibility({ desired: ['a'], mounted: [], transitioning: new Set(['a']) })).toEqual({
      toPromote: [],
      toDemote: [],
    });
  });

  it('never demotes a mid-transition tab (in-flight demote)', () => {
    expect(planVisibility({ desired: [], mounted: ['a'], transitioning: new Set(['a']) })).toEqual({
      toPromote: [],
      toDemote: [],
    });
  });

  it('preserves mount order for demotes and desired order for promotes', () => {
    const plan = planVisibility({
      desired: ['c', 'd'],
      mounted: ['a', 'b'],
      transitioning: empty,
    });
    expect(plan.toPromote).toEqual(['c', 'd']);
    expect(plan.toDemote).toEqual(['a', 'b']);
  });

  it('two-column split: each column keeps its own active, others demote', () => {
    // left active 'l2', right active 'r1'; 'l1' was left's old active.
    expect(
      planVisibility({
        desired: ['l2', 'r1'],
        mounted: ['l1', 'r1'],
        transitioning: empty,
      }),
    ).toEqual({ toPromote: ['l2'], toDemote: ['l1'] });
  });
});

describe('activeIdsAfterDrop', () => {
  const tab = (id: string, column: Column) => ({ id, column });

  it('promotes the last remaining tab of a column whose active tab closed', () => {
    expect(
      activeIdsAfterDrop({ left: 'b', right: null }, [tab('a', 'left')], new Set(['b'])),
    ).toEqual({ left: 'a', right: null });
  });

  it('leaves a column whose active tab survived untouched', () => {
    const previous = { left: 'a', right: 'x' };
    // 'b' (a background tab in the left column) closed: nothing moves, and the
    // identical object comes back so the signal does not even notify.
    expect(
      activeIdsAfterDrop(previous, [tab('a', 'left'), tab('x', 'right')], new Set(['b'])),
    ).toBe(previous);
  });

  it('nulls a column whose last tab closed', () => {
    expect(activeIdsAfterDrop({ left: 'a', right: null }, [], new Set(['a']))).toEqual({
      left: null,
      right: null,
    });
  });

  it('resolves both columns in the same value', () => {
    // The whole point: one value, so the controller can make one signal write
    // instead of publishing an intermediate state per column.
    expect(
      activeIdsAfterDrop(
        { left: 'a', right: 'x' },
        [tab('b', 'left'), tab('y', 'right')],
        new Set(['a', 'x']),
      ),
    ).toEqual({ left: 'b', right: 'y' });
  });

  it('adopts a fallback for a column that had no active tab', () => {
    // Preserves the controller's pre-existing behaviour: a column left with a
    // null active but live tabs adopts one.
    expect(
      activeIdsAfterDrop({ left: null, right: null }, [tab('a', 'left')], new Set(['b'])),
    ).toEqual({ left: 'a', right: null });
  });

  it('ignores dropped ids still present in the remaining list', () => {
    // The caller may pass the pre-filter tab list; a dropped tab must never be
    // chosen as the fallback.
    expect(
      activeIdsAfterDrop(
        { left: 'b', right: null },
        [tab('a', 'left'), tab('b', 'left')],
        new Set(['b']),
      ),
    ).toEqual({ left: 'a', right: null });
  });
});

describe('domVisibility', () => {
  const mounted = (...tabs: MountedTab[]): MountedTab[] => tabs;

  it('marks each column active tab visible, the rest hidden', () => {
    const vis = domVisibility(
      mounted(
        { id: 'a', column: 'left' },
        { id: 'b', column: 'left' },
        { id: 'c', column: 'right' },
      ),
      { left: 'a', right: 'c' },
    );
    expect(vis.get('a')).toBe(true);
    expect(vis.get('b')).toBe(false);
    expect(vis.get('c')).toBe(true);
  });

  it('a tab in a column whose active is another tab is hidden', () => {
    const vis = domVisibility(mounted({ id: 'a', column: 'left' }), { left: 'b', right: null });
    expect(vis.get('a')).toBe(false);
  });

  it('is empty when nothing is mounted', () => {
    expect(domVisibility([], { left: 'a', right: null }).size).toBe(0);
  });
});

describe('shouldPromoteOnFocus', () => {
  it('promotes when the column is idle (no in-flight transition)', () => {
    expect(shouldPromoteOnFocus(0)).toBe(true);
  });

  it('ignores focus churn while the column has an in-flight visibility transition', () => {
    expect(shouldPromoteOnFocus(1)).toBe(false);
    expect(shouldPromoteOnFocus(2)).toBe(false);
  });
});
