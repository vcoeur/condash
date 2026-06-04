import { describe, expect, it } from 'vitest';
import { compareByStatusThenSlug, countSteps, statusOrder } from './projects';
import { KNOWN_STATUSES, type Step } from './types';

describe('statusOrder', () => {
  it('agrees with KNOWN_STATUSES order', () => {
    const ordered = [...KNOWN_STATUSES].sort((a, b) => statusOrder(a) - statusOrder(b));
    expect(ordered).toEqual([...KNOWN_STATUSES]);
  });

  it('sorts unknown statuses last', () => {
    expect(statusOrder('doing')).toBeGreaterThanOrEqual(KNOWN_STATUSES.length);
    expect(statusOrder('whatever')).toBeGreaterThanOrEqual(KNOWN_STATUSES.length);
    const mixed = ['done', 'doing', 'now'];
    mixed.sort((a, b) => statusOrder(a) - statusOrder(b));
    // `now` first (canonical), `done` next, unknown `doing` last.
    expect(mixed).toEqual(['now', 'done', 'doing']);
  });
});

describe('compareByStatusThenSlug', () => {
  it('orders by status rank, then slug as the tie-break', () => {
    const rows = [
      { status: 'done', slug: 'zeta' },
      { status: 'now', slug: 'beta' },
      { status: 'now', slug: 'alpha' },
      { status: 'review', slug: 'gamma' },
    ];
    rows.sort(compareByStatusThenSlug);
    expect(rows.map((r) => `${r.status}:${r.slug}`)).toEqual([
      'now:alpha',
      'now:beta',
      'review:gamma',
      'done:zeta',
    ]);
  });
});

describe('countSteps section filtering', () => {
  function step(marker: Step['marker'], section: string, text = ''): Step {
    return { lineIndex: 0, marker, text, section };
  }

  it('counts only steps under ## Steps (case-insensitive)', () => {
    const steps: Step[] = [
      step(' ', 'Steps', 'a'),
      step('x', 'STEPS', 'b'),
      step(' ', 'Step details', 'c'),
      step(' ', 'Notes', 'd'),
    ];
    expect(countSteps(steps)).toEqual({ todo: 1, doing: 0, done: 1, blocked: 0, dropped: 0 });
  });

  it('tallies blocked separately', () => {
    const steps: Step[] = [
      step(' ', 'Steps'),
      step('~', 'Steps'),
      step('x', 'Steps'),
      step('!', 'Steps'),
      step('-', 'Steps'),
    ];
    expect(countSteps(steps)).toEqual({ todo: 1, doing: 1, done: 1, blocked: 1, dropped: 1 });
  });

  it('returns zeros when no Steps section exists', () => {
    const steps: Step[] = [step(' ', 'Notes'), step('x', 'Step details')];
    expect(countSteps(steps)).toEqual({ todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0 });
  });
});
