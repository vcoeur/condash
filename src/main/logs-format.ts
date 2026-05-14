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

export interface HeaderJson {
  sid?: string;
  side?: string;
  repo?: string;
  cwd?: string;
  cmd?: string;
  argv?: string[];
  started?: string;
}

export interface FooterJson {
  finished?: string;
  exitCode?: number;
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
