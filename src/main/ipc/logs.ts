import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { TermLogSessionMeta, TermLogSessionRead } from '../../shared/types';
import { parseMetaLine, splitContent, type FooterJson, type HeaderJson } from '../logs-format';
import { condashLogsRoot } from '../condash-dir';
import { requirePathUnder } from '../path-bounds';
import { readSettings } from '../settings';

// Re-exported so callers that historically imported `splitContent` from this
// file keep working. New code should import directly from `../logs-format`.
export { splitContent };

/**
 * IPC surface for the Logs pane.
 *
 * Storage is one plain-text `.txt` per pty spawn: a `# condash: {...}`
 * JSON header line, a blank line, the rendered xterm buffer, and (after
 * `exit()`) a blank line + `# condash: {...}` footer line. Metadata is
 * parsed back out of the header / footer; there is no sidecar file.
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

function isSessionFile(name: string): boolean {
  return name.endsWith('.txt');
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
        // Skip days that contain no `.txt` (legacy `.jsonl` / `.txt.gz`
        // remnants don't count).
        const dayPath = join(monthPath, d);
        const dayFiles = await readDirSafe(dayPath);
        if (!dayFiles.some(isSessionFile)) continue;
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
    if (!isSessionFile(name)) continue;
    const fullPath = join(dayPath, name);
    const meta = await readSessionMetaSummary(fullPath, day, name);
    if (meta) metas.push(meta);
  }
  // Sort by HHMMSS — chronological within a day.
  metas.sort((a, b) => (a.time < b.time ? -1 : 1));
  return metas;
}

/** Builds a TermLogSessionMeta for the listing. Reads the head + tail
 * of the file to recover the `# condash:` header / footer lines without
 * loading multi-megabyte transcripts into memory. */
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
  const [, hms, fileSid] = m;
  const time = `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;

  const { header, footer } = await readHeadAndTailMeta(txtPath, stat.size);

  return {
    path: txtPath,
    day,
    time,
    bytes: stat.size,
    sid: typeof header?.sid === 'string' ? header.sid : fileSid,
    repo: typeof header?.repo === 'string' ? header.repo : undefined,
    cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
    cmd: composeCmdLabel(header),
    exitCode: extractExitCode(footer),
    exitSealed: footer?.sealedByRecovery === true || undefined,
  };
}

/** Extract the exit code in the tri-state form the renderer consumes:
 * a number when the session exited cleanly; `null` when the recovery
 * sweep sealed an orphan footer; `undefined` when the session is still
 * live (no footer on disk). */
function extractExitCode(footer: FooterJson | null): number | null | undefined {
  if (!footer) return undefined;
  if (typeof footer.exitCode === 'number') return footer.exitCode;
  if (footer.exitCode === null) return null;
  return undefined;
}

function composeCmdLabel(header: HeaderJson | null): string | undefined {
  if (!header?.cmd) return undefined;
  if (header.argv && header.argv.length > 0) {
    return [header.cmd, ...header.argv].join(' ');
  }
  return header.cmd;
}

/** Read the first 4 KB and (if larger) the last 1 KB of a session file
 * and pluck the `# condash:` header / footer lines. The header is line
 * 1, by construction. The footer is the last `# condash:` line in the
 * tail — only present after `exit()`. */
async function readHeadAndTailMeta(
  filePath: string,
  size: number,
): Promise<{ header: HeaderJson | null; footer: FooterJson | null }> {
  const HEAD = 4096;
  const TAIL = 1024;
  let header: HeaderJson | null = null;
  let footer: FooterJson | null = null;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const headBuf = Buffer.alloc(Math.min(HEAD, size));
    await handle.read(headBuf, 0, headBuf.length, 0);
    const headText = headBuf.toString('utf8');
    const firstNewline = headText.indexOf('\n');
    const firstLine = firstNewline >= 0 ? headText.slice(0, firstNewline) : headText;
    header = parseMetaLine(firstLine);

    if (size > HEAD) {
      const tailBuf = Buffer.alloc(TAIL);
      await handle.read(tailBuf, 0, TAIL, Math.max(0, size - TAIL));
      const tailText = tailBuf.toString('utf8');
      footer = findLastFooterLine(tailText);
    } else {
      // Whole file fits in HEAD — scan it for a footer line too.
      footer = findLastFooterLine(headText);
    }
  } catch {
    /* missing or unreadable — leave header/footer null */
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
  return { header, footer };
}

function findLastFooterLine(text: string): FooterJson | null {
  // Find the last line that begins with the meta prefix. The header line
  // is also a match — the caller separately parses it, so a corrupted
  // file with no footer falls back to the header here harmlessly (we
  // only consume `finished` / `exitCode`).
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = parseMetaLine(lines[i]);
    if (!m) continue;
    if ('exitCode' in m || 'finished' in m) return m as FooterJson;
  }
  return null;
}

async function readSession(filePath: string): Promise<TermLogSessionRead> {
  const conception = await activeConceptionPath();
  if (!conception) return { text: '', meta: null };
  await requirePathUnder(filePath, condashLogsRoot(conception));
  if (!filePath.endsWith('.txt')) {
    throw new Error('logsReadSession: only .txt files');
  }
  let raw = '';
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    /* missing file → empty body */
  }
  const { text, header, footer } = splitContent(raw);
  const day = deriveDay(filePath);
  const fileName = filePath.split('/').pop() ?? '';
  const sid = /^\d{6}-(.+?)\.txt$/.exec(fileName)?.[1] ?? '';
  const meta: TermLogSessionMeta | null =
    header || footer
      ? {
          path: filePath,
          day: day ?? '',
          time: deriveTime(fileName),
          bytes: Buffer.byteLength(raw, 'utf8'),
          sid: typeof header?.sid === 'string' ? header.sid : sid,
          repo: typeof header?.repo === 'string' ? header.repo : undefined,
          cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
          cmd: composeCmdLabel(header),
          exitCode: extractExitCode(footer),
          exitSealed: footer?.sealedByRecovery === true || undefined,
        }
      : null;
  return { text, meta };
}

function deriveDay(filePath: string): string | null {
  // <root>/YYYY/MM/DD/HHMMSS-<sid>.txt
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/\d{6}-[^/]+\.txt$/.exec(filePath);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function deriveTime(fileName: string): string {
  const m = /^(\d{6})-/.exec(fileName);
  if (!m) return '';
  const hms = m[1];
  return `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;
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
