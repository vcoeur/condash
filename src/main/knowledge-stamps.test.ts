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
  // "Today" is constructed with local date parts (the same calendar the
  // stamp writer `isoToday` uses), so these hold in any machine timezone.
  it('counts whole local calendar days from the stamp to today', () => {
    const today = new Date(2026, 1, 1);
    expect(stampAgeDays('2026-01-01', today)).toBe(31);
  });

  it('is 0 for a future-dated stamp', () => {
    const today = new Date(2026, 0, 1);
    expect(stampAgeDays('2026-06-01', today)).toBe(0);
  });

  it('is 0 for a same-day stamp', () => {
    const today = new Date(2026, 0, 1, 12);
    expect(stampAgeDays('2026-01-01', today)).toBe(0);
  });

  // Midnight edges: stamps are written with the local-time `isoToday`, so
  // "now" must read local date parts too. A `getUTC*` reading was off by
  // one in the window where local date != UTC date (east of UTC just after
  // local midnight, west of UTC late in the local evening).
  it("counts yesterday's stamp as 1 day old just after local midnight", () => {
    const today = new Date(2026, 5, 9, 0, 30);
    expect(stampAgeDays('2026-06-08', today)).toBe(1);
  });

  it("counts today's stamp as 0 days old late in the local evening", () => {
    const today = new Date(2026, 5, 9, 23, 30);
    expect(stampAgeDays('2026-06-09', today)).toBe(0);
  });
});
