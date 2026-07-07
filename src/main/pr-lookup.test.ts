/**
 * Unit tests for the pure `gh pr list` JSON parser. The `lookupPullRequest`
 * shell-out isn't exercised here — it needs a live, authenticated `gh` and a
 * real GitHub repo — so, as with git-details' pure parsers, only the parsing
 * / field-mapping is covered.
 */
import { describe, expect, it } from 'vitest';
import { parseGhPrList } from './pr-lookup';

describe('parseGhPrList', () => {
  it('maps the first PR of a populated list', () => {
    const out = JSON.stringify([
      {
        number: 412,
        url: 'https://github.com/vcoeur/condash/pull/412',
        title: 'Add Open PR menu item',
        isDraft: false,
      },
    ]);
    expect(parseGhPrList(out)).toEqual({
      number: 412,
      url: 'https://github.com/vcoeur/condash/pull/412',
      title: 'Add Open PR menu item',
      isDraft: false,
    });
  });

  it('carries the draft flag through', () => {
    const out = JSON.stringify([
      { number: 5, url: 'https://example.com/pull/5', title: 'wip', isDraft: true },
    ]);
    expect(parseGhPrList(out)?.isDraft).toBe(true);
  });

  it('returns the first entry when the list has several', () => {
    const out = JSON.stringify([
      { number: 1, url: 'https://example.com/pull/1', title: 'first', isDraft: false },
      { number: 2, url: 'https://example.com/pull/2', title: 'second', isDraft: false },
    ]);
    expect(parseGhPrList(out)?.number).toBe(1);
  });

  it('defaults a missing title to an empty string', () => {
    const out = JSON.stringify([{ number: 7, url: 'https://example.com/pull/7', isDraft: false }]);
    expect(parseGhPrList(out)).toEqual({
      number: 7,
      url: 'https://example.com/pull/7',
      title: '',
      isDraft: false,
    });
  });

  it('treats a missing isDraft as not-draft', () => {
    const out = JSON.stringify([{ number: 8, url: 'https://example.com/pull/8', title: 'x' }]);
    expect(parseGhPrList(out)?.isDraft).toBe(false);
  });

  it('returns null for an empty list (no open PR)', () => {
    expect(parseGhPrList('[]')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseGhPrList('not json')).toBeNull();
    expect(parseGhPrList('')).toBeNull();
  });

  it('returns null when the payload is not an array', () => {
    expect(parseGhPrList('{"number":1}')).toBeNull();
  });

  it('returns null when required fields are missing or wrong-typed', () => {
    // No number.
    expect(parseGhPrList(JSON.stringify([{ url: 'https://example.com/pull/1' }]))).toBeNull();
    // No url.
    expect(parseGhPrList(JSON.stringify([{ number: 1 }]))).toBeNull();
    // Empty url.
    expect(parseGhPrList(JSON.stringify([{ number: 1, url: '' }]))).toBeNull();
    // number as a string.
    expect(parseGhPrList(JSON.stringify([{ number: '1', url: 'https://x/pull/1' }]))).toBeNull();
  });
});
