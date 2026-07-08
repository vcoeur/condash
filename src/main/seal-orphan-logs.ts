import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { condashDir, condashLogsRoot } from './condash-dir';
import { META_LINE_PREFIX, parseMetaLine } from './logs-format';
import { TASK_TRIGGERS } from './task-runs';

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
 * directory under `<conception>/.condash/logs/` plus the segregated
 * task-run trees (`.condash/scheduled/<slug>/`, `.condash/manual/<slug>/`),
 * finds `.txt` files that have a header line but no footer, and — if the
 * file's mtime is older than `STALE_GRACE_MS` — appends a synthetic footer
 * marking it as `exitCode: null` (unknown). The grace window avoids racing
 * the 5-second debounce of any logger that's actively writing.
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

/** Walk every `.txt` under `<conception>/.condash/logs/YYYY/MM/DD/` and the
 * task-run trees (`.condash/{scheduled,manual}/<slug>/`) and append a
 * synthetic footer to any file that has a header but no footer AND has not
 * been modified for at least `STALE_GRACE_MS`. `liveSids` names sessions the
 * caller still tracks (live or mid-close, their logger still open): their logs
 * are skipped regardless of mtime — the sweep also runs on every conception
 * re-pick, where a quiet live tab is stale-looking but very much running, and
 * a bogus footer there would show it "ended ?" and make the live logger's next
 * flush full-rewrite (E4). */
export async function sealOrphanLogs(
  conceptionPath: string,
  liveSids: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): Promise<SealResult> {
  const root = condashLogsRoot(conceptionPath);
  const result: SealResult = { scanned: 0, sealed: [] };
  const txtPaths = [
    ...(await collectTxtPaths(root)),
    ...(await collectTaskRunTxtPaths(conceptionPath)),
  ];
  for (const path of txtPaths) {
    result.scanned += 1;
    try {
      const sealed = await sealOneIfOrphan(path, now, liveSids);
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

/** Task runs live outside the logs root, under
 * `.condash/{scheduled,manual}/<slug>/*.txt` — a killed/crashed run there
 * would otherwise look "running" forever in the Task-runs view. */
async function collectTaskRunTxtPaths(conceptionPath: string): Promise<string[]> {
  const out: string[] = [];
  for (const trigger of TASK_TRIGGERS) {
    const triggerRoot = join(condashDir(conceptionPath), trigger);
    for (const slug of await readDirSafe(triggerRoot)) {
      const dir = join(triggerRoot, slug);
      for (const f of await readDirSafe(dir)) {
        if (f.endsWith('.txt')) out.push(join(dir, f));
      }
    }
  }
  return out;
}

/** Bytes read from each end of a candidate when deciding whether to seal it.
 * The header is line 1 and the footer is the last line, so a bounded head +
 * tail read is enough to (a) confirm the file is a session log, (b) detect an
 * existing footer, and (c) tell whether the last byte is a newline — without
 * ever reading a multi-MB transcript body just to append a footer (B6).
 * Generous versus any realistic header/footer line (a few hundred bytes of
 * JSON); a body line longer than this only ever appears between the two ends,
 * which we never need to read. */
const EDGE_BYTES = 64 * 1024;

/** The bytes at each end of the candidate file needed to decide a seal. */
interface FileEdges {
  /** Text of the first line (the header candidate). */
  firstLine: string;
  /** Up to `EDGE_BYTES` from the end of the file (the footer candidate + last byte). */
  tail: string;
  /** True when the tail read reached byte 0 (small file) — then its first split
   *  segment is a complete line, not a truncated one. */
  tailReachesStart: boolean;
}

/** Read only the first line + the final `EDGE_BYTES` of an open file. */
async function readEdges(fh: fs.FileHandle, size: number): Promise<FileEdges> {
  const headLen = Math.min(EDGE_BYTES, size);
  const headBuf = Buffer.alloc(headLen);
  if (headLen > 0) await fh.read(headBuf, 0, headLen, 0);
  const firstLine = headBuf.toString('utf8').split('\n', 1)[0] ?? '';

  const tailLen = Math.min(EDGE_BYTES, size);
  const tailStart = size - tailLen;
  const tailBuf = Buffer.alloc(tailLen);
  if (tailLen > 0) await fh.read(tailBuf, 0, tailLen, tailStart);
  return { firstLine, tail: tailBuf.toString('utf8'), tailReachesStart: tailStart === 0 };
}

/** Whether the file's tail already carries a footer meta line. Mirrors a
 * whole-file backward scan over complete lines: the footer is always the last
 * line, so it lives in the tail; a header meta line (`started`) short-circuits
 * to "no footer above it", matching the pre-tail full scan byte-for-byte. */
function tailHasFooter(edges: FileEdges): boolean {
  const lines = edges.tail.split('\n');
  // When the tail didn't reach byte 0 its first segment is a truncated line —
  // drop it so we only scan complete lines (a full-file line scan would never
  // see a partial line, and the footer is always complete at the very end).
  const lo = edges.tailReachesStart ? 0 : 1;
  for (let i = lines.length - 1; i >= lo; i--) {
    const m = parseMetaLine(lines[i]);
    if (!m) continue;
    if ('finished' in m || 'exitCode' in m) return true;
    // Hit the header (no finished/exitCode) → no footer above it.
    if ('started' in m) return false;
  }
  return false;
}

/** Returns true iff a footer was actually appended to `txtPath`. */
async function sealOneIfOrphan(
  txtPath: string,
  now: Date,
  liveSids: ReadonlySet<string>,
): Promise<boolean> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(txtPath, 'r');
  } catch {
    return false;
  }
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) return false;
    if (now.getTime() - stat.mtimeMs < STALE_GRACE_MS) return false;

    const edges = await readEdges(fh, stat.size);
    if (tailHasFooter(edges)) return false;
    // Need a header to seal — otherwise the file isn't a session log we
    // recognise. (parseMetaLine fails closed on anything else, so this
    // is belt + braces.)
    const header = parseMetaLine(edges.firstLine);
    if (!header) return false;
    // A session condash still tracks is not an orphan, however stale its
    // mtime — its logger is alive and owns the footer (E4).
    if (header.sid && liveSids.has(header.sid)) return false;

    const footer = {
      finished: new Date(stat.mtimeMs).toISOString(),
      exitCode: UNKNOWN_EXIT_CODE,
      sealedByRecovery: true,
    };
    const suffix =
      (edges.tail.endsWith('\n') ? '' : '\n') + '\n' + META_PREFIX + JSON.stringify(footer) + '\n';
    await fs.appendFile(txtPath, suffix, 'utf8');
    return true;
  } finally {
    await fh.close();
  }
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (err) {
    // ENOTDIR: a stray file where a slug directory is expected — skip it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}
