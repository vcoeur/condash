/**
 * Unit tests for the shared `**Verified:**` stamp parser — the grammar that
 * was previously re-implemented in main/knowledge.ts, main/index-knowledge.ts
 * and the CLI knowledge command.
 */
import { describe, expect, it } from 'vitest';
import {
  matchVerifiedLine,
  parseVerifiedStamps,
  stampAgeDays,
  verifiedStampRange,
} from './knowledge-stamps';

describe('parseVerifiedStamps', () => {
  it('parses date, provenance, and 1-based line', () => {
    const raw = '# Title\n\n**Verified:** 2026-05-17 condash@abc1234 on main\n\nBody.\n';
    const stamps = parseVerifiedStamps(raw);
    expect(stamps).toHaveLength(1);
    expect(stamps[0].verifiedAt).toBe('2026-05-17');
    expect(stamps[0].where).toBe('condash@abc1234 on main');
    expect(stamps[0].line).toBe(3);
  });

  it('parses a stamp with no trailing provenance', () => {
    const stamps = parseVerifiedStamps('**Verified:** 2026-01-02\n');
    expect(stamps[0].verifiedAt).toBe('2026-01-02');
    expect(stamps[0].where).toBe('');
    expect(stamps[0].line).toBe(1);
  });

  it('returns empty when there is no stamp', () => {
    expect(parseVerifiedStamps('# Title\n\nNo stamp here.\n')).toEqual([]);
  });

  it('returns every stamp in source order', () => {
    const raw = '**Verified:** 2026-01-01 a\n**Verified:** 2026-02-02 b\n';
    expect(parseVerifiedStamps(raw).map((s) => s.verifiedAt)).toEqual(['2026-01-01', '2026-02-02']);
  });

  it('ignores a stamp shown as an example inside a fenced block', () => {
    const raw = [
      '# Title',
      '',
      '**Verified:** 2026-03-03 real',
      '',
      'Write the stamp like this:',
      '',
      '```markdown',
      '**Verified:** 2020-01-01 example',
      '```',
      '',
    ].join('\n');
    expect(parseVerifiedStamps(raw).map((s) => s.verifiedAt)).toEqual(['2026-03-03']);
  });
});

describe('verifiedStampRange', () => {
  it('is null without a stamp', () => {
    expect(verifiedStampRange('# Title\n')).toBeNull();
  });

  it('collapses a single stamp to both ends', () => {
    const range = verifiedStampRange('**Verified:** 2026-05-17 x\n')!;
    expect(range.count).toBe(1);
    expect(range.oldest).toEqual(range.newest);
  });

  it('finds the oldest and newest regardless of source order', () => {
    // The header stamp is the *newest* here — the shape that used to read as
    // fresh while a much older claim sat further down (condash#512).
    const raw = [
      '**Verified:** 2026-08-14 head',
      '',
      '## Section',
      '',
      '**Verified:** 2026-05-04 section',
      '',
      '## Other',
      '',
      '**Verified:** 2026-07-01 other',
      '',
    ].join('\n');
    const range = verifiedStampRange(raw)!;
    expect(range.count).toBe(3);
    expect(range.oldest).toMatchObject({ verifiedAt: '2026-05-04', line: 5 });
    expect(range.newest).toMatchObject({ verifiedAt: '2026-08-14', line: 1 });
  });

  it('breaks a date tie by source order', () => {
    const raw = '**Verified:** 2026-05-04 first\n**Verified:** 2026-05-04 second\n';
    const range = verifiedStampRange(raw)!;
    expect(range.oldest.line).toBe(1);
    expect(range.newest.line).toBe(2);
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
