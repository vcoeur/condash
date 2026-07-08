import { describe, expect, it } from 'vitest';
import { mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealOrphanLogs } from './seal-orphan-logs';
import { splitContent } from './logs-format';

const HEADER =
  '# condash: {"sid":"abc","side":"my","cwd":"/x","cmd":"claude","argv":[],"started":"2026-05-19T05:00:00.000Z"}';
const FOOTER_OK = '# condash: {"finished":"2026-05-19T05:01:00.000Z","exitCode":0}';

async function makeConception(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'condash-seal-'));
  await mkdir(join(dir, '.condash/logs/2026/05/19'), { recursive: true });
  return dir;
}

function logPath(c: string, name: string): string {
  return join(c, '.condash/logs/2026/05/19', name);
}

async function backdate(path: string, secondsAgo: number): Promise<void> {
  const t = (Date.now() - secondsAgo * 1000) / 1000;
  await utimes(path, t, t);
}

describe('sealOrphanLogs', () => {
  it('seals a footer-less file whose mtime is older than the grace window', async () => {
    const c = await makeConception();
    const p = logPath(c, '120000-abc.txt');
    await writeFile(p, HEADER + '\n\nhello world\n', 'utf8');
    await backdate(p, 60);
    const r = await sealOrphanLogs(c);
    expect(r.sealed).toContain(p);
    const text = await readFile(p, 'utf8');
    const { footer } = splitContent(text);
    expect(footer).toBeTruthy();
    expect(footer!.exitCode).toBeNull();
    expect(footer!.sealedByRecovery).toBe(true);
    await rm(c, { recursive: true, force: true });
  });

  it('leaves files with an existing footer untouched', async () => {
    const c = await makeConception();
    const p = logPath(c, '120100-def.txt');
    await writeFile(p, HEADER + '\n\nhello\n\n' + FOOTER_OK + '\n', 'utf8');
    await backdate(p, 60);
    const before = await readFile(p, 'utf8');
    const r = await sealOrphanLogs(c);
    expect(r.sealed).not.toContain(p);
    expect(await readFile(p, 'utf8')).toBe(before);
    await rm(c, { recursive: true, force: true });
  });

  it('leaves recently-modified files alone (still flushing)', async () => {
    const c = await makeConception();
    const p = logPath(c, '120200-ghi.txt');
    await writeFile(p, HEADER + '\n\nstreaming...\n', 'utf8');
    // Fresh mtime (~now) — should be considered still-writing.
    const r = await sealOrphanLogs(c);
    expect(r.sealed).not.toContain(p);
    await rm(c, { recursive: true, force: true });
  });

  it('idempotent across runs — second pass does not re-seal', async () => {
    const c = await makeConception();
    const p = logPath(c, '120300-jkl.txt');
    await writeFile(p, HEADER + '\n\nbody\n', 'utf8');
    await backdate(p, 60);
    const r1 = await sealOrphanLogs(c);
    expect(r1.sealed).toContain(p);
    const r2 = await sealOrphanLogs(c);
    expect(r2.sealed).not.toContain(p);
    await rm(c, { recursive: true, force: true });
  });

  it('ignores non-.txt files', async () => {
    const c = await makeConception();
    const p = logPath(c, '120400-xyz.jsonl');
    await writeFile(p, '{"old":true}\n', 'utf8');
    await backdate(p, 60);
    const r = await sealOrphanLogs(c);
    expect(r.sealed).not.toContain(p);
    await rm(c, { recursive: true, force: true });
  });

  it('ignores files without a recognisable header (not a session log)', async () => {
    const c = await makeConception();
    const p = logPath(c, '120500-noheader.txt');
    await writeFile(p, 'just random text\nno header\n', 'utf8');
    await backdate(p, 60);
    const r = await sealOrphanLogs(c);
    expect(r.sealed).not.toContain(p);
    await rm(c, { recursive: true, force: true });
  });

  it('returns empty when the conception has no logs root', async () => {
    const c = await mkdtemp(join(tmpdir(), 'condash-seal-empty-'));
    const r = await sealOrphanLogs(c);
    expect(r).toEqual({ scanned: 0, sealed: [] });
    await rm(c, { recursive: true, force: true });
  });

  it('seals orphan task-run logs under .condash/scheduled/ and .condash/manual/', async () => {
    const c = await makeConception();
    const scheduled = join(c, '.condash/scheduled/my-task');
    const manual = join(c, '.condash/manual/other-task');
    await mkdir(scheduled, { recursive: true });
    await mkdir(manual, { recursive: true });
    const p1 = join(scheduled, '20260519-120000-t-abc.txt');
    const p2 = join(manual, '20260519-120100-t-def.txt');
    await writeFile(p1, HEADER + '\n\nkilled mid-run\n', 'utf8');
    await writeFile(p2, HEADER + '\n\nbody\n\n' + FOOTER_OK + '\n', 'utf8');
    await backdate(p1, 60);
    await backdate(p2, 60);
    const r = await sealOrphanLogs(c);
    expect(r.sealed).toContain(p1);
    expect(r.sealed).not.toContain(p2);
    const { footer } = splitContent(await readFile(p1, 'utf8'));
    expect(footer?.exitCode).toBeNull();
    expect(footer?.sealedByRecovery).toBe(true);
    await rm(c, { recursive: true, force: true });
  });

  it('tolerates a stray file where a task-run slug directory is expected', async () => {
    const c = await makeConception();
    await mkdir(join(c, '.condash/scheduled'), { recursive: true });
    await writeFile(join(c, '.condash/scheduled/not-a-dir.txt'), 'stray', 'utf8');
    await expect(sealOrphanLogs(c)).resolves.toBeTruthy();
    await rm(c, { recursive: true, force: true });
  });
});

describe('sealOrphanLogs — live sessions are never sealed (E4)', () => {
  it('skips a stale-looking log whose sid is still tracked live', async () => {
    // The sweep also runs on every conception re-pick; a quiet live tab is
    // stale by mtime but very much running — its log must stay footer-less.
    const c = await makeConception();
    const live = logPath(c, '140000-live.txt');
    const dead = logPath(c, '140100-dead.txt');
    // HEADER carries sid "abc" — mark that one live.
    await writeFile(live, HEADER + '\n\nquiet but running\n', 'utf8');
    await writeFile(dead, HEADER.replace('"sid":"abc"', '"sid":"def"') + '\n\ncrashed\n', 'utf8');
    await backdate(live, 60);
    await backdate(dead, 60);
    const r = await sealOrphanLogs(c, new Set(['abc']));
    expect(r.sealed).not.toContain(live);
    expect(r.sealed).toContain(dead);
    const { footer } = splitContent(await readFile(live, 'utf8'));
    expect(footer).toBeNull();
    await rm(c, { recursive: true, force: true });
  });

  it('seals the same log once the sid is no longer live', async () => {
    const c = await makeConception();
    const p = logPath(c, '140200-later.txt');
    await writeFile(p, HEADER + '\n\nbody\n', 'utf8');
    await backdate(p, 60);
    const r1 = await sealOrphanLogs(c, new Set(['abc']));
    expect(r1.sealed).not.toContain(p);
    const r2 = await sealOrphanLogs(c, new Set());
    expect(r2.sealed).toContain(p);
    await rm(c, { recursive: true, force: true });
  });
});

describe('sealOrphanLogs — tail-seal byte parity (B6)', () => {
  const expectedFooterSuffix = (mtimeMs: number, endsWithNewline: boolean): string =>
    (endsWithNewline ? '\n' : '\n\n') +
    '# condash: ' +
    JSON.stringify({
      finished: new Date(mtimeMs).toISOString(),
      exitCode: null,
      sealedByRecovery: true,
    }) +
    '\n';

  it('seals a large-body orphan by appending only the footer — body untouched, bytes identical to the full-read result', async () => {
    const c = await makeConception();
    const p = logPath(c, '130000-big.txt');
    // Body far larger than the 64 KB tail window: the whole-file read this fix
    // removes would have paid for all of it just to append a footer.
    const original = HEADER + '\n\n' + 'x'.repeat(200 * 1024) + '\nmore output\n';
    await writeFile(p, original, 'utf8');
    await backdate(p, 60);
    const st = await stat(p);
    const r = await sealOrphanLogs(c);
    expect(r.sealed).toContain(p);
    expect(await readFile(p, 'utf8')).toBe(original + expectedFooterSuffix(st.mtimeMs, true));
    await rm(c, { recursive: true, force: true });
  });

  it('prepends the missing newline when the orphan file does not end in one', async () => {
    const c = await makeConception();
    const p = logPath(c, '130100-nonl.txt');
    const original = HEADER + '\n\nno trailing newline'; // no '\n' at EOF
    await writeFile(p, original, 'utf8');
    await backdate(p, 60);
    const st = await stat(p);
    const r = await sealOrphanLogs(c);
    expect(r.sealed).toContain(p);
    expect(await readFile(p, 'utf8')).toBe(original + expectedFooterSuffix(st.mtimeMs, false));
    await rm(c, { recursive: true, force: true });
  });

  it('detects an existing footer past a huge body — the tail window still catches it', async () => {
    const c = await makeConception();
    const p = logPath(c, '130200-bigsealed.txt');
    const original = HEADER + '\n\n' + 'y'.repeat(200 * 1024) + '\n\n' + FOOTER_OK + '\n';
    await writeFile(p, original, 'utf8');
    await backdate(p, 60);
    const r = await sealOrphanLogs(c);
    expect(r.sealed).not.toContain(p);
    expect(await readFile(p, 'utf8')).toBe(original);
    await rm(c, { recursive: true, force: true });
  });
});
