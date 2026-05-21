/**
 * Tests for the `knowledge-recheck` audit check — the balanced-bracket
 * matching of `[knowledge-recheck:pending]` against later
 * `[knowledge-recheck:done]` timeline markers.
 */
import { describe, expect, it } from 'vitest';
import { unresolvedRechecks } from './knowledge-recheck';

/** Build a timeline entry whose text carries the given marker token. */
function entry(
  date: string,
  marker: 'pending' | 'done' | 'none',
  label = '',
): {
  date: string;
  text: string;
} {
  const token =
    marker === 'pending'
      ? '[knowledge-recheck:pending]'
      : marker === 'done'
        ? '[knowledge-recheck:done]'
        : '';
  return { date, text: `${token} ${label}`.trim() };
}

describe('unresolvedRechecks', () => {
  it('returns nothing when there are no markers', () => {
    expect(
      unresolvedRechecks([
        entry('2026-05-22', 'none', 'Project created'),
        entry('2026-05-23', 'none', 'PR opened'),
      ]),
    ).toEqual([]);
  });

  it('flags a lone pending marker', () => {
    const open = unresolvedRechecks([entry('2026-05-22', 'pending', 'fact A')]);
    expect(open).toHaveLength(1);
    expect(open[0].date).toBe('2026-05-22');
    expect(open[0].text).toContain('fact A');
  });

  it('clears a pending matched by a later done', () => {
    expect(
      unresolvedRechecks([
        entry('2026-05-22', 'pending', 'fact A'),
        entry('2026-06-01', 'done', 'promoted'),
      ]),
    ).toEqual([]);
  });

  it('re-deferral (pending → done → pending) leaves the latest pending open', () => {
    const open = unresolvedRechecks([
      entry('2026-05-22', 'pending', 'fact A'),
      entry('2026-06-01', 'done', 'promoted'),
      entry('2026-06-10', 'pending', 'fact A again'),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0].date).toBe('2026-06-10');
  });

  it('two concurrent pendings, one closed, leaves one open', () => {
    const open = unresolvedRechecks([
      entry('2026-05-22', 'pending', 'fact A'),
      entry('2026-05-23', 'pending', 'fact B'),
      entry('2026-06-01', 'done', 'resolved one'),
    ]);
    expect(open).toHaveLength(1);
  });

  it('balances multiple pairs to zero', () => {
    expect(
      unresolvedRechecks([
        entry('2026-05-22', 'pending', 'A'),
        entry('2026-05-23', 'pending', 'B'),
        entry('2026-06-01', 'done', 'B done'),
        entry('2026-06-02', 'done', 'A done'),
      ]),
    ).toEqual([]);
  });

  it('a stray done with nothing open is a no-op', () => {
    expect(unresolvedRechecks([entry('2026-06-01', 'done', 'orphan close')])).toEqual([]);
  });

  it('an old done followed by a new pending flags the new pending', () => {
    const open = unresolvedRechecks([
      entry('2026-05-01', 'done', 'old cycle close'),
      entry('2026-05-22', 'pending', 'new fact'),
    ]);
    expect(open).toHaveLength(1);
    expect(open[0].date).toBe('2026-05-22');
  });
});
