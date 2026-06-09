import { describe, expect, it } from 'vitest';
import { parseQuery } from './query';

describe('parseQuery', () => {
  it('splits bare words on any whitespace and lowercases', () => {
    expect(parseQuery('  Foo \t BAR\nbaz ')).toEqual([
      { value: 'foo', phrase: false, index: 0 },
      { value: 'bar', phrase: false, index: 1 },
      { value: 'baz', phrase: false, index: 2 },
    ]);
  });

  it('parses a double-quoted phrase as a single term', () => {
    expect(parseQuery('"force stop"')).toEqual([{ value: 'force stop', phrase: true, index: 0 }]);
  });

  it('treats an unterminated quote as a phrase to end of input', () => {
    expect(parseQuery('"force st')).toEqual([{ value: 'force st', phrase: true, index: 0 }]);
  });

  it('drops empty input, whitespace-only input, and empty quotes', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
    expect(parseQuery(' "" ')).toEqual([]);
  });

  it('splits a quote glued to bare words', () => {
    expect(parseQuery('pre"a b"post')).toEqual([
      { value: 'pre', phrase: false, index: 0 },
      { value: 'a b', phrase: true, index: 1 },
      { value: 'post', phrase: false, index: 2 },
    ]);
  });

  it('preserves inner whitespace of phrases verbatim', () => {
    expect(parseQuery('"a  b"')).toEqual([{ value: 'a  b', phrase: true, index: 0 }]);
    expect(parseQuery('"a\nb"')).toEqual([{ value: 'a\nb', phrase: true, index: 0 }]);
  });

  it('mixes tokens and phrases with sequential indices', () => {
    expect(parseQuery('alpha "two words" beta')).toEqual([
      { value: 'alpha', phrase: false, index: 0 },
      { value: 'two words', phrase: true, index: 1 },
      { value: 'beta', phrase: false, index: 2 },
    ]);
  });
});
