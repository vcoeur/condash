import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { condashLogsRoot } from './condash-dir';
import { META_LINE_PREFIX, parseMetaLine } from './logs-format';

/**
 * Seal log files that look "running" but belong to dead sessions.
 *
 * Background: `SessionLogger.exit(exitCode)` writes the footer line that
 * the Logs pane reads to display the exit status. The write is debounced
 * + fire-and-forget — when condash exits abruptly (crash, SIGKILL, OS
 * shutdown, hot reload during dev), the footer never makes it to disk
 * and the file stays "running"-looking forever even though the pty is
 * gone.
 *
 * This runs once at boot per active conception. It walks every day
 * directory under `<conception>/.condash/logs/`, finds `.txt` files that
 * have a header line but no footer, and — if the file's mtime is older
 * than `STALE_GRACE_MS` — appends a synthetic footer marking it as
 * `exitCode: null` (unknown). The grace window avoids racing the
 * 5-second debounce of any logger that's actively writing.
 *
 * No-ops on files that already carry a footer; idempotent across boots.
 */

const META_PREFIX = META_LINE_PREFIX;
/** A file mtime newer than (now - this) is treated as "possibly still
 * writing" and left alone. The active logger flushes every 5 s; 30 s of
 * margin handles a slow filesystem, a paused logger, and a debounce
 * window that's been bumped by the user. */
const STALE_GRACE_MS = 30_000;
/** Sentinel exit code for "we don't know" (footer was missing). */
const UNKNOWN_EXIT_CODE = null;

export interface SealResult {
  scanned: number;
  sealed: string[];
}

/** Walk every `.txt` under `<conception>/.condash/logs/YYYY/MM/DD/` and
 * append a synthetic footer to any file that has a header but no footer
 * AND has not been modified for at least `STALE_GRACE_MS`. */
export async function sealOrphanLogs(
  conceptionPath: string,
  now: Date = new Date(),
): Promise<SealResult> {
  const root = condashLogsRoot(conceptionPath);
  const result: SealResult = { scanned: 0, sealed: [] };
  const txtPaths = await collectTxtPaths(root);
  for (const path of txtPaths) {
    result.scanned += 1;
    try {
      const sealed = await sealOneIfOrphan(path, now);
      if (sealed) result.sealed.push(path);
    } catch (err) {
      process.stderr.write(`condash seal-orphan-logs: ${path}: ${(err as Error).message}\n`);
    }
  }
  return result;
}

async function collectTxtPaths(root: string): Promise<string[]> {
  const out: string[] = [];
  const years = await readDirSafe(root);
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yp = join(root, y);
    const months = await readDirSafe(yp);
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const mp = join(yp, m);
      const days = await readDirSafe(mp);
      for (const d of days) {
        if (!/^\d{2}$/.test(d)) continue;
        const dp = join(mp, d);
        const files = await readDirSafe(dp);
        for (const f of files) {
          if (f.endsWith('.txt')) out.push(join(dp, f));
        }
      }
    }
  }
  return out;
}

/** Returns true iff a footer was actually appended to `txtPath`. */
async function sealOneIfOrphan(txtPath: string, now: Date): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(txtPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (now.getTime() - stat.mtimeMs < STALE_GRACE_MS) return false;

  const text = await fs.readFile(txtPath, 'utf8');
  if (hasFooter(text)) return false;
  // Need a header to seal — otherwise the file isn't a session log we
  // recognise. (parseMetaLine fails closed on anything else, so this
  // is belt + braces.)
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (!parseMetaLine(firstLine)) return false;

  const footer = {
    finished: new Date(stat.mtimeMs).toISOString(),
    exitCode: UNKNOWN_EXIT_CODE,
    sealedByRecovery: true,
  };
  const suffix =
    (text.endsWith('\n') ? '' : '\n') + '\n' + META_PREFIX + JSON.stringify(footer) + '\n';
  await fs.appendFile(txtPath, suffix, 'utf8');
  return true;
}

function hasFooter(text: string): boolean {
  // Scan the tail for a META_PREFIX line that carries finished/exitCode.
  // The header (line 1) also starts with META_PREFIX but doesn't carry
  // either field, so it's not a false positive.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = parseMetaLine(lines[i]);
    if (!m) continue;
    if ('finished' in m || 'exitCode' in m) return true;
    // Hit the header (no finished/exitCode) → no footer above it.
    if ('started' in m) return false;
  }
  return false;
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
