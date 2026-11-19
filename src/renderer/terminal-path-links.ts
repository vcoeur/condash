// Link provider for absolute paths printed as plain terminal text (issue
// #617). xterm orders link providers by registration, so the mount registers
// this one last — after the OSC 8 provider (built into the Terminal) and the
// WebLinksAddon — and any range it reports never shadows them: a provider
// link is only used where every higher-priority provider came back empty.
// Detection is deliberately narrow: an absolute path (/…) whose token stops
// at the first whitespace, probed for existence through main with one cached,
// rate-limited stat per distinct path (provideLinks only runs on hover, never
// per keystroke frame). `~/…` expansion, `:line:col` suffixes and relative
// paths are out of scope for v1.
import type { IBufferLine, IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { terminalDocumentPath } from '@shared/terminal-document-uri';

export interface TerminalPathLinkHooks {
  /** Gate hover bookkeeping: renew the hovered path link. */
  hover(uri: string, range: IBufferRange): void;
  /** Gate leave bookkeeping. */
  leave(): void;
  /** Open an existing non-document path through `openPath`; main bounds the
   *  call to the workspace roots and the renderer toasts the rejection. */
  openPath(path: string): void;
}

const PATH_TOKEN = /\/[^\s]+/g;
const MAX_WINDOW_CHARS = 2048;
const MAX_PATH_CHARS = 8192;
const PROBE_TTL_MS = 30_000;
const MAX_CONCURRENT_PROBES = 8;

interface ScanChar {
  /** 1-based absolute buffer row. */
  y: number;
  /** 1-based column of the character's first cell. */
  x: number;
  width: number;
}

interface ScanWindow {
  text: string;
  chars: ScanChar[];
}

interface Candidate {
  text: string;
  start: ScanChar;
  end: ScanChar;
}

interface WindowLine {
  index: number;
  line: IBufferLine;
  length: number;
}

/** Mirror xterm's internal getTrimmedLength with the public cell API: the
 *  index just past the last cell that carries characters. */
function trimmedLength(line: IBufferLine): number {
  for (let x = line.length - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    if (!cell) continue;
    if (cell.getChars() !== '') return x + Math.max(cell.getWidth(), 1);
  }
  return 0;
}

/**
 * Join the wrapped-line window around `rowIndex` (0-based absolute) into one
 * string with a per-character map back to buffer positions. The window climbs
 * while the line above is a soft wrap (trimmed content never ends in a real
 * space, so any non-empty wrapped line may continue a run) and extends down
 * while the run may continue below; the char cap bounds pathological
 * space-free runs. Trailing blank cells are dropped, matching the
 * WebLinksAddon's trimRight behaviour, so an early-wrapped wide char at a
 * line boundary doesn't inject a phantom space into a token.
 */
function buildWindow(buffer: Terminal['buffer']['active'], rowIndex: number): ScanWindow | null {
  const base = buffer.getLine(rowIndex);
  if (!base) return null;
  const lines: WindowLine[] = [];
  let total = 0;
  // Expand upward while the current top line is itself a soft wrap: it
  // continues the line above, which may hold the run's start.
  let top = rowIndex;
  while (total < MAX_WINDOW_CHARS) {
    const current = buffer.getLine(top);
    if (!current || !current.isWrapped) break;
    const previous = buffer.getLine(top - 1);
    if (!previous) break;
    const length = trimmedLength(previous);
    if (length === 0) break;
    lines.unshift({ index: top - 1, line: previous, length });
    total += length;
    top -= 1;
  }
  const baseLength = trimmedLength(base);
  lines.push({ index: rowIndex, line: base, length: baseLength });
  total += baseLength;
  let bottom = rowIndex;
  while (total < MAX_WINDOW_CHARS) {
    if (lines[lines.length - 1].length === 0) break;
    const next = buffer.getLine(bottom + 1);
    if (!next || !next.isWrapped) break;
    const length = trimmedLength(next);
    if (length === 0) break;
    lines.push({ index: bottom + 1, line: next, length });
    total += length;
    bottom += 1;
  }

  let text = '';
  const chars: ScanChar[] = [];
  for (const { index, line, length } of lines) {
    for (let x = 0; x < length; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      const width = cell.getWidth();
      if (width <= 0) continue;
      const cellChars = cell.getChars();
      if (cellChars) {
        for (const character of cellChars) {
          text += character;
          chars.push({ y: index + 1, x: x + 1, width });
        }
      } else {
        text += ' ';
        chars.push({ y: index + 1, x: x + 1, width });
      }
    }
  }
  return { text, chars };
}

/**
 * Absolute-path tokens with a genuine run start: the character before the
 * match must be whitespace (or the window's first character — the top line is
 * a genuine run start by construction of the upward climb). A `/` hugging a
 * non-whitespace character is inside a larger token (`https://…`, `x/bar`) or
 * a wrap continuation the climb already covered elsewhere, never a link.
 */
function collectCandidates(scan: ScanWindow): Candidate[] {
  const found: Candidate[] = [];
  PATH_TOKEN.lastIndex = 0;
  for (let match = PATH_TOKEN.exec(scan.text); match !== null; match = PATH_TOKEN.exec(scan.text)) {
    const text = match[0];
    if (text.length > MAX_PATH_CHARS || text.startsWith('//')) continue;
    if (!/[A-Za-z0-9_.]/.test(text.slice(1))) continue;
    const index = match.index;
    if (index > 0 && !/\s/.test(scan.text[index - 1])) continue;
    const start = scan.chars[index];
    const end = scan.chars[index + text.length - 1];
    if (!start || !end) continue;
    found.push({ text, start, end });
  }
  return found;
}

function candidateRange(candidate: Candidate): IBufferRange {
  // end.x is the 0-based exclusive column, which xterm reads as the 1-based
  // inclusive last cell — the wide-char-aware tail of the token.
  return {
    start: { x: candidate.start.x, y: candidate.start.y },
    end: { x: candidate.end.x - 1 + candidate.end.width, y: candidate.end.y },
  };
}

function makeLink(candidate: Candidate, hooks: TerminalPathLinkHooks): ILink {
  const range = candidateRange(candidate);
  return {
    range,
    text: candidate.text,
    // Local document activation belongs exclusively to the capture gate in
    // terminal-document-links, mirroring the OSC 8 handler; a non-document
    // path keeps a plain Linkifier callback like the bare-URL route.
    activate: (_event, text) => {
      if (terminalDocumentPath(text) === null) hooks.openPath(text);
    },
    hover: (_event, text) => hooks.hover(text, range),
    leave: () => hooks.leave(),
  };
}

export function createTerminalPathLinkProvider(
  term: Terminal,
  hooks: TerminalPathLinkHooks,
  probe: (path: string) => Promise<boolean> = (path) => window.condash.termPathExists(path),
): { provider: ILinkProvider; dispose(): void } {
  const cache = new Map<string, { value: boolean; at: number }>();
  const inflight = new Map<string, Promise<boolean>>();
  let activeProbes = 0;
  const waiting: (() => void)[] = [];

  const runProbe = (path: string): Promise<boolean> =>
    new Promise((resolveProbe) => {
      const start = (): void => {
        activeProbes++;
        probe(path)
          .catch(() => false)
          .then((value) => {
            activeProbes--;
            const next = waiting.shift();
            if (next) next();
            cache.set(path, { value, at: Date.now() });
            resolveProbe(value);
          });
      };
      if (activeProbes >= MAX_CONCURRENT_PROBES) waiting.push(start);
      else start();
    });

  const exists = (path: string): Promise<boolean> => {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return Promise.resolve(hit.value);
    const pending = inflight.get(path);
    if (pending) return pending;
    const task = runProbe(path).finally(() => inflight.delete(path));
    inflight.set(path, task);
    return task;
  };

  const provide = async (
    y: number,
    callback: (links: ILink[] | undefined) => void,
  ): Promise<void> => {
    try {
      const scan = buildWindow(term.buffer.active, y - 1);
      if (!scan) return callback(undefined);
      const candidates = collectCandidates(scan);
      if (candidates.length === 0) return callback(undefined);
      const results = await Promise.all(candidates.map((candidate) => exists(candidate.text)));
      const links = candidates
        .map((candidate, index) => (results[index] ? makeLink(candidate, hooks) : null))
        .filter((link): link is ILink => link !== null);
      callback(links.length > 0 ? links : undefined);
    } catch {
      callback(undefined);
    }
  };

  return {
    provider: {
      provideLinks(y, callback) {
        void provide(y, callback);
      },
    },
    dispose() {
      cache.clear();
      inflight.clear();
      waiting.length = 0;
    },
  };
}
