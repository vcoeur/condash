import { describe, expect, it } from 'vitest';
import { elide } from './index-elide';

describe('elide', () => {
  it('returns short text unchanged', () => {
    expect(elide('short', 200)).toBe('short');
    expect(elide('', 200)).toBe('');
  });

  it('returns exact-boundary text unchanged', () => {
    const text = 'x'.repeat(10);
    expect(elide(text, 10)).toBe(text);
  });

  it('throws on a non-positive max', () => {
    expect(() => elide('abc', 0)).toThrow();
    expect(() => elide('abc', -5)).toThrow();
  });

  it('cuts at a sentence boundary with no ellipsis when a complete sentence fits', () => {
    const text = 'First sentence. Second sentence. Third sentence that goes on and on.';
    const result = elide(text, 40);
    expect(result).toBe('First sentence. Second sentence.');
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).not.toContain('…');
  });

  it('prefers a sentence boundary over a word boundary when both fit', () => {
    const result = elide('abc. defg hi', 8);
    expect(result).toBe('abc.');
  });

  it('cuts at a word boundary with an ellipsis when no sentence boundary fits', () => {
    const result = elide('one two three four five six', 12);
    expect(result).toBe('one two…');
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it('hard-cuts a single unbreakable word', () => {
    const word = 'supercalifragilisticexpialidocious';
    const result = elide(word, 10);
    expect(result).toBe('supercali…');
    expect(result.length).toBe(10);
  });

  it('treats a colon like no boundary and falls back to a word cut', () => {
    const text = 'up to a state where: the rest of the sentence keeps going here';
    const result = elide(text, 24);
    expect(result).toBe('up to a state where:…');
    expect(result.length).toBeLessThanOrEqual(24);
    expect(result).toContain('…');
  });
});
