// Pure date / partition helpers for the Logs pane. Dependency-free so the
// grouping logic is unit-testable without DOM or IPC (see data.test.ts).

/** One known log day as returned by `logsListDays` (newest-first). */
export type KnownDay = { day: string; path: string; sessions: number };

/** Older days grouped under a `YYYY-MM` key, months newest-first. */
export type MonthGroup = { key: string; days: KnownDay[] };

/** Local-date `YYYY-MM-DD` for a `Date` (defaults to now). Local, not UTC, so
 *  "today" matches the day strings the writer stamps from local time. */
export function localDayStr(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` of the day `n` days before now (local). */
export function daysAgoStr(n: number, now: Date = new Date()): string {
  return localDayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
}

/** Last-7-days band: days at or after `recentCutoff`, preserving the
 *  newest-first order of `logsListDays`. Day strings sort lexicographically
 *  === chronologically, so a plain string compare partitions the list. */
export function recentDaysOf(days: readonly KnownDay[], recentCutoff: string): KnownDay[] {
  return days.filter((d) => d.day >= recentCutoff);
}

/** Older days (before `recentCutoff`), grouped by `YYYY-MM`, months
 *  newest-first; days within a month keep the newest-first input order. */
export function monthGroupsOf(days: readonly KnownDay[], recentCutoff: string): MonthGroup[] {
  const map = new Map<string, KnownDay[]>();
  for (const d of days.filter((day) => day.day < recentCutoff)) {
    const key = d.day.slice(0, 7);
    const bucket = map.get(key);
    if (bucket) bucket.push(d);
    else map.set(key, [d]);
  }
  return [...map.keys()]
    .sort((a, b) => (a < b ? 1 : -1))
    .map((key) => ({ key, days: map.get(key)! }));
}

/** "Mon 24 May" label for a `YYYY-MM-DD` day string. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** "May 2026" label for a `YYYY-MM` month key. */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Human-readable byte count for the session-size cell. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
