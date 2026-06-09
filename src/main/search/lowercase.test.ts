import { describe, expect, it } from 'vitest';
import { toLowerCaseSameLength } from './lowercase';

describe('toLowerCaseSameLength', () => {
  it('matches toLowerCase for plain content', () => {
    expect(toLowerCaseSameLength('Hello WORLD-42 Über')).toBe('hello world-42 über');
  });

  it('preserves length when U+0130 would grow under toLowerCase', () => {
    const raw = 'AİB';
    // The hazard being guarded against: the standard mapping adds a code unit.
    expect(raw.toLowerCase().length).toBe(4);

    const lowered = toLowerCaseSameLength(raw);
    expect(lowered.length).toBe(raw.length);
    // The length-changing character stays as-is; everything else lowers.
    expect(lowered).toBe('aİb');
  });

  it('still lowers the rest of a string containing U+0130', () => {
    const raw = 'İSTANBUL Report';
    const lowered = toLowerCaseSameLength(raw);
    expect(lowered.length).toBe(raw.length);
    expect(lowered).toBe('İstanbul report');
  });

  it('keeps surrogate pairs intact', () => {
    const raw = '\u{1D49C}İZ'; // astral char + İ + ascii
    const lowered = toLowerCaseSameLength(raw);
    expect(lowered.length).toBe(raw.length);
    expect(lowered.endsWith('z')).toBe(true);
  });
});
