import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { condashLogsRoot } from './condash-dir';
import { META_LINE_PREFIX } from './logs-format';
import {
  AmbiguousSidError,
  listDays,
  listSessions,
  parseWhen,
  readHeadTailMeta,
  readSession,
  resolveSession,
} from './logs-query';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-logs-query-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface MakeLogOpts {
  day: string; // YYYY-MM-DD
  time: string; // HHMMSS
  sid: string;
  repo?: string;
  argv?: string[];
  kind?: 'transcript' | 'grid';
  body?: string;
  /** Footer exit code; omit for an active (footer-less) session. */
  exitCode?: number | null;
  sealed?: boolean;
}

/** Write one session `.txt` in the canonical layout and return its path. */
async function makeLog(opts: MakeLogOpts): Promise<string> {
  const [y, m, d] = opts.day.split('-');
  const dir = join(condashLogsRoot(tmp), y, m, d);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${opts.time}-${opts.sid}.txt`);
  const hh = opts.time.slice(0, 2);
  const mi = opts.time.slice(2, 4);
  const ss = opts.time.slice(4, 6);
  const header = {
    sid: opts.sid,
    side: 'my',
    ...(opts.repo ? { repo: opts.repo } : {}),
    cwd: '/x',
    cmd: 'bash',
    argv: opts.argv ?? [],
    started: `${opts.day}T${hh}:${mi}:${ss}.000Z`,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
  let text = `${META_LINE_PREFIX}${JSON.stringify(header)}\n\n${opts.body ?? 'hello\nworld'}\n`;
  if (opts.exitCode !== undefined) {
    const footer = {
      finished: `${opts.day}T${hh}:${mi}:${Number(ss) + 1}.000Z`,
      exitCode: opts.exitCode,
      ...(opts.sealed ? { sealedByRecovery: true } : {}),
    };
    text += `\n${META_LINE_PREFIX}${JSON.stringify(footer)}\n`;
  }
  await writeFile(path, text, 'utf8');
  return path;
}

describe('listDays', () => {
  it('returns one row per day with counts and sizes, newest first', async () => {
    await makeLog({ day: '2026-05-29', time: '090000', sid: 't-aa1', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-bb1', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '110000', sid: 't-bb2', exitCode: 0 });
    const days = await listDays(tmp);
    expect(days.map((d) => d.day)).toEqual(['2026-05-30', '2026-05-29']);
    expect(days[0].sessions).toBe(2);
    expect(days[1].sessions).toBe(1);
    expect(days[0].bytes).toBeGreaterThan(0);
  });

  it('returns [] for a conception with no logs', async () => {
    expect(await listDays(tmp)).toEqual([]);
  });
});

describe('listSessions — enumerate + filter', () => {
  it('parses ref fields off the directory layout and header metadata', async () => {
    await makeLog({
      day: '2026-05-30',
      time: '101502',
      sid: 't-abc1',
      repo: 'condash',
      exitCode: 0,
    });
    const rows = await listSessions(tmp);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: '2026-05-30',
      time: '10:15:02',
      sid: 't-abc1',
      repo: 'condash',
      cmd: 'bash',
      exitCode: 0,
      active: false,
      kind: 'grid',
    });
  });

  it('filters by day', async () => {
    await makeLog({ day: '2026-05-29', time: '090000', sid: 't-aa1', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-bb1', exitCode: 0 });
    const rows = await listSessions(tmp, { day: '2026-05-30' });
    expect(rows.map((r) => r.sid)).toEqual(['t-bb1']);
  });

  it('filters by repo (exact match)', async () => {
    await makeLog({
      day: '2026-05-30',
      time: '100000',
      sid: 't-aa1',
      repo: 'condash',
      exitCode: 0,
    });
    await makeLog({ day: '2026-05-30', time: '110000', sid: 't-bb1', repo: 'knoten', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '120000', sid: 't-cc1', exitCode: 0 });
    const rows = await listSessions(tmp, { repo: 'condash' });
    expect(rows.map((r) => r.sid)).toEqual(['t-aa1']);
  });

  it('filters by active (no footer on disk)', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-done', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '110000', sid: 't-live' });
    const rows = await listSessions(tmp, { active: true });
    expect(rows.map((r) => r.sid)).toEqual(['t-live']);
    expect(rows[0].exitCode).toBeUndefined();
  });

  it('reports a recovery-sealed orphan as inactive with exitCode null', async () => {
    await makeLog({
      day: '2026-05-30',
      time: '100000',
      sid: 't-orp',
      exitCode: null,
      sealed: true,
    });
    const rows = await listSessions(tmp);
    expect(rows[0].active).toBe(false);
    expect(rows[0].exitCode).toBeNull();
    expect(rows[0].exitSealed).toBe(true);
  });

  it('filters by spawn-time window (local wall clock) and mtime', async () => {
    const p1 = await makeLog({ day: '2026-05-30', time: '080000', sid: 't-old', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '140000', sid: 't-new', exitCode: 0 });
    // Backdate the old file's mtime far into the past.
    const t = new Date(2026, 4, 30, 8, 0, 5).getTime() / 1000;
    await utimes(p1, t, t);

    const noon = new Date(2026, 4, 30, 12, 0, 0).getTime();
    expect((await listSessions(tmp, { sinceMs: noon })).map((r) => r.sid)).toEqual(['t-new']);
    expect((await listSessions(tmp, { untilMs: noon })).map((r) => r.sid)).toEqual(['t-old']);
    expect((await listSessions(tmp, { modifiedSinceMs: noon })).map((r) => r.sid)).toEqual([
      't-new',
    ]);
  });

  it('prefix-filters by sid and caps with limit after newest-first sorting', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-aaa1', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '110000', sid: 't-aaa2', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '120000', sid: 't-bbb1', exitCode: 0 });
    expect((await listSessions(tmp, { sid: 't-aaa' })).map((r) => r.sid)).toEqual([
      't-aaa2',
      't-aaa1',
    ]);
    const limited = await listSessions(tmp, { limit: 2 });
    expect(limited.map((r) => r.sid)).toEqual(['t-bbb1', 't-aaa2']);
  });

  it('surfaces the header kind, falling back to the role-block heuristic', async () => {
    await makeLog({
      day: '2026-05-30',
      time: '100000',
      sid: 't-tr',
      kind: 'transcript',
      exitCode: 0,
    });
    await makeLog({
      day: '2026-05-30',
      time: '110000',
      sid: 't-leg',
      body: '[user] question\n\n[assistant] answer',
      exitCode: 0,
    });
    const rows = await listSessions(tmp);
    const bySid = new Map(rows.map((r) => [r.sid, r]));
    expect(bySid.get('t-tr')?.kind).toBe('transcript');
    expect(bySid.get('t-leg')?.kind).toBe('transcript'); // legacy heuristic
  });
});

describe('parallelized listing (bounded concurrency pool)', () => {
  // More files than the pool size (32) so the listing spans multiple waves —
  // guards that the parallelized walk still returns every row in the same
  // sorted order the old serial loop produced.
  it('listSessions returns all rows newest-first across a busy day', async () => {
    const expected: string[] = [];
    for (let i = 0; i < 40; i++) {
      const hh = String(8 + Math.floor(i / 60)).padStart(2, '0');
      const mm = String(i % 60).padStart(2, '0');
      const sid = `t-${String(i).padStart(3, '0')}`;
      await makeLog({ day: '2026-05-30', time: `${hh}${mm}00`, sid, exitCode: 0 });
      expected.push(sid);
    }
    expected.reverse(); // newest spawn-time first
    const rows = await listSessions(tmp, { day: '2026-05-30' });
    expect(rows.map((r) => r.sid)).toEqual(expected);
  });

  it('listDays counts every session and sums sizes across many files', async () => {
    for (let i = 0; i < 40; i++) {
      const mm = String(i % 60).padStart(2, '0');
      await makeLog({ day: '2026-05-30', time: `09${mm}00`, sid: `t-d${i}`, exitCode: 0 });
    }
    await makeLog({ day: '2026-05-29', time: '120000', sid: 't-prev', exitCode: 0 });
    const days = await listDays(tmp);
    expect(days.map((d) => d.day)).toEqual(['2026-05-30', '2026-05-29']);
    expect(days[0].sessions).toBe(40);
    expect(days[1].sessions).toBe(1);
    expect(days[0].bytes).toBeGreaterThan(0);
  });
});

describe('long headers (> 4 KB)', () => {
  it('parses a header line larger than the old fixed 4 KB head read', async () => {
    // A promptFlags run rides its full prompt in argv — easily over 4 KB.
    const hugeArgv = ['-c', `claude --prompt '${'x'.repeat(8000)}'`];
    await makeLog({
      day: '2026-05-30',
      time: '100000',
      sid: 't-big',
      repo: 'condash',
      argv: hugeArgv,
      exitCode: 0,
    });
    const rows = await listSessions(tmp, { repo: 'condash' });
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('condash');
    expect(rows[0].cmd).toContain('claude --prompt');
    expect(rows[0].exitCode).toBe(0);
    expect(rows[0].active).toBe(false);
  });

  it('readHeadTailMeta recovers header + footer of a long-header file directly', async () => {
    const path = await makeLog({
      day: '2026-05-30',
      time: '110000',
      sid: 't-big2',
      repo: 'knoten',
      argv: ['-c', 'y'.repeat(10_000)],
      kind: 'grid',
      exitCode: 3,
    });
    const size = (await stat(path)).size;
    const { header, footer, kind } = await readHeadTailMeta(path, size);
    expect(header?.repo).toBe('knoten');
    expect(footer?.exitCode).toBe(3);
    expect(kind).toBe('grid');
  });
});

describe('resolveSession', () => {
  it('resolves a unique sid prefix', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-abc1', exitCode: 0 });
    const ref = await resolveSession(tmp, 't-abc');
    expect(ref?.sid).toBe('t-abc1');
    expect(ref?.day).toBe('2026-05-30');
  });

  it('throws AmbiguousSidError when the prefix matches several sessions', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-abc1', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '110000', sid: 't-abc2', exitCode: 0 });
    await expect(resolveSession(tmp, 't-abc')).rejects.toBeInstanceOf(AmbiguousSidError);
  });

  it('an exact sid match wins outright even when it prefixes others', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-ab', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '110000', sid: 't-abc', exitCode: 0 });
    const ref = await resolveSession(tmp, 't-ab');
    expect(ref?.sid).toBe('t-ab');
  });

  it('resolves a day/sid qualifier scoped to that day', async () => {
    await makeLog({ day: '2026-05-29', time: '100000', sid: 't-abc1', exitCode: 0 });
    await makeLog({ day: '2026-05-30', time: '110000', sid: 't-abc2', exitCode: 0 });
    const ref = await resolveSession(tmp, '2026-05-29/t-abc');
    expect(ref?.sid).toBe('t-abc1');
  });

  it('resolves an absolute path under the logs root', async () => {
    const path = await makeLog({ day: '2026-05-30', time: '100000', sid: 't-abs', exitCode: 0 });
    const ref = await resolveSession(tmp, path);
    expect(ref?.sid).toBe('t-abs');
    expect(ref?.time).toBe('10:00:00');
  });

  it('resolves a native-separator (Windows-shaped) absolute path (P2)', async () => {
    const path = await makeLog({ day: '2026-05-30', time: '100000', sid: 't-win', exitCode: 0 });
    // Simulate native Windows separators. resolveSession must POSIX-normalise
    // before the `startsWith(root)` / `includes('/')` checks and SESSION_RE, or
    // a backslash path never resolves. (Constructed manually — tests run on
    // Linux, where join() would never emit backslashes.)
    const windowsShaped = path.replace(/\//g, '\\');
    const ref = await resolveSession(tmp, windowsShaped);
    expect(ref?.sid).toBe('t-win');
    expect(ref?.day).toBe('2026-05-30');
    expect(ref?.time).toBe('10:00:00');
  });

  it('returns null when nothing matches', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-abc1', exitCode: 0 });
    expect(await resolveSession(tmp, 't-zzz')).toBeNull();
  });
});

describe('readSession — slicing', () => {
  const BODY = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');

  async function makeRef() {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-sl', body: BODY, exitCode: 0 });
    const ref = await resolveSession(tmp, 't-sl');
    if (!ref) throw new Error('unresolved');
    return ref;
  }

  it('returns the full meta-stripped body by default', async () => {
    const r = await readSession(await makeRef());
    expect(r.text).toBe(BODY);
    expect(r.totalLines).toBe(5);
    expect(r.header?.sid).toBe('t-sl');
    expect(r.footer?.exitCode).toBe(0);
    expect(r.kind).toBe('grid');
  });

  it('head slices the first n lines', async () => {
    const r = await readSession(await makeRef(), { head: 2 });
    expect(r.text).toBe('l1\nl2');
  });

  it('tail slices the last n lines (n ≥ total returns everything)', async () => {
    expect((await readSession(await makeRef(), { tail: 2 })).text).toBe('l4\nl5');
    expect((await readSession(await makeRef(), { tail: 99 })).text).toBe(BODY);
  });

  it('lines slices an inclusive 1-based range; to: null runs to the end', async () => {
    expect((await readSession(await makeRef(), { lines: { from: 2, to: 4 } })).text).toBe(
      'l2\nl3\nl4',
    );
    expect((await readSession(await makeRef(), { lines: { from: 4, to: null } })).text).toBe(
      'l4\nl5',
    );
  });

  it('metaOnly returns parsed metadata with an empty body', async () => {
    const r = await readSession(await makeRef(), { metaOnly: true });
    expect(r.text).toBe('');
    expect(r.header?.sid).toBe('t-sl');
    expect(r.totalLines).toBe(5);
  });

  it('withMeta keeps the # condash: lines in the sliced source', async () => {
    const r = await readSession(await makeRef(), { withMeta: true, head: 1 });
    expect(r.text.startsWith(META_LINE_PREFIX)).toBe(true);
  });

  it('redact masks secrets in the emitted slice', async () => {
    await makeLog({
      day: '2026-05-30',
      time: '110000',
      sid: 't-sec',
      body: 'export API_KEY=supersecretvalue123',
      exitCode: 0,
    });
    const ref = await resolveSession(tmp, 't-sec');
    const r = await readSession(ref!, { redact: true });
    expect(r.text).toContain('«redacted:secret»');
    expect(r.text).not.toContain('supersecretvalue123');
  });
});

describe('readSession — --from-byte cursor semantics', () => {
  it('returns raw bytes from the offset with the trailing footer stripped', async () => {
    await makeLog({
      day: '2026-05-30',
      time: '100000',
      sid: 't-cur',
      body: 'abc\ndef',
      exitCode: 0,
    });
    const ref = await resolveSession(tmp, 't-cur');
    const full = await readSession(ref!, { fromByte: 0 });
    // Header rides along (raw bytes), but the footer never re-surfaces.
    expect(full.text.startsWith(META_LINE_PREFIX)).toBe(true);
    expect(full.text).toContain('abc\ndef');
    expect(full.text).not.toContain('exitCode');
    expect(full.fromByte).toBe(0);
    expect(full.rotated).toBe(false);
    // nextByte is the file size — pass it back as the next cursor.
    expect(full.nextByte).toBe(full.bytes);
  });

  it('a cursor equal to the size yields an empty, non-rotated read', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-eq', exitCode: 0 });
    const ref = await resolveSession(tmp, 't-eq');
    const first = await readSession(ref!, { fromByte: 0 });
    const next = await readSession(ref!, { fromByte: first.nextByte });
    expect(next.rotated).toBe(false);
    expect(next.text).toBe('');
    expect(next.nextByte).toBe(first.nextByte);
  });

  it('flags rotated when the cursor is beyond the current size', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-rot', exitCode: 0 });
    const ref = await resolveSession(tmp, 't-rot');
    const r = await readSession(ref!, { fromByte: 10_000_000 });
    expect(r.rotated).toBe(true);
    expect(r.text).toBe('');
    expect(r.fromByte).toBe(10_000_000);
    expect(r.nextByte).toBe(r.bytes); // reset cursor for the caller
  });

  it('a mid-file cursor returns only the new bytes', async () => {
    await makeLog({ day: '2026-05-30', time: '100000', sid: 't-mid', body: 'AAAA\nBBBB' });
    const ref = await resolveSession(tmp, 't-mid');
    const full = await readSession(ref!, { fromByte: 0 });
    const offset = full.text.indexOf('BBBB');
    const slice = await readSession(ref!, { fromByte: offset });
    expect(slice.text.startsWith('BBBB')).toBe(true);
  });
});

describe('parseWhen', () => {
  const now = new Date(2026, 4, 30, 12, 0, 0).getTime();

  it('parses relative spans', () => {
    expect(parseWhen('30m', now)).toBe(now - 30 * 60_000);
    expect(parseWhen('2h', now)).toBe(now - 2 * 3_600_000);
    expect(parseWhen('3d', now)).toBe(now - 3 * 86_400_000);
    expect(parseWhen('1w', now)).toBe(now - 7 * 86_400_000);
  });

  it('parses today / yesterday as local midnight', () => {
    expect(parseWhen('today', now)).toBe(new Date(2026, 4, 30).getTime());
    expect(parseWhen('yesterday', now)).toBe(new Date(2026, 4, 29).getTime());
  });

  it('parses zone-less ISO dates and datetimes as local wall clock', () => {
    expect(parseWhen('2026-05-30', now)).toBe(new Date(2026, 4, 30).getTime());
    expect(parseWhen('2026-05-30T10:30', now)).toBe(new Date(2026, 4, 30, 10, 30).getTime());
    expect(parseWhen('2026-05-30T10:30:15', now)).toBe(new Date(2026, 4, 30, 10, 30, 15).getTime());
  });

  it('returns null on malformed tokens', () => {
    expect(parseWhen('soon', now)).toBeNull();
    expect(parseWhen('5x', now)).toBeNull();
    expect(parseWhen('', now)).toBeNull();
  });
});
