/**
 * Logs IPC unit tests — exercises path-parsing + meta-extraction. The
 * handlers under test are private; we capture them off a mocked
 * `ipcMain.handle` and call them directly.
 *
 * Approach: build a synthetic `.condash/logs/YYYY/MM/DD/<sid>.{txt,meta.json}`
 * tree under a tmp dir, point `lastConceptionPath` at it via a mocked
 * `readSettings`, and invoke the handlers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { condashLogsRoot } from '../condash-dir';

vi.mock('../settings', async () => {
  const actual = await vi.importActual<typeof import('../settings')>('../settings');
  return {
    ...actual,
    readSettings: vi.fn(async () => ({
      lastConceptionPath: (globalThis as { __testConception?: string }).__testConception ?? null,
    })),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/electron-app' },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handlers: Record<string, (...args: any[]) => Promise<unknown>>;

beforeEach(async () => {
  handlers = {};
  const { ipcMain } = await import('electron');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );
  const { registerLogsIpc } = await import('./logs');
  registerLogsIpc();
});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-logs-ipc-'));
  (globalThis as { __testConception?: string }).__testConception = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete (globalThis as { __testConception?: string }).__testConception;
});

/** Build a `<base>.txt` + `<base>.meta.json` pair under `<conception>/.condash/logs/<day>/`. */
function writeSession(
  day: string,
  hms: string,
  sid: string,
  body: string,
  meta: Record<string, unknown>,
): string {
  const root = condashLogsRoot(tmp);
  const [y, m, d] = day.split('-');
  const dir = join(root, y, m, d);
  mkdirSync(dir, { recursive: true });
  const txtPath = join(dir, `${hms}-${sid}.txt`);
  const metaPath = join(dir, `${hms}-${sid}.meta.json`);
  writeFileSync(txtPath, body);
  writeFileSync(metaPath, JSON.stringify(meta));
  return txtPath;
}

/** Same shape, but pre-compressed (`.txt.gz`) — mirrors the post-janitor
 * on-disk state for older day-dirs. */
function writeCompressedSession(
  day: string,
  hms: string,
  sid: string,
  body: string,
  meta: Record<string, unknown>,
): string {
  const root = condashLogsRoot(tmp);
  const [y, m, d] = day.split('-');
  const dir = join(root, y, m, d);
  mkdirSync(dir, { recursive: true });
  const gzPath = join(dir, `${hms}-${sid}.txt.gz`);
  const metaPath = join(dir, `${hms}-${sid}.meta.json`);
  writeFileSync(gzPath, gzipSync(Buffer.from(body, 'utf8')));
  writeFileSync(metaPath, JSON.stringify(meta));
  return gzPath;
}

describe('logsListDays', () => {
  it('returns empty when no logs exist', async () => {
    const result = await handlers.logsListDays();
    expect(result).toEqual([]);
  });

  it('lists all YYYY/MM/DD dirs newest first', async () => {
    writeSession('2026-05-13', '142207', 't-aaa', 'x', { sid: 't-aaa' });
    writeSession('2026-05-10', '093001', 't-bbb', 'x', { sid: 't-bbb' });
    writeSession('2026-04-30', '180000', 't-ccc', 'x', { sid: 't-ccc' });
    const result = (await handlers.logsListDays()) as { day: string }[];
    expect(result.map((r) => r.day)).toEqual(['2026-05-13', '2026-05-10', '2026-04-30']);
  });

  it('skips day directories that contain no .txt files', async () => {
    // Day dir with only a legacy .jsonl should be skipped — the viewer
    // ignores `.jsonl` entirely.
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '04', '01'), { recursive: true });
    writeFileSync(join(root, '2026', '04', '01', '142207-t-x.jsonl'), '{}\n');
    writeSession('2026-05-13', '142207', 't-y', 'x', { sid: 't-y' });
    const result = (await handlers.logsListDays()) as { day: string }[];
    expect(result.map((r) => r.day)).toEqual(['2026-05-13']);
  });
});

describe('logsListSessions', () => {
  it('rejects malformed day strings', async () => {
    await expect(handlers.logsListSessions({}, 'not-a-day')).rejects.toThrow(/invalid day/);
  });

  it('returns per-session metadata sorted by time', async () => {
    writeSession('2026-05-13', '142207', 't-aaa', 'first', {
      sid: 't-aaa',
      side: 'my',
      cmd: '/bin/bash',
      argv: ['-l'],
      cwd: '/home/alice',
    });
    writeSession('2026-05-13', '093001', 't-bbb', 'second', {
      sid: 't-bbb',
      side: 'code',
      cmd: 'make',
      argv: ['dev'],
      repo: 'condash',
      cwd: '/home/alice/condash',
      exitCode: 0,
    });
    const result = (await handlers.logsListSessions({}, '2026-05-13')) as Array<{
      sid: string;
      time: string;
      repo?: string;
      exitCode?: number;
      cmd?: string;
    }>;
    expect(result.map((r) => r.sid)).toEqual(['t-bbb', 't-aaa']); // 09:30 before 14:22
    expect(result[0].repo).toBe('condash');
    expect(result[0].exitCode).toBe(0);
    expect(result[0].cmd).toBe('make dev');
    expect(result[1].exitCode).toBeUndefined(); // still running
  });

  it('returns an empty list for an empty day', async () => {
    const result = await handlers.logsListSessions({}, '2026-05-13');
    expect(result).toEqual([]);
  });

  it('ignores .jsonl files even when they share a directory with .txt files', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '05', '13'), { recursive: true });
    writeFileSync(join(root, '2026', '05', '13', '142207-t-legacy.jsonl'), '{}\n');
    writeSession('2026-05-13', '142208', 't-modern', 'x', { sid: 't-modern' });
    const result = (await handlers.logsListSessions({}, '2026-05-13')) as Array<{ sid: string }>;
    expect(result.map((r) => r.sid)).toEqual(['t-modern']);
  });
});

describe('logsReadSession', () => {
  it('returns the .txt body + parsed sidecar meta', async () => {
    const file = writeSession('2026-05-13', '142207', 't-aaa', 'hello rendered text', {
      sid: 't-aaa',
      side: 'my',
      cmd: '/bin/bash',
      argv: [],
      cwd: '/x',
      exitCode: 0,
    });
    const res = (await handlers.logsReadSession({}, file)) as {
      text: string;
      meta: { sid: string; exitCode: number } | null;
    };
    expect(res.text).toBe('hello rendered text');
    expect(res.meta?.sid).toBe('t-aaa');
    expect(res.meta?.exitCode).toBe(0);
  });

  it('rejects files outside the logs root', async () => {
    await expect(handlers.logsReadSession({}, '/etc/passwd')).rejects.toThrow();
  });

  it('rejects non-.txt files', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '05', '13'), { recursive: true });
    const jsonl = join(root, '2026', '05', '13', '142207-t-x.jsonl');
    writeFileSync(jsonl, '{}\n');
    await expect(handlers.logsReadSession({}, jsonl)).rejects.toThrow();
  });

  it('transparently decompresses .txt.gz sessions', async () => {
    const gz = writeCompressedSession('2026-05-13', '142207', 't-gz', 'compressed body', {
      sid: 't-gz',
      side: 'my',
      cmd: 'bash',
      argv: [],
      cwd: '/x',
    });
    const res = (await handlers.logsReadSession({}, gz)) as {
      text: string;
      meta: { sid: string } | null;
    };
    expect(res.text).toBe('compressed body');
    expect(res.meta?.sid).toBe('t-gz');
  });

  it('listSessions surfaces .txt.gz alongside .txt entries', async () => {
    writeSession('2026-05-13', '093001', 't-live', 'live body', { sid: 't-live' });
    writeCompressedSession('2026-05-13', '142207', 't-gz', 'compressed body', { sid: 't-gz' });
    const result = (await handlers.logsListSessions({}, '2026-05-13')) as Array<{
      sid: string;
      path: string;
    }>;
    expect(result.map((r) => r.sid)).toEqual(['t-live', 't-gz']);
    expect(result[1].path.endsWith('.txt.gz')).toBe(true);
  });
});

describe('logsDeleteDay', () => {
  it('removes the whole day-directory', async () => {
    writeSession('2026-05-13', '142207', 't-a', 'x', { sid: 't-a' });
    writeSession('2026-05-13', '152200', 't-b', 'x', { sid: 't-b' });
    const result = (await handlers.logsDeleteDay({}, '2026-05-13')) as { deleted: boolean };
    expect(result.deleted).toBe(true);
    const days = (await handlers.logsListDays()) as unknown[];
    expect(days).toEqual([]);
  });
});

describe('logsDeleteSession', () => {
  it('removes both the .txt and the sidecar .meta.json', async () => {
    const file = writeSession('2026-05-13', '142207', 't-a', 'x', { sid: 't-a' });
    writeSession('2026-05-13', '152200', 't-b', 'x', { sid: 't-b' });
    const result = (await handlers.logsDeleteSession({}, file)) as { deleted: boolean };
    expect(result.deleted).toBe(true);
    const sessions = (await handlers.logsListSessions({}, '2026-05-13')) as { sid: string }[];
    expect(sessions.map((s) => s.sid)).toEqual(['t-b']);
  });

  it('rejects paths outside the logs root', async () => {
    await expect(handlers.logsDeleteSession({}, '/etc/passwd')).rejects.toThrow();
  });

  it('rejects non-.txt files even inside the logs root', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '05', '13'), { recursive: true });
    const jsonl = join(root, '2026', '05', '13', '142207-t-x.jsonl');
    writeFileSync(jsonl, '{}\n');
    await expect(handlers.logsDeleteSession({}, jsonl)).rejects.toThrow();
  });

  it('removes the compressed body + sidecar when called with a .txt.gz path', async () => {
    const gz = writeCompressedSession('2026-05-13', '142207', 't-a', 'x', { sid: 't-a' });
    const meta = gz.replace(/\.txt\.gz$/, '.meta.json');
    expect(existsSync(meta)).toBe(true);
    const result = (await handlers.logsDeleteSession({}, gz)) as { deleted: boolean };
    expect(result.deleted).toBe(true);
    expect(existsSync(gz)).toBe(false);
    expect(existsSync(meta)).toBe(false);
  });
});
