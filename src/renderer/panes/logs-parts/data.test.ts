import { describe, expect, it } from 'vitest';
import {
  daysAgoStr,
  formatBytes,
  localDayStr,
  monthGroupsOf,
  recentDaysOf,
  type KnownDay,
} from './data';

const day = (d: string, sessions = 1): KnownDay => ({ day: d, path: `/logs/${d}`, sessions });

describe('localDayStr / daysAgoStr', () => {
  it('formats a local date as YYYY-MM-DD with zero padding', () => {
    expect(localDayStr(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(localDayStr(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('steps back n days, crossing month and year boundaries', () => {
    const now = new Date(2026, 0, 3); // 2026-01-03
    expect(daysAgoStr(0, now)).toBe('2026-01-03');
    expect(daysAgoStr(2, now)).toBe('2026-01-01');
    expect(daysAgoStr(3, now)).toBe('2025-12-31');
    expect(daysAgoStr(6, now)).toBe('2025-12-28');
  });
});

describe('recentDaysOf', () => {
  it('keeps today and the 6 prior days, preserving newest-first order', () => {
    const now = new Date(2026, 5, 9); // 2026-06-09
    const cutoff = daysAgoStr(6, now); // 2026-06-03
    const days = [
      day('2026-06-09'),
      day('2026-06-08'),
      day('2026-06-03'),
      day('2026-06-02'),
      day('2026-05-30'),
    ];
    expect(recentDaysOf(days, cutoff).map((d) => d.day)).toEqual([
      '2026-06-09',
      '2026-06-08',
      '2026-06-03',
    ]);
  });

  it('returns empty when every day is older than the window', () => {
    expect(recentDaysOf([day('2026-01-01')], '2026-06-03')).toEqual([]);
  });
});

describe('monthGroupsOf', () => {
  it('folds pre-cutoff days into per-month groups, months newest-first', () => {
    const cutoff = '2026-06-03';
    const days = [
      day('2026-06-09'), // in the recent window — excluded
      day('2026-06-02'),
      day('2026-06-01'),
      day('2026-05-30'),
      day('2026-04-12'),
    ];
    const groups = monthGroupsOf(days, cutoff);
    expect(groups.map((g) => g.key)).toEqual(['2026-06', '2026-05', '2026-04']);
    expect(groups[0].days.map((d) => d.day)).toEqual(['2026-06-02', '2026-06-01']);
    expect(groups[1].days.map((d) => d.day)).toEqual(['2026-05-30']);
    expect(groups[2].days.map((d) => d.day)).toEqual(['2026-04-12']);
  });

  it('keeps the newest-first input order within each month', () => {
    const groups = monthGroupsOf([day('2026-05-31'), day('2026-05-01')], '2026-06-03');
    expect(groups).toHaveLength(1);
    expect(groups[0].days.map((d) => d.day)).toEqual(['2026-05-31', '2026-05-01']);
  });

  it('returns empty when everything falls inside the recent window', () => {
    expect(monthGroupsOf([day('2026-06-05')], '2026-06-03')).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('renders B / KB / MB bands', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
