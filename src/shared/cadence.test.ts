import { describe, expect, it } from 'vitest';
import { parseCadence } from './cadence';

describe('parseCadence', () => {
  it('parses seconds / minutes / hours to ms', () => {
    expect(parseCadence('30s')).toBe(30_000);
    expect(parseCadence('2m')).toBe(120_000);
    expect(parseCadence('1h')).toBe(3_600_000);
  });

  it('tolerates surrounding + inner whitespace', () => {
    expect(parseCadence('  5 m ')).toBe(300_000);
  });

  it('returns null for absent / empty / malformed input', () => {
    expect(parseCadence(undefined)).toBeNull();
    expect(parseCadence('')).toBeNull();
    expect(parseCadence('2d')).toBeNull();
    expect(parseCadence('m')).toBeNull();
    expect(parseCadence('0s')).toBeNull();
    expect(parseCadence('-3m')).toBeNull();
    expect(parseCadence('abc')).toBeNull();
  });
});
