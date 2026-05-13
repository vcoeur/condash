/**
 * Logs IPC unit tests — exercises the path-parsing + meta-extraction
 * branches directly. The IPC dispatch layer (`ipcMain.handle`) is
 * thin enough that the playwright tests will cover end-to-end behaviour.
 *
 * The handlers under test are private; we test them through the public
 * surface exposed by the module by mocking `readSettings` to return a
 * temp conception path, then invoking via a direct call.
 *
 * Approach: build a synthetic `.condash/logs/YYYY/MM/DD/<file>.jsonl`
 * tree under a tmp dir, point `lastConceptionPath` at it via a mocked
 * `readSettings`, and invoke the handlers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Pull in the IPC module — it imports the mocked `electron` and
// `readSettings`. We re-import the handler implementations via the
// module's internals by re-registering them; instead, re-export the
// internal helpers directly via a thin wrapper here.

// Because the handlers are local fns, easiest path: invoke them through
// the registration call + capture the handlers off the mocked ipcMain.

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

function writeLogFile(day: string, fileName: string, lines: object[]): string {
  const root = condashLogsRoot(tmp);
  const [y, m, d] = day.split('-');
  const dir = join(root, y, m, d);
  mkdirSync(dir, { recursive: true });
  const fullPath = join(dir, fileName);
  writeFileSync(fullPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return fullPath;
}

describe('logsListDays', () => {
  it('returns empty when no logs exist', async () => {
    const result = await handlers.logsListDays();
    expect(result).toEqual([]);
  });

  it('lists all YYYY/MM/DD dirs newest first', async () => {
    writeLogFile('2026-05-13', '142207-t-aaa.jsonl', [{ kind: 'spawn' }]);
    writeLogFile('2026-05-10', '093001-t-bbb.jsonl', [{ kind: 'spawn' }]);
    writeLogFile('2026-04-30', '180000-t-ccc.jsonl', [{ kind: 'spawn' }]);
    const result = (await handlers.logsListDays()) as { day: string }[];
    expect(result.map((r) => r.day)).toEqual(['2026-05-13', '2026-05-10', '2026-04-30']);
  });

  it('skips non-numeric directory names', async () => {
    writeLogFile('2026-05-13', 'x.jsonl', [{ kind: 'spawn' }]);
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'readme.md'), 'x');
    const result = (await handlers.logsListDays()) as { day: string }[];
    expect(result.map((r) => r.day)).toEqual(['2026-05-13']);
  });
});

describe('logsListSessions', () => {
  it('rejects malformed day strings', async () => {
    await expect(handlers.logsListSessions({}, 'not-a-day')).rejects.toThrow(/invalid day/);
  });

  it('returns per-session metadata sorted by time', async () => {
    writeLogFile('2026-05-13', '142207-t-aaa.jsonl', [
      {
        ts: '2026-05-13T14:22:07.341Z',
        sid: 't-aaa',
        side: 'my',
        kind: 'spawn',
        cmd: '/bin/bash',
        argv: ['-l'],
        cwd: '/home/alice',
      },
    ]);
    writeLogFile('2026-05-13', '093001-t-bbb.jsonl', [
      {
        ts: '2026-05-13T09:30:01.000Z',
        sid: 't-bbb',
        side: 'code',
        kind: 'spawn',
        cmd: 'make',
        argv: ['dev'],
        repo: 'condash',
        cwd: '/home/alice/condash',
      },
      { ts: '2026-05-13T09:35:02.000Z', sid: 't-bbb', side: 'code', kind: 'exit', exitCode: 0 },
    ]);
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
});

describe('logsReadEvents', () => {
  it('paginates with offset + limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      ts: `2026-05-13T14:22:0${i}.000Z`,
      sid: 't-x',
      side: 'my',
      kind: 'out',
      data: `line ${i}`,
    }));
    const file = writeLogFile('2026-05-13', '142207-t-x.jsonl', lines);
    const page1 = (await handlers.logsReadEvents({}, file, 0, 5)) as { data: string }[];
    expect(page1.map((e) => e.data)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
    const page2 = (await handlers.logsReadEvents({}, file, 5, 5)) as { data: string }[];
    expect(page2.map((e) => e.data)).toEqual(['line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
  });

  it('rejects files outside the logs root', async () => {
    await expect(handlers.logsReadEvents({}, '/etc/passwd', 0, 100)).rejects.toThrow();
  });

  it('rejects non-jsonl files', async () => {
    const file = writeLogFile('2026-05-13', '142207-t-y.jsonl', [{ kind: 'spawn' }]);
    const txt = file.replace(/\.jsonl$/, '.txt');
    writeFileSync(txt, 'hi');
    await expect(handlers.logsReadEvents({}, txt, 0, 100)).rejects.toThrow();
  });

  it('enriches in/out events with a canonical `text` field', async () => {
    const file = writeLogFile('2026-05-13', '142207-t-canon.jsonl', [
      { ts: 'a', sid: 't-canon', side: 'my', kind: 'spawn', cmd: 'bash', argv: [] },
      // Typed `gi<BS>it push\r` (backspaced after typing `gi`, then typed
      // `it push`). Canonical form: `git push\r`.
      { ts: 'b', sid: 't-canon', side: 'my', kind: 'in', data: 'gi\bit push\r' },
      // Output bytes with ANSI colour + trailing CR (no LF).
      { ts: 'c', sid: 't-canon', side: 'my', kind: 'out', data: '\x1b[31merror\x1b[0m\r' },
    ]);
    const events = (await handlers.logsReadEvents({}, file, 0, 100)) as Array<{
      kind: string;
      text?: string;
    }>;
    const inEv = events.find((e) => e.kind === 'in');
    const outEv = events.find((e) => e.kind === 'out');
    expect(inEv?.text).toBe('git push\r');
    expect(outEv?.text).toBe('error');
  });
});

describe('logsDeleteDay', () => {
  it('removes the whole day-directory', async () => {
    writeLogFile('2026-05-13', '142207-t-a.jsonl', [{ kind: 'spawn' }]);
    writeLogFile('2026-05-13', '152200-t-b.jsonl', [{ kind: 'spawn' }]);
    const result = (await handlers.logsDeleteDay({}, '2026-05-13')) as { deleted: boolean };
    expect(result.deleted).toBe(true);
    const days = (await handlers.logsListDays()) as unknown[];
    expect(days).toEqual([]);
  });
});

describe('logsDeleteSession', () => {
  it('removes a single session file', async () => {
    const file = writeLogFile('2026-05-13', '142207-t-a.jsonl', [{ kind: 'spawn' }]);
    writeLogFile('2026-05-13', '152200-t-b.jsonl', [{ kind: 'spawn' }]);
    const result = (await handlers.logsDeleteSession({}, file)) as { deleted: boolean };
    expect(result.deleted).toBe(true);
    const sessions = (await handlers.logsListSessions({}, '2026-05-13')) as { path: string }[];
    expect(sessions.map((s) => s.path)).toEqual([
      join(condashLogsRoot(tmp), '2026', '05', '13', '152200-t-b.jsonl'),
    ]);
  });

  it('rejects paths outside the logs root', async () => {
    await expect(handlers.logsDeleteSession({}, '/etc/passwd')).rejects.toThrow();
  });

  it('rejects non-jsonl files even inside the logs root', async () => {
    const root = condashLogsRoot(tmp);
    mkdirSync(join(root, '2026', '05', '13'), { recursive: true });
    const txt = join(root, '2026', '05', '13', 'note.txt');
    writeFileSync(txt, 'hello');
    await expect(handlers.logsDeleteSession({}, txt)).rejects.toThrow();
  });
});
