import { describe, expect, it } from 'vitest';
import { isLowQualityTag, filterTags } from './index-tag-filter';

describe('isLowQualityTag', () => {
  it('rejects tags shorter than 3 characters', () => {
    expect(isLowQualityTag('a')).toBe(true);
    expect(isLowQualityTag('ab')).toBe(true);
    expect(isLowQualityTag('ci')).toBe(true);
    expect(isLowQualityTag('abc')).toBe(false);
  });

  it('rejects tags longer than 40 characters', () => {
    expect(isLowQualityTag('a'.repeat(40))).toBe(false);
    expect(isLowQualityTag('a'.repeat(41))).toBe(true);
  });

  it('rejects pure-numeric tags', () => {
    expect(isLowQualityTag('42')).toBe(true);
    expect(isLowQualityTag('2026')).toBe(true);
    expect(isLowQualityTag('v2')).toBe(true); // length 2 → also rejected by length rule
    expect(isLowQualityTag('2026q1')).toBe(false); // mixed alphanumeric is fine
  });

  it('rejects ISO-date-shaped tags', () => {
    expect(isLowQualityTag('2026-04')).toBe(true);
    expect(isLowQualityTag('2026-04-17')).toBe(true);
    expect(isLowQualityTag('2026-4-17')).toBe(false); // not ISO; treat as content
    expect(isLowQualityTag('q1-2026')).toBe(false);
  });

  it('rejects UUID-shaped tags (with and without dashes)', () => {
    expect(isLowQualityTag('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
    expect(isLowQualityTag('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
    expect(isLowQualityTag('aaaaaaaabbbbccccddddeeeeeeeeeeee')).toBe(true);
    expect(isLowQualityTag('not-a-uuid-just-words')).toBe(false);
  });

  it('rejects English stop-words and common content-free verbs', () => {
    for (const w of [
      'the',
      'and',
      'for',
      'with',
      'this',
      'that',
      'observation',
      'develop',
      'configure',
      'summary',
      'overview',
    ]) {
      expect(isLowQualityTag(w)).toBe(true);
    }
  });

  it('passes through legit hyphenated content tags', () => {
    for (const w of [
      'sandbox-testing',
      'caddy-access-log',
      'port-range-11111',
      'condash',
      'playwright',
      'electron-builder',
      'pii-stripping',
    ]) {
      expect(isLowQualityTag(w)).toBe(false);
    }
  });

  it('is case-insensitive on stop-words but tag identity is preserved by callers', () => {
    expect(isLowQualityTag('THE')).toBe(true);
    expect(isLowQualityTag('The')).toBe(true);
  });
});

describe('filterTags', () => {
  it('removes low-quality tags and preserves order + dedupes by exact-match', () => {
    const input = [
      'sandbox-testing',
      'the',
      'sandbox-testing', // dup
      '2026-04',
      'condash',
      'a',
      'caddy-access-log',
    ];
    expect(filterTags(input)).toEqual(['sandbox-testing', 'condash', 'caddy-access-log']);
  });

  it('returns an empty list when every tag is junk', () => {
    expect(filterTags(['the', 'and', '42', '2026-04'])).toEqual([]);
  });
});
