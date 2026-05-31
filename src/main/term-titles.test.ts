import { describe, expect, it } from 'vitest';
import { TITLE_MAX_LEN, validateTermTitles } from './term-titles';

describe('validateTermTitles', () => {
  it('parses a good sparse file into {sid,title}', () => {
    const raw = JSON.stringify({
      titles: [
        { sid: 't-a1', title: 'fixing logs CLI', summary: 'long sentence', lineCount: 482 },
        { sid: 't-b2', title: 'running tests' },
      ],
    });
    expect(validateTermTitles(raw)).toEqual([
      { sid: 't-a1', title: 'fixing logs CLI' },
      { sid: 't-b2', title: 'running tests' },
    ]);
  });

  it('returns [] for malformed JSON', () => {
    expect(validateTermTitles('{ not json')).toEqual([]);
  });

  it('returns [] for the wrong shape (no titles array)', () => {
    expect(validateTermTitles(JSON.stringify({ foo: 1 }))).toEqual([]);
    expect(validateTermTitles(JSON.stringify({ titles: 'nope' }))).toEqual([]);
  });

  it('returns [] for an entry missing sid or with a non-string title', () => {
    expect(validateTermTitles(JSON.stringify({ titles: [{ title: 'x' }] }))).toEqual([]);
    expect(validateTermTitles(JSON.stringify({ titles: [{ sid: 't-a', title: 5 }] }))).toEqual([]);
  });

  it('clamps an over-long title and collapses whitespace', () => {
    const long = 'a'.repeat(100);
    const [entry] = validateTermTitles(JSON.stringify({ titles: [{ sid: 't-a', title: long }] }));
    expect(entry.title.length).toBe(TITLE_MAX_LEN);
    expect(entry.title.endsWith('…')).toBe(true);

    const [ws] = validateTermTitles(
      JSON.stringify({ titles: [{ sid: 't-a', title: '  fixing   logs\n CLI ' }] }),
    );
    expect(ws.title).toBe('fixing logs CLI');
  });

  it('drops entries that clamp to an empty title (never blanks a tab)', () => {
    expect(validateTermTitles(JSON.stringify({ titles: [{ sid: 't-a', title: '   ' }] }))).toEqual(
      [],
    );
  });

  it('keeps the first of duplicate sids', () => {
    const raw = JSON.stringify({
      titles: [
        { sid: 't-a', title: 'first' },
        { sid: 't-a', title: 'second' },
      ],
    });
    expect(validateTermTitles(raw)).toEqual([{ sid: 't-a', title: 'first' }]);
  });
});
