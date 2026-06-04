/**
 * Unit tests for the shared `**Verified:**` stamp parser — the grammar that
 * was previously re-implemented in main/knowledge.ts, main/index-knowledge.ts
 * and the CLI knowledge command.
 */
import { describe, expect, it } from 'vitest';
import {
  matchVerifiedLine,
  parseVerifiedDate,
  parseVerifiedStamp,
  stampAgeDays,
} from './knowledge-stamps';

describe('parseVerifiedStamp', () => {
  it('parses date, provenance, and 1-based line', () => {
    const raw = '# Title\n\n**Verified:** 2026-05-17 condash@abc1234 on main\n\nBody.\n';
    const stamp = parseVerifiedStamp(raw);
    expect(stamp).not.toBeNull();
    expect(stamp!.verifiedAt).toBe('2026-05-17');
    expect(stamp!.where).toBe('condash@abc1234 on main');
    expect(stamp!.line).toBe(3);
  });

  it('parses a stamp with no trailing provenance', () => {
    const stamp = parseVerifiedStamp('**Verified:** 2026-01-02\n');
    expect(stamp!.verifiedAt).toBe('2026-01-02');
    expect(stamp!.where).toBe('');
    expect(stamp!.line).toBe(1);
  });

  it('returns null when there is no stamp', () => {
    expect(parseVerifiedStamp('# Title\n\nNo stamp here.\n')).toBeNull();
  });

  it('returns the first stamp when several are present', () => {
    const raw = '**Verified:** 2026-01-01 a\n**Verified:** 2026-02-02 b\n';
    expect(parseVerifiedStamp(raw)!.verifiedAt).toBe('2026-01-01');
  });
});

describe('matchVerifiedLine', () => {
  it('returns the date for a stamp line', () => {
    expect(matchVerifiedLine('**Verified:** 2026-05-17 where')).toBe('2026-05-17');
  });
  it('returns null for a non-stamp line', () => {
    expect(matchVerifiedLine('## Some heading')).toBeNull();
  });
});

describe('parseVerifiedDate', () => {
  it('lifts only the date', () => {
    expect(parseVerifiedDate('**Verified:** 2026-05-17 x\n')).toBe('2026-05-17');
  });
  it('is undefined without a stamp', () => {
    expect(parseVerifiedDate('# Title\n')).toBeUndefined();
  });
});

describe('stampAgeDays', () => {
  it('counts whole days from the stamp to today (UTC)', () => {
    const today = new Date('2026-02-01T00:00:00Z');
    expect(stampAgeDays('2026-01-01', today)).toBe(31);
  });

  it('is 0 for a future-dated stamp', () => {
    const today = new Date('2026-01-01T00:00:00Z');
    expect(stampAgeDays('2026-06-01', today)).toBe(0);
  });

  it('is 0 for a same-day stamp', () => {
    const today = new Date('2026-01-01T12:00:00Z');
    expect(stampAgeDays('2026-01-01', today)).toBe(0);
  });
});
