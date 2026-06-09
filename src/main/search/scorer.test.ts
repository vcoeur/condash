import { describe, expect, it } from 'vitest';
import type { SearchTerm } from '../../shared/types';
import { scoreOccurrences, type ScorerOccurrence } from './scorer';

const token = (index: number, phrase = false): SearchTerm => ({
  value: `t${index}`,
  phrase,
  index,
});

const occ = (
  tokenIndex: number,
  offset: number,
  region: ScorerOccurrence['region'] = 'body',
): ScorerOccurrence => ({ tokenIndex, offset, region });

describe('scoreOccurrences', () => {
  it('pins the region weights', () => {
    expect(scoreOccurrences([occ(0, 0, 'h1')], [token(0)])).toBe(20);
    expect(scoreOccurrences([occ(0, 0, 'meta')], [token(0)])).toBe(15);
    expect(scoreOccurrences([occ(0, 0, 'heading')], [token(0)])).toBe(5);
    expect(scoreOccurrences([occ(0, 0, 'path')], [token(0)])).toBe(5);
    expect(scoreOccurrences([occ(0, 0, 'body')], [token(0)])).toBe(1);
  });

  it('adds the phrase bonus for a matched phrase term', () => {
    expect(scoreOccurrences([occ(0, 0)], [token(0, true)])).toBe(6);
  });

  it('adds the adjacency bonus when two tokens sit within the radius', () => {
    expect(scoreOccurrences([occ(0, 0), occ(1, 30)], [token(0), token(1)])).toBe(12);
  });

  it('gives no adjacency bonus beyond the radius', () => {
    expect(scoreOccurrences([occ(0, 0), occ(1, 31)], [token(0), token(1)])).toBe(2);
  });

  it('finds an adjacent pair deep in the ascending offset lists', () => {
    const occurrences = [
      ...[0, 200, 400, 1000].map((offset) => occ(0, offset)),
      ...[500, 990].map((offset) => occ(1, offset)),
    ];
    // |1000 − 990| = 10 ≤ 30 → bonus; 6 body occurrences + 10.
    expect(scoreOccurrences(occurrences, [token(0), token(1)])).toBe(16);
  });

  it('applies the adjacency bonus at most once for three close tokens', () => {
    const occurrences = [occ(0, 0), occ(1, 5), occ(2, 10)];
    // 3 body occurrences + one bonus.
    expect(scoreOccurrences(occurrences, [token(0), token(1), token(2)])).toBe(13);
  });

  it('ignores path occurrences for adjacency', () => {
    // body(1) + path(5), tokens adjacent by offset but path is excluded.
    expect(scoreOccurrences([occ(0, 0), occ(1, 5, 'path')], [token(0), token(1)])).toBe(6);
  });
});
