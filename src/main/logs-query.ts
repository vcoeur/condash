/**
 * CLI-safe query layer over the per-conception terminal-session logs.
 *
 * Storage is one plain-text `.txt` per pty spawn under
 * `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`: a `# condash: {…}`
 * JSON header line, a blank line, the rendered xterm buffer, and (after the
 * pty exits) a blank line + `# condash: {…}` footer line.
 *
 * This module is the shared core behind the `condash logs` CLI noun. Like
 * `logs-format.ts`, it is CLI-safe by construction — only `node:fs` /
 * `node:path` plus the pure parsers, no `electron`, no `@xterm/*`. The GUI's
 * `ipc/logs.ts` keeps its own Electron-bound listing path; this layer adds the
 * filtering / slicing the command line needs.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { toPosix } from '../shared/path';
import {
  detectKind,
  parseMetaLine,
  splitContent,
  type FooterJson,
  type HeaderJson,
  type LogKind,
} from './logs-format';
import { redactSecrets } from './logs-redact';
import { condashLogsRoot } from './condash-dir';
import { runWithConcurrency } from './search/concurrency';

/** Bound on the per-file stat / meta reads a single listing fans out — a busy
 *  conception holds hundreds of session files, so a serial walk would stack up
 *  that many round-trips. Matches the search disk-scan pool size. */
const LISTING_CONCURRENCY = 32;

/** One enumerated session file, before any metadata is read off disk. */
export interface SessionRef {
  /** Absolute path to the `.txt`. */
  path: string;
  /** `YYYY-MM-DD` derived from the directory layout. */
  day: string;
  /** `HH:MM:SS` derived from the filename prefix. */
  time: string;
  /** Session id — the `<sid>` suffix in `HHMMSS-<sid>.txt`. */
  sid: string;
}

/** A session listing row: ref + parsed metadata + filesystem facts. */
export interface SessionRow extends SessionRef {
  /** File size in bytes. */
  bytes: number;
  /** File mtime as an ISO-8601 string. */
  modified: string;
  /** Spawn time as an ISO-8601 string (header `started`, else derived). */
  started: string;
  repo?: string;
  cwd?: string;
  /** `cmd` joined with `argv`, when present. */
  cmd?: string;
  /** number = clean exit; `null` = recovery-sealed orphan; undefined = live. */
  exitCode?: number | null;
  /** True when the footer was synthesised by the orphan-seal recovery pass. */
  exitSealed?: boolean;
  /** A session with no footer on disk — still running or never sealed. */
  active: boolean;
  /** `transcript` (append-only OSC log) vs `grid` (repainted snapshot). Tells a
   *  consumer when a byte cursor is reliable. Derived for legacy logs. */
  kind: LogKind;
}

/** One day directory that holds at least one session. */
export interface DayRow {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Absolute path to the day directory. */
  path: string;
  /** Count of `.txt` session files. */
  sessions: number;
  /** Sum of session-file sizes in bytes. */
  bytes: number;
}

export interface ListFilters {
  /** Restrict to one `YYYY-MM-DD` day. */
  day?: string;
  /** Keep sessions whose spawn time is ≥ this epoch-ms. */
  sinceMs?: number;
  /** Keep sessions whose spawn time is ≤ this epoch-ms. */
  untilMs?: number;
  /** Keep sessions whose file mtime is ≥ this epoch-ms. */
  modifiedSinceMs?: number;
  /** Exact match on the header `repo`. */
  repo?: string;
  /** Only sessions with no footer (still running / never sealed). */
  active?: boolean;
  /** Prefix match on the session id. */
  sid?: string;
  /** Cap the row count after sorting. */
  limit?: number;
}

export interface ReadOptions {
  /** First `n` body lines. */
  head?: number;
  /** Last `n` body lines. */
  tail?: number;
  /** Inclusive 1-based line range; `to: null` means "to end". */
  lines?: { from: number; to: number | null };
  /** Raw file bytes from this offset to EOF (the stateless cursor). */
  fromByte?: number;
  /** Emit only parsed metadata, no body. */
  metaOnly?: boolean;
  /** Keep the `# condash:` meta lines in the body (default strips them). */
  withMeta?: boolean;
  /** Mask obvious secret shapes in the emitted text before returning. */
  redact?: boolean;
}

export interface ReadResult {
  header: HeaderJson | null;
  footer: FooterJson | null;
  /** The selected text (empty when `metaOnly`). */
  text: string;
  /** Total body lines (meta-stripped), for context. */
  totalLines: number;
  /** File size in bytes — also the cursor to store for the next read. */
  bytes: number;
  /** The `--from-byte` offset honoured, or null when not a cursor read. */
  fromByte: number | null;
  /** Size at read time; pass back as the next `--from-byte`. */
  nextByte: number;
  /** True when `fromByte > bytes` — the janitor rotated/trimmed the file. */
  rotated: boolean;
  /** `transcript` vs `grid` — see `SessionRow.kind`. */
  kind: LogKind;
  /** Resolved session ref (path, day, time, sid). */
  ref: SessionRef;
}

const SESSION_RE = /(\d{4})\/(\d{2})\/(\d{2})\/(\d{6})-(.+)\.txt$/;
const FILE_RE = /^(\d{6})-(.+)\.txt$/;

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function hhmmssToTime(hms: string): string {
  return `${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`;
}

/** Local-time epoch-ms for a `YYYY-MM-DD` day + `HH:MM:SS` time. Spawn-time
 *  filtering uses this so a bare `<when>` is compared in the user's wall-clock
 *  frame, consistent with `parseWhen`'s handling of zone-less tokens. */
function localInstant(day: string, time: string): number {
  const [y, mo, d] = day.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return new Date(y, mo - 1, d, hh, mm, ss).getTime();
}

/** Walk the `YYYY/MM/DD/HHMMSS-<sid>.txt` tree and yield one ref per session.
 *  `monthPrefix` ('YYYY' or 'YYYY-MM') narrows the scan cheaply. */
async function enumerateSessions(conception: string, monthPrefix?: string): Promise<SessionRef[]> {
  const root = condashLogsRoot(conception);
  const out: SessionRef[] = [];
  const wantYear = monthPrefix?.slice(0, 4);
  const wantMonth = monthPrefix && monthPrefix.length >= 7 ? monthPrefix.slice(5, 7) : undefined;
  for (const y of await readDirSafe(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    if (wantYear && y !== wantYear) continue;
    const yearPath = join(root, y);
    for (const m of await readDirSafe(yearPath)) {
      if (!/^\d{2}$/.test(m)) continue;
      if (wantMonth && m !== wantMonth) continue;
      const monthPath = join(yearPath, m);
      for (const d of await readDirSafe(monthPath)) {
        if (!/^\d{2}$/.test(d)) continue;
        const dayPath = join(monthPath, d);
        for (const name of await readDirSafe(dayPath)) {
          const fm = FILE_RE.exec(name);
          if (!fm) continue;
          out.push({
            path: join(dayPath, name),
            day: `${y}-${m}-${d}`,
            time: hhmmssToTime(fm[1]),
            sid: fm[2],
          });
        }
      }
    }
  }
  return out;
}

/** Enumerate days that hold at least one session, newest first. */
export async function listDays(conception: string, monthPrefix?: string): Promise<DayRow[]> {
  const refs = await enumerateSessions(conception, monthPrefix);
  // Stat the files under a bounded pool rather than one-at-a-time; a vanished
  // file contributes 0 bytes but the ref is still counted, matching the prior
  // (stat-in-try/catch-after-increment) behaviour.
  const sizes = await runWithConcurrency(
    refs.map((ref) => async () => {
      try {
        return (await fs.stat(ref.path)).size;
      } catch {
        return 0;
      }
    }),
    LISTING_CONCURRENCY,
  );
  const byDay = new Map<string, { path: string; sessions: number; bytes: number }>();
  refs.forEach((ref, i) => {
    let entry = byDay.get(ref.day);
    if (!entry) {
      // The day directory is the parent of the session file. `dirname` uses the
      // platform separator — slicing on a literal `/` would return the whole
      // native path unchanged on Windows.
      entry = { path: dirname(ref.path), sessions: 0, bytes: 0 };
      byDay.set(ref.day, entry);
    }
    entry.sessions += 1;
    entry.bytes += sizes[i];
  });
  return [...byDay.entries()]
    .map(([day, e]) => ({ day, path: e.path, sessions: e.sessions, bytes: e.bytes }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** Chunk size for the incremental header read. */
const HEAD_CHUNK = 4096;
/** Upper bound on how far the header read will scan for the first newline —
 *  past this the header line is treated as unparseable rather than loading
 *  an arbitrarily large file. */
const HEAD_MAX = 256 * 1024;
/** Footer scan window at the end of the file. */
const TAIL = 1024;

/** Read from offset 0 in HEAD_CHUNK steps until the first newline (or
 *  HEAD_MAX / EOF). Returns the decoded text and how many bytes it covers.
 *  Chunks are concatenated as Buffers before decoding so a multi-byte UTF-8
 *  character split across a chunk boundary survives. */
async function readHeadText(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: number,
): Promise<{ text: string; bytesRead: number }> {
  const limit = Math.min(size, HEAD_MAX);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < limit) {
    const len = Math.min(HEAD_CHUNK, limit - offset);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await handle.read(buf, 0, len, offset);
    if (bytesRead <= 0) break;
    const chunk = buf.subarray(0, bytesRead);
    chunks.push(chunk);
    offset += bytesRead;
    if (chunk.includes(0x0a)) break;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytesRead: offset };
}

/** Read the file head up to the first newline (a promptFlags run carries its
 *  full argv in the header line, which can exceed any fixed chunk size) plus,
 *  when the file is larger, the last 1 KB — and pluck the `# condash:` header
 *  / footer lines without loading the full transcript. Exported for the GUI's
 *  `ipc/logs.ts` listing path, so both ends parse long headers identically. */
export async function readHeadTailMeta(
  filePath: string,
  size: number,
): Promise<{ header: HeaderJson | null; footer: FooterJson | null; kind: LogKind }> {
  let header: HeaderJson | null = null;
  let footer: FooterJson | null = null;
  let kind: LogKind = 'grid';
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const head = await readHeadText(handle, size);
    const nl = head.text.indexOf('\n');
    header = parseMetaLine(nl >= 0 ? head.text.slice(0, nl) : head.text);
    // The legacy-fallback heuristic only needs the first body line, which sits
    // within the head chunk; `splitContent` strips the header + blank for us.
    kind = detectKind(header, splitContent(head.text).text);
    if (size > head.bytesRead) {
      const tailBuf = Buffer.alloc(TAIL);
      await handle.read(tailBuf, 0, TAIL, Math.max(0, size - TAIL));
      footer = findLastFooter(tailBuf.toString('utf8'));
    } else {
      footer = findLastFooter(head.text);
    }
  } catch {
    /* missing / unreadable — leave null */
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
  return { header, footer, kind };
}

function findLastFooter(text: string): FooterJson | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = parseMetaLine(lines[i]);
    if (m && ('exitCode' in m || 'finished' in m)) return m as FooterJson;
  }
  return null;
}

function composeCmd(header: HeaderJson | null): string | undefined {
  if (!header?.cmd) return undefined;
  return header.argv && header.argv.length > 0
    ? [header.cmd, ...header.argv].join(' ')
    : header.cmd;
}

function extractExitCode(footer: FooterJson | null): number | null | undefined {
  if (!footer) return undefined;
  if (typeof footer.exitCode === 'number') return footer.exitCode;
  if (footer.exitCode === null) return null;
  return undefined;
}

/** Turn a ref into a full row by reading its metadata + stat. */
async function buildRow(ref: SessionRef): Promise<SessionRow | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(ref.path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const { header, footer, kind } = await readHeadTailMeta(ref.path, stat.size);
  const exitCode = extractExitCode(footer);
  const started = typeof header?.started === 'string' ? header.started : `${ref.day}T${ref.time}`;
  return {
    ...ref,
    sid: typeof header?.sid === 'string' ? header.sid : ref.sid,
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    started,
    repo: typeof header?.repo === 'string' ? header.repo : undefined,
    cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
    cmd: composeCmd(header),
    exitCode,
    exitSealed: footer?.sealedByRecovery === true || undefined,
    // No footer on disk → still running (or never sealed).
    active: footer === null,
    kind,
  };
}

/** List sessions matching `filters`, newest spawn-time first. */
export async function listSessions(
  conception: string,
  filters: ListFilters = {},
): Promise<SessionRow[]> {
  const monthPrefix = filters.day ? filters.day.slice(0, 7) : undefined;
  const refs = await enumerateSessions(conception, monthPrefix);
  // Apply the cheap ref-level predicates (day / sid) before touching disk, then
  // build the surviving rows under a bounded pool. `runWithConcurrency`
  // preserves input order, and the post-build filters + final sort run over the
  // result exactly as the serial loop did — so the output is identical, only
  // the I/O is parallel. `buildRow` returns null on a vanished file (skipped).
  const candidates = refs.filter(
    (ref) =>
      (!filters.day || ref.day === filters.day) &&
      (!filters.sid || ref.sid.startsWith(filters.sid)),
  );
  const built = await runWithConcurrency(
    candidates.map((ref) => () => buildRow(ref)),
    LISTING_CONCURRENCY,
  );
  const rows: SessionRow[] = [];
  for (const row of built) {
    if (!row) continue;
    if (filters.repo && row.repo !== filters.repo) continue;
    if (filters.active && !row.active) continue;
    // Filter on the local wall-clock spawn instant (day + filename time), the
    // same value the user reads in `list` / the GUI — not the UTC header
    // `started`, so a bare `--since 2026-05-30T10:00` means local 10:00.
    const startedMs = localInstant(row.day, row.time);
    if (filters.sinceMs !== undefined && startedMs < filters.sinceMs) continue;
    if (filters.untilMs !== undefined && startedMs > filters.untilMs) continue;
    if (filters.modifiedSinceMs !== undefined && Date.parse(row.modified) < filters.modifiedSinceMs)
      continue;
    rows.push(row);
  }
  rows.sort((a, b) => (a.started < b.started ? 1 : a.started > b.started ? -1 : 0));
  return filters.limit && filters.limit > 0 ? rows.slice(0, filters.limit) : rows;
}

/** Error thrown by `resolveSession` when a sid prefix matches more than one
 *  session. The CLI maps this to exit code 6 (ambiguous). */
export class AmbiguousSidError extends Error {
  readonly candidates: SessionRef[];
  constructor(sid: string, candidates: SessionRef[]) {
    super(`Session id '${sid}' is ambiguous (${candidates.length} matches)`);
    this.name = 'AmbiguousSidError';
    this.candidates = candidates;
  }
}

/**
 * Resolve a selector to a single session ref. The selector is one of:
 *   - a bare `<sid>` (prefix-matched across all days, newest first),
 *   - a `day/sid` qualifier (`2026-05-30/t-a1b2c3d4`),
 *   - an absolute path to a `.txt` under the logs root.
 * Returns null when nothing matches; throws `AmbiguousSidError` on >1 match.
 */
export async function resolveSession(
  conception: string,
  selector: string,
): Promise<SessionRef | null> {
  const root = condashLogsRoot(conception);
  // Direct path under the logs root. Match on the POSIX-normalised form so a
  // native Windows path (backslash separators) resolves — `SESSION_RE` and the
  // `includes('/')` / `startsWith(root)` checks are all `/`-based. The original
  // `selector` is kept as the ref path so the subsequent `fs` read is native.
  const selectorPosix = toPosix(selector);
  const rootPosix = toPosix(root);
  if (
    selectorPosix.endsWith('.txt') &&
    selectorPosix.includes('/') &&
    selectorPosix.startsWith(rootPosix + '/')
  ) {
    const m = SESSION_RE.exec(selectorPosix);
    if (!m) return null;
    return { path: selector, day: `${m[1]}-${m[2]}-${m[3]}`, time: hhmmssToTime(m[4]), sid: m[5] };
  }
  // `day/sid` qualifier.
  let day: string | undefined;
  let sidPart = selector;
  const slash = selector.indexOf('/');
  if (slash >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(selector.slice(0, slash))) {
    day = selector.slice(0, slash);
    sidPart = selector.slice(slash + 1);
  }
  const refs = await enumerateSessions(conception, day?.slice(0, 7));
  const matches = refs
    .filter((r) => (day ? r.day === day : true))
    .filter((r) => r.sid === sidPart || r.sid.startsWith(sidPart))
    .sort((a, b) => (`${a.day}T${a.time}` < `${b.day}T${b.time}` ? 1 : -1));
  if (matches.length === 0) return null;
  // An exact sid match wins outright even if it prefixes others.
  const exact = matches.filter((r) => r.sid === sidPart);
  if (exact.length === 1) return exact[0];
  if (matches.length === 1) return matches[0];
  throw new AmbiguousSidError(sidPart, matches);
}

function sliceLines(lines: string[], opts: ReadOptions): string[] {
  if (opts.head !== undefined) return lines.slice(0, opts.head);
  if (opts.tail !== undefined) return opts.tail >= lines.length ? lines : lines.slice(-opts.tail);
  if (opts.lines) {
    const from = Math.max(1, opts.lines.from);
    const to = opts.lines.to === null ? lines.length : opts.lines.to;
    return lines.slice(from - 1, to);
  }
  return lines;
}

/** Read (a slice of) one session. `ref` comes from `resolveSession`. */
export async function readSession(ref: SessionRef, opts: ReadOptions = {}): Promise<ReadResult> {
  let raw = '';
  try {
    raw = await fs.readFile(ref.path, 'utf8');
  } catch {
    /* missing → empty */
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  const { text: body, header, footer } = splitContent(raw);
  const totalLines = body.length === 0 ? 0 : body.split('\n').length;
  const kind = detectKind(header, body);
  const finishText = (text: string): string => (opts.redact ? redactSecrets(text) : text);

  if (opts.metaOnly) {
    return {
      header,
      footer,
      text: '',
      totalLines,
      bytes,
      fromByte: null,
      nextByte: bytes,
      rotated: false,
      kind,
      ref,
    };
  }

  // Byte-cursor read: raw file bytes from the offset to EOF, footer stripped.
  if (opts.fromByte !== undefined) {
    const from = opts.fromByte;
    if (from > bytes) {
      return {
        header,
        footer,
        text: '',
        totalLines,
        bytes,
        fromByte: from,
        nextByte: bytes,
        rotated: true,
        kind,
        ref,
      };
    }
    const buf = Buffer.from(raw, 'utf8').subarray(from);
    let sliceText = buf.toString('utf8');
    // Drop a trailing footer meta line (+ its leading blank) if it landed in
    // the slice, so a cursor read never re-surfaces the session's footer.
    sliceText = stripTrailingFooter(sliceText);
    return {
      header,
      footer,
      text: finishText(sliceText),
      totalLines,
      bytes,
      fromByte: from,
      nextByte: bytes,
      rotated: false,
      kind,
      ref,
    };
  }

  const source = opts.withMeta ? raw.replace(/\n$/, '') : body;
  const allLines = source.length === 0 ? [] : source.split('\n');
  const selected = sliceLines(allLines, opts);
  return {
    header,
    footer,
    text: finishText(selected.join('\n')),
    totalLines,
    bytes,
    fromByte: null,
    nextByte: bytes,
    rotated: false,
    kind,
    ref,
  };
}

function stripTrailingFooter(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  if (end > 0 && lines[end - 1] === '') end--;
  if (end > 0 && lines[end - 1].startsWith('# condash: ')) {
    const parsed = parseMetaLine(lines[end - 1]);
    if (parsed && ('exitCode' in parsed || 'finished' in parsed)) {
      end--;
      if (end > 0 && lines[end - 1] === '') end--;
    }
  }
  return lines.slice(0, end).join('\n');
}

/**
 * Parse a `<when>` token into an epoch-ms instant, or null on a malformed
 * token (the caller raises a usage error). Grammar:
 *   - relative span: `30m` `2h` `3d` `1w` (ago from `nowMs`)
 *   - keywords: `today` / `yesterday` (local midnight)
 *   - ISO date `YYYY-MM-DD` or datetime `YYYY-MM-DDTHH:MM[:SS]`
 */
export function parseWhen(token: string, nowMs: number): number | null {
  const t = token.trim();
  const rel = /^(\d+)(m|h|d|w)$/.exec(t);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]]!;
    return nowMs - n * unit;
  }
  if (t === 'today' || t === 'yesterday') {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    if (t === 'yesterday') d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  // Parse a zone-less ISO date / datetime as LOCAL wall-clock. (Plain
  // `Date.parse` treats a date-only string as UTC but a datetime as local —
  // building the Date from parts removes that inconsistency.)
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (iso) {
    const ms = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
    ).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
