import { describe, expect, it } from 'vitest';
import {
  applyStarredSlug,
  compareByStatusThenSlug,
  countSteps,
  normaliseStarredSlugs,
  pruneStarredSlugs,
  shortSlug,
  statusOrder,
} from './projects';
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

describe('normaliseStarredSlugs', () => {
  it('dedupes, trims, and sorts', () => {
    expect(normaliseStarredSlugs([' b ', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('drops blanks and non-strings rather than throwing', () => {
    // The value comes off disk through a plain spread with no zod pass, so a
    // hand-edited config can carry anything.
    expect(normaliseStarredSlugs(['a', '', '   ', 3, null, { x: 1 }, ['b']])).toEqual(['a']);
  });

  it('treats any non-array as empty', () => {
    expect(normaliseStarredSlugs(undefined)).toEqual([]);
    expect(normaliseStarredSlugs('a,b')).toEqual([]);
    expect(normaliseStarredSlugs({ 0: 'a' })).toEqual([]);
  });
});

describe('applyStarredSlug', () => {
  it('adds a slug and keeps the list sorted', () => {
    expect(applyStarredSlug(['c', 'a'], 'b', true)).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent when starring an already-starred slug', () => {
    expect(applyStarredSlug(['a'], 'a', true)).toEqual(['a']);
  });

  it('removes a slug, and unstarring an absent one is a no-op', () => {
    expect(applyStarredSlug(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(applyStarredSlug(['b'], 'a', false)).toEqual(['b']);
  });

  it('normalises a corrupt current value before applying', () => {
    expect(applyStarredSlug('nonsense', 'a', true)).toEqual(['a']);
  });
});

describe('pruneStarredSlugs', () => {
  it('drops every done slug and keeps the rest sorted', () => {
    expect(pruneStarredSlugs(['c', 'a', 'b'], ['b'])).toEqual(['a', 'c']);
  });

  it('is a no-op when nothing starred is done', () => {
    expect(pruneStarredSlugs(['a', 'b'], ['c'])).toEqual(['a', 'b']);
    expect(pruneStarredSlugs(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('empties the list when every starred item is done', () => {
    expect(pruneStarredSlugs(['a', 'b'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('keeps a slug that resolves to no item — inert, not done', () => {
    // A deleted or renamed item is absent from the done list *and* from every
    // other status, so it must survive: pruning it here would be a guess.
    expect(pruneStarredSlugs(['2026-01-01-gone'], ['2026-02-02-closed'])).toEqual([
      '2026-01-01-gone',
    ]);
  });

  it('normalises a corrupt current value before pruning', () => {
    expect(pruneStarredSlugs([' a ', '', 7, 'b', 'a'], ['b'])).toEqual(['a']);
    expect(pruneStarredSlugs('nonsense', ['a'])).toEqual([]);
  });
});

describe('shortSlug', () => {
  it('drops the YYYY-MM-DD- prefix', () => {
    expect(shortSlug('2026-08-18-project-card-slug')).toBe('project-card-slug');
  });

  it('returns a slug with no date prefix unchanged', () => {
    expect(shortSlug('project-card-slug')).toBe('project-card-slug');
  });

  it('strips only the leading date, not a date inside the slug', () => {
    expect(shortSlug('2026-08-18-bump-2026-08-01-report')).toBe('bump-2026-08-01-report');
  });
});
