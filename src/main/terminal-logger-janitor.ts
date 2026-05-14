import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';
import { resolveLoggingPrefs } from './terminal-logger';

export interface JanitorResult {
  scanned: number;
  deletedByAge: string[];
  deletedByCap: string[];
  remainingBytes: number;
}

/** Walk `<conception>/.condash/logs/YYYY/MM/DD/*` and:
 *
 *   1. delete day-directories older than `retentionDays`,
 *   2. total the remaining bytes and, while over `maxDirMb`, delete the
 *      oldest day-directory still standing.
 *
 * Whole-day eviction (not per-file) — simpler than per-file LRU and
 * matches how users actually think about logs. Returns the list of dirs
 * that were removed plus the post-cleanup size.
 *
 * A retention of 0 means "never delete by age" (only the dir-cap path
 * applies); the schema enforces non-negative. */
export async function runLogJanitor(
  conceptionPath: string,
  patch?: TerminalLoggingPrefs,
  now: Date = new Date(),
): Promise<JanitorResult> {
  const prefs = resolveLoggingPrefs(patch);
  const root = condashLogsRoot(conceptionPath);
  const result: JanitorResult = {
    scanned: 0,
    deletedByAge: [],
    deletedByCap: [],
    remainingBytes: 0,
  };

  const days = await listDayDirs(root);
  result.scanned = days.length;
  if (days.length === 0) return result;

  // 1. Age-based eviction
  const cutoff = prefs.retentionDays === 0 ? null : daysAgo(now, prefs.retentionDays);
  if (cutoff !== null) {
    for (const day of days) {
      if (day.date < cutoff) {
        await removeDirSafe(day.path);
        result.deletedByAge.push(day.path);
      }
    }
  }

  // Refresh the survivor list now that the age pass is done.
  const survivors: DayDir[] = [];
  for (const day of days) {
    if (result.deletedByAge.includes(day.path)) continue;
    survivors.push(day);
  }

  // 2. Size-based eviction (oldest day-dir first).
  // Sort ascending by date; pop from the front while over cap.
  survivors.sort((a, b) => (a.date < b.date ? -1 : 1));
  let total = await sumBytes(survivors);
  const cap = prefs.maxDirMb * 1024 * 1024;
  while (total > cap && survivors.length > 0) {
    const victim = survivors.shift()!;
    const size = await sizeOfDir(victim.path);
    await removeDirSafe(victim.path);
    result.deletedByCap.push(victim.path);
    total -= size;
  }
  result.remainingBytes = total;
  return result;
}

interface DayDir {
  /** Local-time date object (00:00 on that day). */
  date: Date;
  /** Absolute filesystem path. */
  path: string;
}

/** Discover `<root>/YYYY/MM/DD/` directories. Silently swallows ENOENT
 * at any level — a missing branch just means "no logs for that period". */
async function listDayDirs(root: string): Promise<DayDir[]> {
  const out: DayDir[] = [];
  const years = await readDirSafe(root);
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yearPath = join(root, y);
    const months = await readDirSafe(yearPath);
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const monthPath = join(yearPath, m);
      const days = await readDirSafe(monthPath);
      for (const d of days) {
        if (!/^\d{2}$/.test(d)) continue;
        out.push({
          // Local-time midnight: matches the timestamps produced by
          // `sessionLogPath` (also local-time).
          date: new Date(Number(y), Number(m) - 1, Number(d)),
          path: join(monthPath, d),
        });
      }
    }
  }
  return out;
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function removeDirSafe(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch {
    /* don't propagate — janitor errors must not crash app start */
  }
}

async function sizeOfDir(path: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) {
      total += await sizeOfDir(p);
    } else if (e.isFile()) {
      try {
        const stat = await fs.stat(p);
        total += stat.size;
      } catch {
        /* gone */
      }
    }
  }
  return total;
}

async function sumBytes(days: DayDir[]): Promise<number> {
  let total = 0;
  for (const d of days) total += await sizeOfDir(d.path);
  return total;
}

function daysAgo(now: Date, days: number): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}
