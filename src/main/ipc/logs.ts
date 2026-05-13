import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { TermLogSessionMeta, TermLogSessionRead } from '../../shared/types';
import { sessionMetaPath } from '../terminal-logger';
import { condashLogsRoot } from '../condash-dir';
import { requirePathUnder } from '../path-bounds';
import { readSettings } from '../settings';

/**
 * IPC surface for the Logs pane: list available day-directories under
 * `<conception>/.condash/logs/`, list per-session `.txt` files for one
 * day, and read a chosen session's rendered text + sidecar metadata.
 *
 * Every `path` argument is bounded inside the conception's logs root via
 * `requirePathUnder` — defence-in-depth against a compromised renderer
 * passing `/etc/passwd` or `../../foo`.
 */
export function registerLogsIpc(): void {
  ipcMain.handle('logsListDays', async () => listDaysForActiveConception());
  ipcMain.handle('logsListSessions', async (_e, day: string) => listSessionsForDay(day));
  ipcMain.handle('logsReadSession', async (_e, filePath: string) => readSession(filePath));
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
        // Skip days that contain only legacy `.jsonl` files (no `.txt`).
        const dayPath = join(monthPath, d);
        const dayFiles = await readDirSafe(dayPath);
        if (!dayFiles.some((f) => f.endsWith('.txt'))) continue;
        out.push({ day: `${y}-${m}-${d}`, path: dayPath });
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
  const [y, m, d] = day.split('-');
  const dayPath = join(condashLogsRoot(conception), y, m, d);

  const files = await readDirSafe(dayPath);
  const metas: TermLogSessionMeta[] = [];
  for (const name of files) {
    if (!name.endsWith('.txt')) continue;
    const fullPath = join(dayPath, name);
    const meta = await readSessionMetaSummary(fullPath, day, name);
    if (meta) metas.push(meta);
  }
  // Sort by HHMMSS — chronological within a day.
  metas.sort((a, b) => (a.time < b.time ? -1 : 1));
  return metas;
}

async function readSessionMetaSummary(
  txtPath: string,
  day: string,
  fileName: string,
): Promise<TermLogSessionMeta | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(txtPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  // Parse `HHMMSS-<sid>.txt`.
  const m = /^(\d{6})-(.+?)\.txt$/.exec(fileName);
  if (!m) return null;
  const [, hms, sid] = m;
  const time = `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;

  const sidecar = await readMetaSidecar(sessionMetaPath(txtPath));

  return {
    path: txtPath,
    day,
    time,
    bytes: stat.size,
    sid: sidecar?.sid ?? sid,
    repo: sidecar?.repo,
    cwd: sidecar?.cwd,
    cmd: sidecar?.cmd
      ? sidecar.argv && sidecar.argv.length > 0
        ? [sidecar.cmd, ...sidecar.argv].join(' ')
        : sidecar.cmd
      : undefined,
    exitCode: sidecar?.exitCode,
  };
}

interface MetaSidecar {
  sid: string;
  side: string;
  repo?: string;
  cwd?: string;
  cmd?: string;
  argv?: string[];
  started?: string;
  exitCode?: number;
  finished?: string;
}

async function readMetaSidecar(metaPath: string): Promise<MetaSidecar | null> {
  try {
    const text = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(text) as MetaSidecar;
  } catch {
    return null;
  }
}

async function readSession(filePath: string): Promise<TermLogSessionRead> {
  const conception = await activeConceptionPath();
  if (!conception) return { text: '', meta: null };
  await requirePathUnder(filePath, condashLogsRoot(conception));
  if (!filePath.endsWith('.txt')) {
    throw new Error('logsReadSession: only .txt files');
  }
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    /* missing file → empty body */
  }
  // Derive the on-disk session meta from the same path-based machinery
  // the list flow uses, then return both halves.
  const day = deriveDay(filePath);
  const fileName = filePath.split('/').pop() ?? '';
  const meta = day ? await readSessionMetaSummary(filePath, day, fileName) : null;
  return { text, meta };
}

function deriveDay(filePath: string): string | null {
  // <root>/YYYY/MM/DD/HHMMSS-<sid>.txt
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/\d{6}-[^/]+\.txt$/.exec(filePath);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function deleteSession(filePath: string): Promise<{ deleted: boolean }> {
  const conception = await activeConceptionPath();
  if (!conception) return { deleted: false };
  await requirePathUnder(filePath, condashLogsRoot(conception));
  if (!filePath.endsWith('.txt')) {
    throw new Error('logsDeleteSession: only .txt files');
  }
  try {
    await fs.rm(filePath, { force: true });
    // Sweep the sidecar too — missing-OK.
    await fs.rm(sessionMetaPath(filePath), { force: true });
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
