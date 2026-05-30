/**
 * Pure parsing of the `# condash: {...}` header / footer lines that pty-spawn
 * `.txt` logs carry. CLI-safe by construction: no `electron`, no
 * `@xterm/headless`, no Node-only side effects. Anything that touches the
 * filesystem or the Electron runtime stays out of this module.
 *
 * Consumed by:
 *
 *   - `terminal-logger.ts` — writer; uses `META_LINE_PREFIX` to emit the
 *     header / footer lines around the rendered xterm buffer.
 *   - `ipc/logs.ts`        — reader; parses headers / footers off disk to
 *     build session meta for the Logs pane.
 *   - `search/match.ts`    — global search; strips the meta lines off log
 *     bodies before snippet building. The CLI's `condash search` command
 *     reaches `match.ts` through `src/main/search/index.ts`, so this
 *     module must not pull in anything the CLI bundle can't load — that
 *     is why it was carved out of `ipc/logs.ts` in the first place.
 */

export const META_LINE_PREFIX = '# condash: ';

/** Which kind of body the `.txt` carries. `transcript` = the in-band OSC agent
 * transcript (append-only message log — a byte cursor is reliable); `grid` = a
 * rendered xterm-buffer snapshot (repainted each flush). Absent on logs written
 * before the field existed; readers fall back to a first-line heuristic. */
export type LogKind = 'transcript' | 'grid';

export interface HeaderJson {
  sid?: string;
  side?: string;
  repo?: string;
  cwd?: string;
  cmd?: string;
  argv?: string[];
  started?: string;
  kind?: LogKind;
}

export interface FooterJson {
  finished?: string;
  /** Number when the pty exited cleanly. `null` when the recovery sweep
   * sealed an orphan log (process gone before the footer could land), so
   * the Logs UI can render "ended (unknown)" instead of "running". */
  exitCode?: number | null;
  /** True when this footer was written by the boot-time orphan-seal pass
   * rather than the live logger's exit() handler. UI-only signal. */
  sealedByRecovery?: boolean;
}

/** A transcript body's first non-empty line is a role block; the writer joins
 * `[user] …` / `[assistant] …` / `[reasoning] …` messages. */
const TRANSCRIPT_LINE_RE = /^\[(?:user|assistant|reasoning)\] /;

/** Decide whether a session body is the OSC transcript or the grid snapshot.
 * Prefers the writer-stamped header `kind`; for legacy logs written before that
 * field, falls back to the role-block heuristic on the first non-empty line.
 * `body` may be only the file's leading chunk — the first line is all we read. */
export function detectKind(header: HeaderJson | null, body: string): LogKind {
  if (header?.kind === 'transcript' || header?.kind === 'grid') return header.kind;
  for (const line of body.split('\n')) {
    if (line === '') continue;
    return TRANSCRIPT_LINE_RE.test(line) ? 'transcript' : 'grid';
  }
  return 'grid';
}

/** Parse one line as a `# condash: {...}` meta line. Returns the parsed JSON
 * object on success, or `null` when the line lacks the prefix or the JSON
 * payload is malformed. Used for both header and footer lines — the caller
 * decides which it is by inspecting the fields. */
export function parseMetaLine(line: string): HeaderJson | null {
  if (!line.startsWith(META_LINE_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(META_LINE_PREFIX.length));
  } catch {
    return null;
  }
}

/** Strip the leading `# condash:` header line + its following blank, and the
 * trailing blank + `# condash:` footer line if present. Returns the naked
 * body plus the parsed JSON blobs for the caller. */
export function splitContent(raw: string): {
  text: string;
  header: HeaderJson | null;
  footer: FooterJson | null;
} {
  if (raw.length === 0) return { text: '', header: null, footer: null };
  const allLines = raw.split('\n');
  let header: HeaderJson | null = null;
  let start = 0;
  if (allLines.length > 0 && allLines[0].startsWith(META_LINE_PREFIX)) {
    header = parseMetaLine(allLines[0]);
    start = 1;
    if (start < allLines.length && allLines[start] === '') start++;
  }
  let end = allLines.length;
  let footer: FooterJson | null = null;
  // Drop a trailing empty line introduced by the file's terminating `\n`.
  if (end > start && allLines[end - 1] === '') end--;
  if (end > start && allLines[end - 1].startsWith(META_LINE_PREFIX)) {
    const parsed = parseMetaLine(allLines[end - 1]);
    if (parsed && ('exitCode' in parsed || 'finished' in parsed)) {
      footer = parsed as FooterJson;
      end--;
      if (end > start && allLines[end - 1] === '') end--;
    }
  }
  const text = allLines.slice(start, end).join('\n');
  return { text, header, footer };
}
