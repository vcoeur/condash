/**
 * Logs IPC unit tests — exercises path-parsing + header/footer extraction.
 * The handlers under test are private; we capture them off a mocked
 * `ipcMain.handle` and call them directly.
 *
 * Approach: build a synthetic `.condash/logs/YYYY/MM/DD/<sid>.txt` tree
 * under a tmp dir, point `lastConceptionPath` at it via a mocked
 * `readSettings`, and invoke the handlers. Since v2.27.0 sessions are
 * one plain-text `.txt` per spawn carrying `# condash: {...}` header /
 * footer lines — no sidecar.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { condashLogsRoot } from '../condash-dir';
import { META_LINE_PREFIX } from '../terminal-logger';

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

let handlers: Record<string, (...args: any[]) => Promise<unknown>>;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

beforeEach(async () => {
  handlers = {};
  const { ipcMain } = await import('electron');
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

/** Compose a `.txt` from header + body (+ optional footer). Mirrors what
 * the writer produces on disk. */
function composeTxt(
  header: Record<string, unknown>,
  body: string,
  footer?: Record<string, unknown>,
): string {
  const lines: string[] = [`${META_LINE_PREFIX}${JSON.stringify(header)}`, ''];
  if (body.length > 0) lines.push(body);
  if (footer) lines.push('', `${META_LINE_PREFIX}${JSON.stringify(footer)}`);
  return lines.join('\n') + '\n';
}

/** Build a `<base>.txt` under `<conception>/.condash/logs/<day>/` carrying
 * a header (+ optional footer). Returns the absolute file path. */
function writeSession(
  day: string,
  hms: string,
  sid: string,
  body: string,
  header: Record<string, unknown>,
  footer?: Record<string, unknown>,
): string {
  const root = condashLogsRoot(tmp);
  const [y, m, d] = day.split('-');
  const dir = join(root, y, m, d);
  mkdirSync(dir, { recursive: true });
  const txtPath = join(dir, `${hms}-${sid}.txt`);
  writeFileSync(txtPath, composeTxt({ sid, ...header }, body, footer));
  return txtPath;
}

/** Create `<logsRoot>/YYYY/MM/DD/escape.txt` as a symlink pointing at
 *  `<conception>/outside-secret.txt` — a target inside the conception but
 *  outside the logs root — and write the target. Returns the symlink path,
 *  or `null` when the host can't create symlinks (the rejection is then
 *  untestable and the caller skips). */
function createEscapingSymlink(day: string): string | null {
  const [y, m, d] = day.split('-');
  const dir = join(condashLogsRoot(tmp), y, m, d);
  mkdirSync(dir, { recursive: true });
  const target = join(tmp, 'outside-secret.txt');
  writeFileSync(target, 'secret body\n');
  const link = join(dir, 'escape.txt');
  try {
    symlinkSync(target, link);
  } catch {
    return null;
  }
  return link;
}

describe('logsListDays', () => {
  it('returns empty when no logs exist', async () => {
    const result = await handlers.logsListDays(trustedEvent);
    expect(result).toEqual([]);
  });

  it('lists all YYYY/MM/DD dirs newest first', async () => {
    writeSession('2026-05-13', '142207', 't-aaa', 'x', {});
    writeSession('2026-05-10', '093001', 't-bbb', 'x', {});
    writeSession('2026-04-30', '180000', 't-ccc', 'x', {});
    const result = (await handlers.logsListDays(trustedEvent)) as { day: string }[];
    expect(result.map((r) => r.day)).toEqual(['2026-05-13', '2026-05-10', '2026-04-30']);
  });

  it('skips day directories that contain no .txt files', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '04', '01'), { recursive: true });
    writeFileSync(join(root, '2026', '04', '01', '142207-t-x.jsonl'), '{}\n');
    writeSession('2026-05-13', '142207', 't-y', 'x', {});
    const result = (await handlers.logsListDays(trustedEvent)) as { day: string }[];
    expect(result.map((r) => r.day)).toEqual(['2026-05-13']);
  });

  it('reports the per-day .txt session count', async () => {
    writeSession('2026-05-13', '142207', 't-aaa', 'x', {});
    writeSession('2026-05-13', '093001', 't-bbb', 'x', {});
    writeSession('2026-05-10', '180000', 't-ccc', 'x', {});
    const result = (await handlers.logsListDays(trustedEvent)) as {
      day: string;
      sessions: number;
    }[];
    const byDay = Object.fromEntries(result.map((r) => [r.day, r.sessions]));
    expect(byDay['2026-05-13']).toBe(2);
    expect(byDay['2026-05-10']).toBe(1);
  });
});

describe('logsListSessions', () => {
  it('rejects malformed day strings', async () => {
    await expect(handlers.logsListSessions(trustedEvent, 'not-a-day')).rejects.toThrow(
      /invalid day/,
    );
  });

  it('returns per-session metadata parsed from header + footer, most recent first', async () => {
    writeSession(
      '2026-05-13',
      '142207',
      't-aaa',
      'first body',
      { side: 'my', cmd: '/bin/bash', argv: ['-l'], cwd: '/home/alice' },
      // No footer — still running.
    );
    writeSession(
      '2026-05-13',
      '093001',
      't-bbb',
      'second body',
      { side: 'code', cmd: 'make', argv: ['dev'], repo: 'condash', cwd: '/home/alice/condash' },
      { finished: '2026-05-13T09:30:42Z', exitCode: 0 },
    );
    const result = (await handlers.logsListSessions(trustedEvent, '2026-05-13')) as Array<{
      sid: string;
      time: string;
      repo?: string;
      exitCode?: number;
      cmd?: string;
    }>;
    expect(result.map((r) => r.sid)).toEqual(['t-aaa', 't-bbb']); // 14:22 before 09:30 — most recent first
    expect(result[0].exitCode).toBeUndefined(); // 14:22 still running
    expect(result[1].repo).toBe('condash');
    expect(result[1].exitCode).toBe(0);
    expect(result[1].cmd).toBe('make dev');
  });

  it('returns an empty list for an empty day', async () => {
    const result = await handlers.logsListSessions(trustedEvent, '2026-05-13');
    expect(result).toEqual([]);
  });

  it('lists every session most-recent-first across a busy day (bounded pool)', async () => {
    // More files than the per-listing concurrency pool (32) so the read spans
    // multiple waves — confirms the parallelized walk drops nothing and keeps
    // the time-descending order.
    const expected: string[] = [];
    for (let i = 0; i < 40; i++) {
      const mm = String(i % 60).padStart(2, '0');
      const sid = `t-${String(i).padStart(3, '0')}`;
      writeSession('2026-05-13', `09${mm}00`, sid, 'x', {});
      expected.push(sid);
    }
    expected.reverse(); // most recent (largest HHMMSS) first
    const result = (await handlers.logsListSessions(trustedEvent, '2026-05-13')) as Array<{
      sid: string;
    }>;
    expect(result.map((r) => r.sid)).toEqual(expected);
  });

  it('ignores .jsonl files even when they share a directory with .txt files', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '05', '13'), { recursive: true });
    writeFileSync(join(root, '2026', '05', '13', '142207-t-legacy.jsonl'), '{}\n');
    writeSession('2026-05-13', '142208', 't-modern', 'x', {});
    const result = (await handlers.logsListSessions(trustedEvent, '2026-05-13')) as Array<{
      sid: string;
    }>;
    expect(result.map((r) => r.sid)).toEqual(['t-modern']);
  });

  it('handles a `.txt` that has no `# condash:` header gracefully', async () => {
    // Legacy file shape (or hand-written test artefact) — listing should
    // surface it with sid derived from the filename and no extra meta.
    const root = condashLogsRoot(tmp);
    const dir = join(root, '2026', '05', '13');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '142207-t-bare.txt'), 'just text, no header\n');
    const result = (await handlers.logsListSessions(trustedEvent, '2026-05-13')) as Array<{
      sid: string;
      cmd?: string;
    }>;
    expect(result[0].sid).toBe('t-bare');
    expect(result[0].cmd).toBeUndefined();
  });
});

describe('logsReadSession', () => {
  it('returns the body stripped of header + footer, plus parsed meta', async () => {
    const file = writeSession(
      '2026-05-13',
      '142207',
      't-aaa',
      'hello rendered text',
      { side: 'my', cmd: '/bin/bash', argv: [], cwd: '/x' },
      { finished: '2026-05-13T14:22:42Z', exitCode: 0 },
    );
    const res = (await handlers.logsReadSession(trustedEvent, file)) as {
      text: string;
      meta: { sid: string; exitCode: number; cmd?: string } | null;
    };
    expect(res.text).toBe('hello rendered text');
    expect(res.meta?.sid).toBe('t-aaa');
    expect(res.meta?.exitCode).toBe(0);
    expect(res.meta?.cmd).toBe('/bin/bash');
  });

  it('returns body alone when only a header is present (in-flight session)', async () => {
    const file = writeSession('2026-05-13', '142207', 't-live', 'in-flight body', {
      side: 'my',
      cmd: 'bash',
      argv: [],
      cwd: '/x',
    });
    const res = (await handlers.logsReadSession(trustedEvent, file)) as {
      text: string;
      meta: { sid: string; exitCode?: number } | null;
    };
    expect(res.text).toBe('in-flight body');
    expect(res.meta?.exitCode).toBeUndefined();
  });

  it('rejects files outside the logs root', async () => {
    await expect(handlers.logsReadSession(trustedEvent, '/etc/passwd')).rejects.toThrow();
  });

  it('rejects non-.txt files', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '05', '13'), { recursive: true });
    const jsonl = join(root, '2026', '05', '13', '142207-t-x.jsonl');
    writeFileSync(jsonl, '{}\n');
    await expect(handlers.logsReadSession(trustedEvent, jsonl)).rejects.toThrow();
  });

  it('operates on the bounded realpath', async () => {
    // A symlink INSIDE the logs root pointing OUTSIDE it: the bounds check
    // realpaths the request, so the escape resolves outside the root and is
    // rejected before any read — pin that the realpath is what downstream
    // code runs on (a regression to the raw renderer path would silently
    // read the secret target).
    const link = createEscapingSymlink('2026-08-04');
    if (!link) return; // host can't create symlinks — happy path covered below
    await expect(handlers.logsReadSession(trustedEvent, link)).rejects.toThrow(
      /path is outside the conception tree/,
    );
  });

  it('reads content through the resolved realpath', async () => {
    const file = writeSession('2026-08-04', '120000', 't-abc', 'rendered transcript body', {
      side: 'my',
      cmd: '/bin/sh',
      argv: [],
      cwd: '/tmp',
    });
    const res = (await handlers.logsReadSession(trustedEvent, file)) as {
      text: string;
      meta: { sid: string; cmd: string } | null;
    };
    expect(res.text).toBe('rendered transcript body');
    expect(res.meta?.sid).toBe('t-abc');
    expect(res.meta?.cmd).toBe('/bin/sh');
  });

  it('returns an empty body only for a missing file, and rethrows other read errors', async () => {
    // ENOENT half: the file exists when the realpath bounds-check runs but the
    // read then fails with ENOENT (the deletion race the handler tolerates) —
    // pin that this surfaces as an empty body rather than an error.
    const gone = writeSession('2026-08-04', '120000', 't-gone', 'body', {});
    const readFileSpy = vi
      .spyOn(fsPromises, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    try {
      const res = (await handlers.logsReadSession(trustedEvent, gone)) as { text: string };
      expect(res.text).toBe('');
    } finally {
      readFileSpy.mockRestore();
    }

    // Rethrow half: a non-ENOENT read error (EACCES via chmod 000) propagates
    // instead of silently rendering an empty transcript. chmod 000 is
    // ineffective for root, so the assertion only holds as a regular user.
    if (process.getuid?.() === 0) return;
    const locked = writeSession('2026-08-04', '120100', 't-locked', 'body', {});
    chmodSync(locked, 0o000);
    try {
      await expect(handlers.logsReadSession(trustedEvent, locked)).rejects.toThrow();
    } finally {
      chmodSync(locked, 0o644);
    }
  });
});

describe('logsDeleteDay', () => {
  it('removes the whole day-directory', async () => {
    writeSession('2026-05-13', '142207', 't-a', 'x', {});
    writeSession('2026-05-13', '152200', 't-b', 'x', {});
    const result = (await handlers.logsDeleteDay(trustedEvent, '2026-05-13')) as {
      deleted: boolean;
    };
    expect(result.deleted).toBe(true);
    const days = (await handlers.logsListDays(trustedEvent)) as unknown[];
    expect(days).toEqual([]);
  });
});

describe('logsDeleteSession', () => {
  it('removes the .txt', async () => {
    const file = writeSession('2026-05-13', '142207', 't-a', 'x', {});
    writeSession('2026-05-13', '152200', 't-b', 'x', {});
    const result = (await handlers.logsDeleteSession(trustedEvent, file)) as { deleted: boolean };
    expect(result.deleted).toBe(true);
    const sessions = (await handlers.logsListSessions(trustedEvent, '2026-05-13')) as {
      sid: string;
    }[];
    expect(sessions.map((s) => s.sid)).toEqual(['t-b']);
  });

  it('rejects paths outside the logs root', async () => {
    await expect(handlers.logsDeleteSession(trustedEvent, '/etc/passwd')).rejects.toThrow();
  });

  it('rejects non-.txt files even inside the logs root', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '05', '13'), { recursive: true });
    const jsonl = join(root, '2026', '05', '13', '142207-t-x.jsonl');
    writeFileSync(jsonl, '{}\n');
    await expect(handlers.logsDeleteSession(trustedEvent, jsonl)).rejects.toThrow();
  });

  it('refuses a symlink escaping the logs root', async () => {
    const link = createEscapingSymlink('2026-08-04');
    if (!link) return; // host can't create symlinks
    await expect(handlers.logsDeleteSession(trustedEvent, link)).rejects.toThrow(
      /path is outside the conception tree/,
    );
    // The escape target must be untouched — the delete never ran.
    expect(existsSync(join(tmp, 'outside-secret.txt'))).toBe(true);
  });
});
