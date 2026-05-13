import { ipcMain } from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TermLogEvent, TermLogSessionMeta } from '../../shared/types';
import { canonicalizeInput, canonicalizeOutput } from '../../shared/canonical-input';
import { condashLogsRoot } from '../condash-dir';
import { requirePathUnder } from '../path-bounds';
import { readSettings } from '../settings';

// `requirePathUnder` is only used for `logsReadEvents` — for the day-level
// handlers the strict regex on `day` guarantees the resulting path is
// under the logs root by construction.

/**
 * IPC surface for the Logs pane: list available day-directories under
 * `<conception>/.condash/logs/`, list per-session files for one day,
 * and stream events from a chosen file.
 *
 * Every `path` argument is bounded inside the conception's logs root via
 * `requirePathUnder` — defence-in-depth against a compromised renderer
 * passing `/etc/passwd` or `../../foo`.
 */
export function registerLogsIpc(): void {
  ipcMain.handle('logsListDays', async () => listDaysForActiveConception());
  ipcMain.handle('logsListSessions', async (_e, day: string) => listSessionsForDay(day));
  ipcMain.handle('logsReadEvents', async (_e, filePath: string, offset?: number, limit?: number) =>
    readEvents(filePath, offset, limit),
  );
  ipcMain.handle('logsDeleteDay', async (_e, day: string) => deleteDay(day));
  ipcMain.handle('logsDeleteSession', async (_e, filePath: string) => deleteSession(filePath));
}

interface DayEntry {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Path to the day directory. */
  path: string;
}

async function activeConceptionPath(): Promise<string | null> {
  const settings = await readSettings();
  return settings.lastConceptionPath ?? null;
}

async function listDaysForActiveConception(): Promise<DayEntry[]> {
  const conception = await activeConceptionPath();
  if (!conception) return [];
  const root = condashLogsRoot(conception);
  const out: DayEntry[] = [];
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
        out.push({ day: `${y}-${m}-${d}`, path: join(monthPath, d) });
      }
    }
  }
  // Newest day first — the most common query.
  out.sort((a, b) => (a.day < b.day ? 1 : -1));
  return out;
}

async function listSessionsForDay(day: string): Promise<TermLogSessionMeta[]> {
  const conception = await activeConceptionPath();
  if (!conception) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`logsListSessions: invalid day '${day}'`);
  }
  // The day string is strictly validated above — the resulting path is
  // always under condashLogsRoot(conception) by construction, so the
  // realpath bounds-check (which would also reject not-yet-created day
  // dirs) is unnecessary here.
  const [y, m, d] = day.split('-');
  const dayPath = join(condashLogsRoot(conception), y, m, d);

  const files = await readDirSafe(dayPath);
  const metas: TermLogSessionMeta[] = [];
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    const fullPath = join(dayPath, name);
    const meta = await readSessionMeta(fullPath, day, name);
    if (meta) metas.push(meta);
  }
  // Sort by HHMMSS — chronological within a day.
  metas.sort((a, b) => (a.time < b.time ? -1 : 1));
  return metas;
}

async function readSessionMeta(
  filePath: string,
  day: string,
  fileName: string,
): Promise<TermLogSessionMeta | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  // Parse `HHMMSS-<sid>.jsonl` (rotation suffix `.2.jsonl` adds before the
  // final `.jsonl`). The session id is everything between the first `-`
  // and the leading `.jsonl` / `.<n>.jsonl`.
  const m = /^(\d{6})-(.+?)(?:\.\d+)?\.jsonl$/.exec(fileName);
  if (!m) return null;
  const [, hms, sid] = m;
  const time = `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;

  // Read the first few events for spawn metadata + scan tail for exit.
  let head = '';
  try {
    const fh = await fs.open(filePath, 'r');
    try {
      // 16 KB head: ample for the spawn event + a few output lines.
      const headBuf = Buffer.alloc(16 * 1024);
      const { bytesRead } = await fh.read(headBuf, 0, headBuf.length, 0);
      head = headBuf.slice(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  const lines = head.split('\n').filter((l) => l.length > 0);
  let cmd: string | undefined;
  let repo: string | undefined;
  let cwd: string | undefined;
  let exitCode: number | undefined;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as Partial<TermLogEvent>;
      if (ev.kind === 'spawn') {
        if (typeof ev.cmd === 'string') {
          cmd = Array.isArray(ev.argv) ? [ev.cmd, ...ev.argv].join(' ') : ev.cmd;
        }
        if (typeof ev.repo === 'string') repo = ev.repo;
        if (typeof ev.cwd === 'string') cwd = ev.cwd;
      } else if (ev.kind === 'exit' && typeof ev.exitCode === 'number') {
        exitCode = ev.exitCode;
      }
    } catch {
      /* malformed line; skip */
    }
  }
  return {
    path: filePath,
    day,
    time,
    bytes: stat.size,
    sid,
    repo,
    cwd,
    cmd,
    exitCode,
  };
}

async function readEvents(filePath: string, offset = 0, limit = 1000): Promise<TermLogEvent[]> {
  const conception = await activeConceptionPath();
  if (!conception) return [];
  await requirePathUnder(filePath, condashLogsRoot(conception));
  if (!filePath.endsWith('.jsonl')) {
    throw new Error('logsReadEvents: only .jsonl files');
  }
  return readEventsStreaming(filePath, offset, limit);
}

/**
 * Stream a JSONL session file line-by-line and return the `offset`-th
 * through `offset+limit-1` events. Earlier versions did `fs.readFile +
 * split('\n')` which allocated the whole file (a real-world 2.3 MB log
 * triggered a multi-megabyte string + a 9000-element array) just to grab
 * the first few thousand records. Streaming caps memory at the read-stream
 * buffer plus the `limit`-sized output array.
 *
 * Also enriches `in` / `out` events with a `text` field — see
 * `canonicalize{Input,Output}` for the rules. The on-disk JSONL is kept
 * raw so the file remains a faithful pty capture; search and display
 * consume `text`.
 */
function readEventsStreaming(
  filePath: string,
  offset: number,
  limit: number,
): Promise<TermLogEvent[]> {
  return new Promise<TermLogEvent[]>((resolve) => {
    const out: TermLogEvent[] = [];
    let lineIdx = 0;
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    stream.on('error', () => resolve(out));
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const finish = (): void => {
      rl.removeAllListeners();
      stream.destroy();
      resolve(out);
    };
    rl.on('line', (line) => {
      if (line.length === 0) return;
      if (lineIdx >= offset && out.length < limit) {
        try {
          const ev = JSON.parse(line) as TermLogEvent;
          enrichEventText(ev);
          out.push(ev);
        } catch {
          /* skip malformed */
        }
      }
      lineIdx += 1;
      if (out.length >= limit) finish();
    });
    rl.on('close', finish);
  });
}

function enrichEventText(ev: TermLogEvent): void {
  if (typeof ev.data !== 'string') return;
  if (ev.kind === 'in') ev.text = canonicalizeInput(ev.data);
  else if (ev.kind === 'out') ev.text = canonicalizeOutput(ev.data);
}

async function deleteSession(filePath: string): Promise<{ deleted: boolean }> {
  const conception = await activeConceptionPath();
  if (!conception) return { deleted: false };
  // Bounds-check first so a malicious renderer can't escape the logs root
  // by passing `/etc/passwd` or `..`. `requirePathUnder` resolves symlinks
  // and rejects anything outside the root.
  await requirePathUnder(filePath, condashLogsRoot(conception));
  if (!filePath.endsWith('.jsonl')) {
    throw new Error('logsDeleteSession: only .jsonl files');
  }
  try {
    await fs.rm(filePath, { force: true });
    return { deleted: true };
  } catch {
    return { deleted: false };
  }
}

async function deleteDay(day: string): Promise<{ deleted: boolean }> {
  const conception = await activeConceptionPath();
  if (!conception) return { deleted: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`logsDeleteDay: invalid day '${day}'`);
  }
  // Same construction-bounds argument as listSessionsForDay — the regex
  // validation prevents `..` / absolute-path escape via `day`.
  const [y, m, d] = day.split('-');
  const dayPath = join(condashLogsRoot(conception), y, m, d);
  try {
    await fs.rm(dayPath, { recursive: true, force: true });
    return { deleted: true };
  } catch {
    return { deleted: false };
  }
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
