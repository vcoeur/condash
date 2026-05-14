import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { condashLogsRoot } from './condash-dir';
import { runLogJanitor } from './terminal-logger-janitor';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-janitor-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dayDirPath(date: Date): string {
  const root = condashLogsRoot(tmp);
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return join(root, y, m, d);
}

function makeDay(date: Date, sizeBytes = 100): string {
  const dir = dayDirPath(date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'one.jsonl'), 'x'.repeat(sizeBytes));
  return dir;
}

/** Day-dir populated with a realistic `.txt` + `.meta.json` pair the
 * compression pass exercises. Returns the txt path. */
function makeDayWithTxt(date: Date, body = 'hello world\n'): string {
  const dir = dayDirPath(date);
  mkdirSync(dir, { recursive: true });
  const txt = join(dir, '120000-sid.txt');
  writeFileSync(txt, body);
  writeFileSync(join(dir, '120000-sid.meta.json'), '{"sid":"sid"}\n');
  return txt;
}

describe('runLogJanitor', () => {
  it('returns scanned 0 and no deletions when the logs root is missing', async () => {
    const result = await runLogJanitor(tmp);
    expect(result.scanned).toBe(0);
    expect(result.deletedByAge).toEqual([]);
    expect(result.deletedByCap).toEqual([]);
  });

  it('deletes day-dirs older than retentionDays', async () => {
    const now = new Date(2026, 4, 13); // local-time mid-May 2026
    const oldDay = makeDay(new Date(2026, 0, 1)); // very old
    const recentDay = makeDay(new Date(2026, 4, 12));
    const result = await runLogJanitor(tmp, { retentionDays: 14 }, now);
    expect(result.deletedByAge).toEqual([oldDay]);
    expect(existsSync(oldDay)).toBe(false);
    expect(existsSync(recentDay)).toBe(true);
  });

  it('retentionDays=0 disables age-based eviction', async () => {
    const now = new Date(2026, 4, 13);
    const oldDay = makeDay(new Date(2026, 0, 1));
    const result = await runLogJanitor(tmp, { retentionDays: 0, maxDirMb: 10_000 }, now);
    expect(result.deletedByAge).toEqual([]);
    expect(existsSync(oldDay)).toBe(true);
  });

  it('evicts oldest day-dir first while over maxDirMb', async () => {
    const now = new Date(2026, 4, 13);
    // Three days, each 1 MB; cap at 2 MB → oldest dropped.
    const oneMb = 1 * 1024 * 1024;
    const old1 = makeDay(new Date(2026, 4, 10), oneMb);
    const old2 = makeDay(new Date(2026, 4, 11), oneMb);
    const old3 = makeDay(new Date(2026, 4, 12), oneMb);
    const result = await runLogJanitor(
      tmp,
      // retentionDays kept generous so the size pass is the one we test.
      { retentionDays: 365, maxDirMb: 2 },
      now,
    );
    expect(result.deletedByCap).toEqual([old1]);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(true);
    expect(existsSync(old3)).toBe(true);
  });

  it('applies age eviction before size eviction', async () => {
    const now = new Date(2026, 4, 13);
    const oneMb = 1 * 1024 * 1024;
    const oldByAge = makeDay(new Date(2025, 0, 1), oneMb);
    const recent = makeDay(new Date(2026, 4, 12), oneMb);
    const result = await runLogJanitor(tmp, { retentionDays: 14, maxDirMb: 5 }, now);
    expect(result.deletedByAge).toEqual([oldByAge]);
    expect(result.deletedByCap).toEqual([]); // recent is under cap
    expect(existsSync(oldByAge)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('skips non-numeric directory names', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'x.md'), 'x');
    makeDay(new Date(2026, 4, 12)); // a real day-dir
    const result = await runLogJanitor(tmp, { retentionDays: 14 }, new Date(2026, 4, 13));
    expect(result.scanned).toBe(1);
    // The non-numeric `notes/` subtree survives.
    expect(existsSync(join(root, 'notes', 'x.md'))).toBe(true);
  });

  it('compresses .txt to .txt.gz in day-dirs older than 1 day', async () => {
    const now = new Date(2026, 4, 14);
    const yesterdayTxt = makeDayWithTxt(new Date(2026, 4, 12), 'yesterday body\n');
    const todayTxt = makeDayWithTxt(new Date(2026, 4, 14), 'today body\n');

    const result = await runLogJanitor(tmp, { retentionDays: 30, maxDirMb: 1024 }, now);

    // Yesterday should be compressed; today should be untouched.
    expect(result.compressed).toContain(`${yesterdayTxt}.gz`);
    expect(existsSync(yesterdayTxt)).toBe(false);
    expect(existsSync(`${yesterdayTxt}.gz`)).toBe(true);
    expect(existsSync(todayTxt)).toBe(true);
    expect(existsSync(`${todayTxt}.gz`)).toBe(false);

    // Gzipped content round-trips back to the original body.
    const gz = readFileSync(`${yesterdayTxt}.gz`);
    expect(gunzipSync(gz).toString('utf8')).toBe('yesterday body\n');

    // Sidecar `.meta.json` left intact.
    expect(existsSync(yesterdayTxt.replace(/\.txt$/, '.meta.json'))).toBe(true);
  });

  it('compression pass is idempotent — re-running does nothing', async () => {
    const now = new Date(2026, 4, 14);
    const txt = makeDayWithTxt(new Date(2026, 4, 12), 'stable body\n');

    const first = await runLogJanitor(tmp, { retentionDays: 30, maxDirMb: 1024 }, now);
    expect(first.compressed).toContain(`${txt}.gz`);

    const second = await runLogJanitor(tmp, { retentionDays: 30, maxDirMb: 1024 }, now);
    expect(second.compressed).toEqual([]);
    expect(existsSync(`${txt}.gz`)).toBe(true);
    expect(existsSync(txt)).toBe(false);
  });

  it("does not compress today's day-dir (writer race avoidance)", async () => {
    const now = new Date(2026, 4, 14);
    const todayTxt = makeDayWithTxt(new Date(2026, 4, 14));
    const result = await runLogJanitor(tmp, { retentionDays: 30, maxDirMb: 1024 }, now);
    expect(result.compressed).toEqual([]);
    expect(existsSync(todayTxt)).toBe(true);
  });
});
