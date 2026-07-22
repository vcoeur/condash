import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IMarker, Terminal } from '@xterm/headless';
import type { TaskRunContext, TermDeath, TermSide, TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';
import { perfLog } from './perf-log';
import { META_LINE_PREFIX, type LogKind } from './logs-format';
import {
  OscTranscriptExtractor,
  timestampMarker,
  type TranscriptCursor,
  type TranscriptDelta,
  type TranscriptFrame,
} from './osc-transcript';
import { rotateTaskRuns, taskRunDir, taskRunLogPath } from './task-runs';

/**
 * Single-session writer. One instance per pty spawn; lives from `open()`
 * to `close()`. Owns a headless xterm `Terminal` and mirrors the
 * rendered buffer into a **single file**:
 *
 *   `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt`
 *
 * No sidecar. Metadata travels inside the `.txt` as two `# condash: {…}`
 * JSON lines — a header line at the top (always present) and a footer
 * line at the bottom (only after `exit()`). The Logs pane and global
 * search both parse these lines back out; `cat`ing the file shows the
 * metadata too without any extra format.
 *
 * On-disk shape:
 *
 *   # condash: {"sid":"…","side":"…","cmd":"npm","argv":["run","dev"],
 *               "repo":"condash","cwd":"/home/…","started":"…Z"}
 *   <blank line>
 *   <rendered xterm buffer — plain UTF-8 text, one row per `\n`,
 *    trailing blanks per row trimmed; no SGR, no CSI, no cursor-forward>
 *   <blank line>            ← only present after exit()
 *   # condash: {"finished":"…Z","exitCode":0}   ← only after exit()
 *
 * Bytes flow: pty `output(data)` → `term.write(clean)`. A debounced timer
 * (default 5 s) writes the `.txt`, and its cost is kept proportional to NEW
 * output, not the retained size:
 *   - Transcript sessions **append only the lines added since the last write**
 *     — a per-flush watermark ({@link bodyCursor}) into the extractor, plus a
 *     byte-length + short tail sample of what's on disk — instead of re-joining
 *     the whole (multi-MB) transcript and prefix-comparing the whole file.
 *   - Grid sessions **re-translate only the rows that can still change**
 *     ({@link GridBodyRenderer}) — rows already above the viewport are frozen,
 *     so their rendered text is reused instead of being walked again. The
 *     *file* write is still a full rewrite (a grid repaint isn't append-shaped),
 *     and is skipped outright when no new bytes reached the term since the last
 *     write.
 * Any inconsistency (a byte-cap trim dropped written lines, the header `kind`
 * flipped, the on-disk length/tail no longer matches, a prior write error) and
 * the durable `exit()` / `close()` flushes take the atomic tmp → (fsync) →
 * rename full rewrite instead, which re-establishes the file and the
 * bookkeeping exactly. Only a compact watermark is retained in memory, never
 * the whole file text. The periodic flushes do NOT `fsync` — only the terminal
 * flushes (exit / close) do; the atomic rename already keeps the file from ever
 * being torn, appends never truncate existing content, and fsync-ing every
 * few-second flush stalls the main process for durability a log viewer doesn't
 * need.
 *
 * `input(data)` is intentionally a no-op — the pty echoes typed bytes
 * back through stdout, so feeding `in` into the headless xterm would
 * double-echo, and capturing keystrokes separately leaks a richer record
 * than `~/.bash_history`. Privacy win, no semantic loss for the logs
 * viewer use case.
 *
 * Colour / bold / underline are lost. The Logs pane is a monochrome
 * text viewer; if you want full ANSI fidelity, use the live terminal's
 * Save-buffer button instead.
 *
 * Buffer is bounded by xterm scrollback (default 5000 lines × 200 cols
 * ≈ 1 MB max plain text). No rotation — the file size is self-capped by
 * the same mechanism that bounds the live terminal pane.
 *
 * All filesystem errors are swallowed locally and logged to stderr — the
 * pty pipeline must never block on a misbehaving log writer. Pause /
 * disable cuts new writes; the existing file stays untouched.
 */
export interface SessionContext {
  sid: string;
  side: TermSide;
  repo?: string;
  cwd: string;
  spawn: { cmd: string; argv: string[] };
  /** When set, the session is a task run whose output is segregated out of
   *  `.condash/logs/` into `.condash/<trigger>/<taskSlug>/` — see
   *  `sessionLogPath`. Used for `excludeFromLogs` manual runs. */
  taskContext?: TaskRunContext;
}

/** Header-line JSON shape, written on every flush. */
interface HeaderMeta {
  sid: string;
  side: TermSide;
  repo?: string;
  cwd: string;
  cmd: string;
  argv: string[];
  started: string;
  kind: LogKind;
}

/** Footer-line JSON shape, appended on `exit()`.
 *
 * `exitCode` alone cannot distinguish a clean exit from an OOM kill — node-pty
 * reports 0 for a SIGKILLed process, so every kill in the field logged
 * `"exitCode":0` and the failure rate was unmeasurable. `death` carries the
 * derived verdict (and its evidence) so a post-mortem needs only the log file.
 * Optional: readers of logs written before this field existed must still parse. */
interface FooterMeta {
  finished: string;
  exitCode: number;
  death?: TermDeath;
}

/** Default opt-OUT: a fresh install records nothing until the user flips
 * the "Record terminal sessions to disk" checkbox in settings. The pref
 * is read once at SessionLogger construction time, so a user flipping
 * the toggle off while a session is already running does NOT mid-session
 * pause it — the next spawn picks up the new value. */
const DEFAULT_PREFS: Required<TerminalLoggingPrefs> = {
  enabled: false,
  retentionDays: 14,
  maxDirMb: 500,
  scrollback: 5000,
  markerIntervalSec: 60,
};

/** Default 5-second debounce. Pty `output` calls schedule the flush; the
 * timer fires once per debounce window, regardless of how many writes
 * happened in between. */
const DEFAULT_FLUSH_MS = 5000;

/** Headless xterm geometry. 200×50 is generous for any TUI we care about
 * (Claude Code, agent runs, top, vim); wider terminals re-wrap, which is
 * cosmetic. Settable later if anyone asks. */
const COLS = 200;
const ROWS = 50;

// Lazy handle on the `@xterm/headless` constructor. The import above is
// type-only; this cached require means importing this module — which happens on
// the pre-window boot path via `terminals` (killAll / startMemorySampling) and
// `task-scheduler` — never evaluates @xterm/headless's module graph before first
// paint. The headless Terminal is constructed only on the first grid byte of a
// logging-on session (see `ensureTerm`), a post-window event.
let headlessTerminalCtor: typeof import('@xterm/headless').Terminal | null = null;
function loadHeadlessTerminal(): typeof import('@xterm/headless').Terminal {
  headlessTerminalCtor ??= (require('@xterm/headless') as typeof import('@xterm/headless'))
    .Terminal;
  return headlessTerminalCtor;
}

/** Bytes of the file's tail kept in memory as a cheap integrity sample. Checked
 * before an incremental append (with the byte-length watermark) in place of the
 * old whole-file compare — a mismatch falls back to a full rewrite. */
const TAIL_SAMPLE_BYTES = 64;

/** Sentinel prefix for the metadata header / footer lines inside a
 * `.txt`. The `# ` mimics shell-comment syntax — readable in `cat`,
 * grep-friendly. Defined in `./logs-format` so the search / CLI graph can
 * reach it without dragging `@xterm/headless` along. Re-exported here for
 * back-compat with callers that historically imported it from this file. */
export { META_LINE_PREFIX };

/** Resolve the per-session log file path inside `conceptionPath`. Returns
 * the canonical `.txt` path, no side effects. When `taskContext` is supplied
 * the path is routed to the segregated `.condash/<trigger>/<taskSlug>/` store
 * (capability 4) instead of the normal `.condash/logs/YYYY/MM/DD/` tree, so a
 * flagged run never lands among the regular session logs. */
export function sessionLogPath(
  conceptionPath: string,
  sid: string,
  when: Date = new Date(),
  taskContext?: TaskRunContext,
): string {
  if (taskContext) {
    return taskRunLogPath(conceptionPath, taskContext.trigger, taskContext.taskSlug, sid, when);
  }
  const yyyy = String(when.getFullYear());
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const dd = String(when.getDate()).padStart(2, '0');
  const hh = String(when.getHours()).padStart(2, '0');
  const mi = String(when.getMinutes()).padStart(2, '0');
  const ss = String(when.getSeconds()).padStart(2, '0');
  return join(condashLogsRoot(conceptionPath), yyyy, mm, dd, `${hh}${mi}${ss}-${sid}.txt`);
}

/** Apply `TerminalLoggingPrefs` patch on top of the defaults. Internal —
 * exported only for tests. */
export function resolveLoggingPrefs(patch?: TerminalLoggingPrefs): Required<TerminalLoggingPrefs> {
  if (!patch) return { ...DEFAULT_PREFS };
  return {
    enabled: patch.enabled ?? DEFAULT_PREFS.enabled,
    retentionDays: patch.retentionDays ?? DEFAULT_PREFS.retentionDays,
    maxDirMb: patch.maxDirMb ?? DEFAULT_PREFS.maxDirMb,
    scrollback: patch.scrollback ?? DEFAULT_PREFS.scrollback,
    markerIntervalSec: patch.markerIntervalSec ?? DEFAULT_PREFS.markerIntervalSec,
  };
}

/**
 * Incremental grid-body renderer — one per {@link SessionLogger}.
 *
 * A grid flush used to walk EVERY buffer row through `translateToString`,
 * scrollback included: ~5000 rows × 200 cols (roughly a 1 MB string, plus one
 * `IBufferLine` wrapper allocated per row) on the main thread every 5 s, for a
 * flush that may have added a handful of lines. That is O(retained size), not
 * O(new output), and the render-skip guard in {@link SessionLogger.flushNow}
 * cannot cover it — the guard only fires when NO byte reached the term since
 * the last write, yet the same `output()` call that bumps that watermark is the
 * only thing that ever schedules a flush.
 *
 * So the grid body renders the way the transcript body already writes: only the
 * new part. Rows above the viewport (`[0, baseY)`) have scrolled out of the
 * cursor's reach and can never change again, so their rendered text is kept and
 * reused; only the viewport and whatever was appended below it is re-translated.
 * The output is byte-identical to translating every row from scratch.
 *
 * Scrollback eviction shifts every row index down, so the cache is anchored to
 * an xterm **marker** rather than to an absolute index: xterm moves a marker
 * down by each evicted line and disposes it once its own line is evicted —
 * exactly the mapping the cache needs, with a disposed marker degrading to a
 * full render.
 *
 * The marker is pinned at the LAST frozen row (`baseY - 1`), never at `baseY`.
 * `CSI L` (insert lines) with the cursor on the viewport's top row inserts at
 * index `baseY`, and xterm shifts any marker at or below an insert's index — so
 * a marker pinned at `baseY` slides one row INTO the viewport, and a later
 * eviction cancels the sign of that slide so the arithmetic guard below no
 * longer rejects it, yielding a body off by one row. Pinned one row higher,
 * every insert / delete lands strictly below the marker (they are all bounded
 * by the scroll region, which starts at `baseY` at the earliest) and only an
 * eviction can move it.
 */
export class GridBodyRenderer {
  /** Rendered text of buffer rows `[0, baseY)` as of the last render — the rows
   *  that were already frozen then, so their text can be reused verbatim. */
  private frozenRows: string[] = [];
  /** Marker pinned at the last frozen row of that render. Null when the last
   *  render had no scrollback to reuse, or the cache has been dropped. */
  private marker: IMarker | null = null;

  /** Takes the term at construction rather than per render so the buffer-swap
   *  subscription below cannot be forgotten by a caller — dropping the cache on
   *  a swap is a correctness requirement, not a tuning knob. */
  constructor(private readonly term: Terminal) {
    // An alternate-screen switch, or a full reset (`RIS`) — which installs
    // brand new buffer objects — leaves the marker anchored in a buffer that is
    // no longer the one being rendered, and its row indices mean nothing here.
    this.term.buffer.onBufferChange(() => this.invalidate());
  }

  /** Drop the cache so the next render translates every row again. */
  invalidate(): void {
    this.marker?.dispose();
    this.marker = null;
    this.frozenRows = [];
  }

  /** Read every populated row of the headless xterm buffer (scrollback +
   *  viewport) as plain UTF-8 text, reusing the frozen prefix of the previous
   *  render. `translateToString(true)` trims trailing blanks per row, which
   *  keeps the file from carrying the wide xterm grid's empty cells. Rows are
   *  joined with `\n`. */
  render(): string {
    const buffer = this.term.buffer.active;
    const rows = this.reusableRows(buffer.length);
    for (let y = rows.length; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      rows.push(line ? line.translateToString(true) : '');
    }
    // Snapshot the cache BEFORE the trailing-blank pop below: the pop can reach
    // back into the frozen prefix (a cleared screen leaves the tail of
    // scrollback empty), and the cache is indexed by absolute row.
    this.rememberFrozenRows(rows);
    // Drop the trailing run of empty rows — terminal buffers are usually
    // padded with blanks all the way to the viewport bottom.
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** The prefix of the previous render that is still valid, as a fresh array the
   *  caller appends the re-translated remainder onto. Empty when there is no
   *  usable cache. */
  private reusableRows(bufferLength: number): string[] {
    const marker = this.marker;
    if (!marker || marker.isDisposed) return [];
    // `marker.line` is the last frozen row's CURRENT index — xterm decremented
    // it once per evicted line — so it doubles as the reusable row count and as
    // the measure of how far the cache has slid.
    const reusable = marker.line + 1;
    const evicted = this.frozenRows.length - reusable;
    // A negative `evicted` means the marker moved the wrong way; anything past
    // the buffer's end means rows vanished from under it. Neither maps onto the
    // cache, so re-translate everything.
    if (evicted < 0 || reusable > bufferLength) return [];
    return this.frozenRows.slice(evicted);
  }

  /** Cache the rows frozen as of this render and re-pin the marker. The previous
   *  marker is disposed first: xterm walks every live marker on every evicted
   *  line, so leaking one per flush would make eviction cost grow without
   *  bound. */
  private rememberFrozenRows(rows: string[]): void {
    this.marker?.dispose();
    this.marker = null;
    const buffer = this.term.buffer.active;
    const frozen = buffer.baseY;
    this.frozenRows = frozen > 0 ? rows.slice(0, frozen) : [];
    if (frozen === 0) return;
    // `registerMarker` takes an offset from the cursor, which sits at
    // `baseY + cursorY`; the last frozen row is `baseY - 1`. Returns undefined
    // on the alternate buffer, which has no scrollback to reuse anyway.
    this.marker = this.term.registerMarker(-1 - buffer.cursorY) ?? null;
  }
}

export class SessionLogger {
  private prefs: Required<TerminalLoggingPrefs>;
  /** Headless xterm buffer for the grid-body render. Constructed lazily on the
   * first grid byte (see {@link ensureTerm}) so a logging-off spawn or a pure
   * OSC-transcript session never allocates one. Null until then / after close. */
  private term: Terminal | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Tail of the serialised flush chain. Each new flush appends; close
   * awaits the tail so all writes drain before the term is disposed. */
  private flushChain: Promise<void> = Promise.resolve();
  private readonly startedTs: string;
  private exitCode: number | undefined;
  private death: TermDeath | undefined;
  private finishedTs: string | undefined;
  private readonly txtPath: string;
  /** When the session is a segregated task run, the `<trigger>/<slug>` dir to
   * prune to the last ~5 runs once this run's file exists. Null otherwise. */
  private readonly rotateDir: string | null;
  private closed = false;
  /** Single close pass shared by every close() caller. */
  private closePromise: Promise<void> | null = null;
  private paused = false;
  private dirty = false;
  // ── On-disk bookkeeping (replaces retaining the whole file text in memory).
  // Compact watermark of what's currently in `txtPath`, so a periodic flush can
  // append only the new transcript suffix (or skip a redundant grid render)
  // without re-composing + prefix-comparing the whole (multi-MB) file. Any
  // inconsistency resets these to force a full atomic rewrite next flush.
  /** File length in **bytes** last written, or null when the next flush must do
   * a full rewrite (nothing on disk yet, or a prior write failed). */
  private diskLen: number | null = null;
  /** The exact header line (`# condash: {…}`) last written. A change — the
   * grid→transcript `kind` flip, say — forces a full rewrite. */
  private writtenHeaderLine: string | null = null;
  /** Which body kind is currently on disk, so a kind flip forces a full rewrite. */
  private writtenKind: LogKind | null = null;
  /** Transcript watermark matching the on-disk body, for the incremental
   * append. Null when the on-disk body is a grid snapshot / nothing. */
  private bodyCursor: TranscriptCursor | null = null;
  /** Last few bytes on disk — a cheap tail sample checked before an incremental
   * append (the short-form replacement for the old whole-file `startsWith`). A
   * mismatch (or a length mismatch vs {@link diskLen}) falls back to a rewrite. */
  private writtenTail: Buffer = Buffer.alloc(0);
  /** {@link termBytesSeen} at the last grid write — lets a grid flush skip the
   * whole-buffer render when no new bytes reached the term since. -1 = none. */
  private lastGridBytes = -1;
  /** {@link gridMarkers} length at the last grid write, paired with
   * {@link lastGridBytes} so a pending marker still forces a rewrite. -1 = none. */
  private lastGridMarkerCount = -1;
  /** Running count of bytes written into the headless term (the grid-body
   * source), the watermark the grid render-skip compares against. */
  private termBytesSeen = 0;
  private readonly flushMs: number;
  /** Pulls any in-band "agent transcript over OSC" frames out of the pty
   * stream. Harness-blind: it knows the generic protocol, not the program.
   * When a session speaks it, the log body becomes the clean transcript
   * instead of the grid snapshot. */
  private readonly oscTranscript = new OscTranscriptExtractor();
  /** Renders the grid body, reusing the frozen scrollback prefix between
   *  flushes so a flush costs O(new rows) instead of O(scrollback). Built with
   *  the term in {@link ensureTerm}, so null for as long as the term is. */
  private gridBody: GridBodyRenderer | null = null;
  /** Injectable clock — stamps `started`/`finished` and the timestamp markers
   * so tests can drive cadence deterministically. */
  private readonly now: () => Date;
  /** Wall-clock ms between in-body timestamp markers; `0` disables them. */
  private readonly markerIntervalMs: number;
  /** True once output arrived since the last marker — the "new content" gate.
   * Kept distinct from `dirty` (which exit/close also set) so a close flush
   * never stamps an idle session. */
  private contentSinceMarker = false;
  /** Wall-clock of the last emitted marker, seeded to the session start so the
   * first interval is silent (the header already records `started`). */
  private lastMarkerAt: Date;
  /** Append-only marker timeline for a grid log, rendered as a trailing block.
   * Grid bodies are full repaints, so a marker cannot live inline — this lives
   * in logger state and survives the repaint. Stays empty for transcripts. */
  private readonly gridMarkers: string[] = [];

  constructor(
    conceptionPath: string,
    private readonly ctx: SessionContext,
    prefs?: TerminalLoggingPrefs,
    /** Test hook — override the debounce window. */
    flushMs: number = DEFAULT_FLUSH_MS,
    /** Test hook — injectable clock for deterministic timestamp markers. */
    now: () => Date = () => new Date(),
  ) {
    this.prefs = resolveLoggingPrefs(prefs);
    this.flushMs = flushMs;
    this.now = now;
    this.markerIntervalMs = this.prefs.markerIntervalSec * 1000;
    const start = now();
    this.startedTs = start.toISOString();
    this.lastMarkerAt = start;
    this.txtPath = sessionLogPath(conceptionPath, ctx.sid, start, ctx.taskContext);
    this.rotateDir = ctx.taskContext
      ? taskRunDir(conceptionPath, ctx.taskContext.trigger, ctx.taskContext.taskSlug)
      : null;
  }

  /** Lazily construct the headless xterm on first need (a grid byte to render).
   * Deferred out of the constructor so a logging-off spawn or a session that
   * only ever emits OSC-transcript frames never allocates the ~MB buffer. */
  private ensureTerm(): Terminal {
    if (!this.term) {
      const Terminal = loadHeadlessTerminal();
      this.term = new Terminal({
        cols: COLS,
        rows: ROWS,
        scrollback: this.prefs.scrollback,
        // Required since xterm.js 5.4 for `ILinkProvider` and the buffer-line
        // APIs used by `renderBufferAsPlainText`. Safe to leave enabled — the
        // flag only unlocks stable APIs that haven't been promoted to default.
        allowProposedApi: true,
      });
      this.gridBody = new GridBodyRenderer(this.term);
    }
    return this.term;
  }

  /** True when new writes should be accepted. Lets callers short-circuit
   * the per-event xterm.write cost when capture is off. */
  isEnabled(): boolean {
    return this.prefs.enabled && !this.closed && !this.paused;
  }

  setPaused(paused: boolean): void {
    if (paused && !this.paused) this.flushNowFireAndForget();
    this.paused = paused;
  }

  /** Called once at the start of a session. Establishes the on-disk
   * presence so a session that never produces output still shows up in
   * the Logs pane (file with just the header line). */
  spawn(): void {
    if (!this.isEnabled()) return;
    // Force an immediate write so the file exists with at least the
    // header line, even if no output ever follows.
    this.dirty = true;
    this.flushNowFireAndForget();
    // For a segregated task run, prune the dir to the last ~5 runs once this
    // run's file lands. Best-effort + fire-and-forget — never blocks the pty.
    if (this.rotateDir) void rotateTaskRuns(this.rotateDir);
  }

  /** No-op. Pty echoes typed bytes back through stdout. */
  input(_data: string): void {
    /* intentional no-op — see class doc */
  }

  /**
   * Record one pty output chunk.
   *
   * @param data - The raw pty chunk (used to gate empty writes; the caller may
   *   pass `pre` so this chunk is not OSC-scanned a second time here).
   * @param pre - When supplied, the result of the single OSC scan `terminals.ts`
   *   already ran for the session-wide dashboard extractor: the stripped `clean`
   *   text and the frames it decoded. The logger reuses them — writing `clean`
   *   to the grid term and replaying `frames` into its own transcript extractor
   *   — instead of scanning the same bytes again. Omitted by standalone callers
   *   (task runs, tests), which have no shared extractor, so the logger scans.
   */
  output(data: string, pre?: { clean: string; frames: TranscriptFrame[] }): void {
    if (!this.isEnabled() || data.length === 0) return;
    // Strip any in-band transcript OSC out of the stream first, so the grid
    // render never carries it; feed only the remainder to xterm.
    let clean: string;
    if (pre) {
      clean = pre.clean;
      for (const frame of pre.frames) this.oscTranscript.applyDecodedFrame(frame);
    } else {
      clean = this.oscTranscript.feed(data);
    }
    if (clean.length > 0) {
      this.ensureTerm().write(clean);
      this.termBytesSeen += clean.length;
    }
    this.dirty = true;
    // Any chunk is new content — even a transcript-only chunk (clean empty,
    // its message captured above). Opens the marker's content gate.
    this.contentSinceMarker = true;
    this.scheduleFlush();
  }

  exit(exitCode: number, death?: TermDeath): void {
    if (!this.isEnabled()) return;
    this.exitCode = exitCode;
    this.death = death;
    this.finishedTs = this.now().toISOString();
    this.dirty = true;
    // Terminal flush — fsync the final footer state to disk.
    this.flushNowFireAndForget(true);
  }

  /** Idempotent — concurrent and repeated calls share one close pass.
   * Resolves once every pending flush (including output that raced the
   * close) is on disk and the xterm is disposed. */
  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.cancelFlush();
    // Drain in a loop: an output() arriving while a flush is awaited
    // re-dirties the buffer, and a single-pass await would then flip
    // `closed` with those tail bytes unwritten. Pass-bounded so a
    // pathological writer can't hold close() open forever.
    for (let pass = 0; this.dirty && pass < 20; pass++) {
      this.flushNowFireAndForget();
      await this.flushChain;
    }
    await this.flushChain;
    // Terminal flush: fsync the final state once. The periodic flushes above
    // wrote it unsynced, and a session killed without exit() (quit / SIGKILL)
    // never hit exit()'s sync — so force one durable write here. Gated on
    // `enabled` so a logging-off session still writes nothing.
    if (this.prefs.enabled) {
      this.dirty = true;
      this.flushNowFireAndForget(true);
      await this.flushChain;
    }
    this.cancelFlush();
    this.closed = true;
    this.gridBody?.invalidate();
    if (this.term) this.term.dispose();
  }

  /** Test hook — force an immediate flush regardless of debounce. */
  async flushForTests(): Promise<void> {
    this.flushNowFireAndForget();
    await this.flushChain;
  }

  /** Absolute path of the rendered `.txt` file. Returns the canonical
   * path even before the first flush — file may not yet exist on disk. */
  filePath(): string | null {
    return this.txtPath;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNowFireAndForget();
    }, this.flushMs);
  }

  private cancelFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushNowFireAndForget(sync = false): void {
    // Append onto the serialised chain — never run two flushes
    // concurrently against the same `.txt.tmp`.
    this.flushChain = this.flushChain
      .then(() => this.flushNow(sync))
      .catch((err: Error) => {
        process.stderr.write(`condash terminal-logger: flush failed: ${err.message}\n`);
      });
  }

  /** Render the buffer and write it to the `.txt`. `sync` forces an fsync before
   *  the rename for durability — set only on the terminal flushes (exit / close),
   *  not the periodic ones (see the class doc). Periodic flushes take a cheap
   *  incremental path when they can (append the new transcript suffix, or skip a
   *  redundant grid render); anything else, and every `sync` flush, does the full
   *  atomic tmp → (fsync) → rename rewrite. */
  private async flushNow(sync = false): Promise<void> {
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    // Snapshot the grid byte watermark BEFORE the drain below: it counts bytes
    // handed to the term, and only those written ahead of the drain marker are
    // guaranteed parsed into the buffer this flush renders. output() racing any
    // of this method's awaits advances the count for bytes the rendered body
    // may not contain — recording that inflated count would let the next flush
    // wrongly take the render-skip and silently drop them (L1). An under-count
    // merely costs one redundant rewrite.
    const renderGridBytes = this.termBytesSeen;
    // Wait for any queued xterm parse to complete before rendering — otherwise
    // the buffer may not reflect the most recent `output` call. No term until
    // the first grid byte arrives (lazy), so a transcript-only / never-wrote
    // session has nothing to drain.
    if (this.term) {
      await new Promise<void>((resolve) => this.term!.write('', () => resolve()));
    }
    if (this.closed) return;
    // A session that emitted an in-band transcript gets the clean transcript
    // as its body; everything else falls back to the rendered grid.
    const isTranscript = this.oscTranscript.hasTranscript();
    this.maybeEmitTimestampMarker(isTranscript);
    const kind: LogKind = isTranscript ? 'transcript' : 'grid';
    const headerLine = this.composeHeaderLine(kind);

    // Grid render-skip: a grid body is a full repaint, not append-shaped, so it
    // never takes the incremental path — but when no new bytes reached the term
    // and no new marker is pending since the last grid write, the snapshot is
    // byte-identical to what's on disk. Skip the (multi-MB `translateToString`)
    // render and the write. `sync` flushes fall through so the footer lands.
    if (
      !sync &&
      !isTranscript &&
      this.diskLen !== null &&
      this.writtenKind === 'grid' &&
      this.writtenHeaderLine === headerLine &&
      this.termBytesSeen === this.lastGridBytes &&
      this.gridMarkers.length === this.lastGridMarkerCount
    ) {
      return;
    }

    // Transcript incremental append: append only the lines added since the last
    // write instead of re-joining + prefix-comparing the whole (multi-MB) file.
    if (
      !sync &&
      isTranscript &&
      // Once exit() has written the footer, the footer is the file's last line —
      // an append would land content BELOW it. Force the full rewrite instead
      // (output() can still arrive after exit() on the scheduler kill path).
      this.exitCode === undefined &&
      this.diskLen !== null &&
      this.writtenKind === 'transcript' &&
      this.writtenHeaderLine === headerLine &&
      this.bodyCursor !== null &&
      this.bodyCursor.appended > this.bodyCursor.trimmed // prior body non-empty
    ) {
      const delta = this.oscTranscript.appendedSince(this.bodyCursor);
      if (delta !== null && (await this.appendTranscriptDelta(delta))) return;
      // delta === null (a cap trim dropped written lines) or the tail/length
      // guard failed → fall through to the full rewrite, which re-establishes
      // the file and the bookkeeping exactly.
    }

    // Full atomic rewrite: grid repaint, first write, header/kind flip, a trim,
    // a guard mismatch, or any terminal (sync) flush.
    // The grid path re-translates only the rows that can still have changed
    // (see GridBodyRenderer) — the rest of the snapshot is reused — so it is
    // timed separately from the per-chunk parse.
    const gridStart = !isTranscript && perfLog.isEnabled() ? process.hrtime.bigint() : 0n;
    const body = isTranscript
      ? this.oscTranscript.render()
      : this.gridBody
        ? this.gridBody.render()
        : '';
    if (gridStart !== 0n) {
      perfLog.recordGridRender(this.ctx.sid, process.hrtime.bigint() - gridStart);
    }
    // Snapshot the transcript/marker watermarks that describe *this* body at
    // render time, BEFORE the async write window below. Pty output() runs
    // synchronously during the awaits (mkdir/open/writeFile/rename); reading
    // these in recordWrite() afterwards would fold those raced lines into the
    // on-disk bookkeeping though the just-written file lacks them — a permanent
    // silent hole the next incremental append starts past (L1). Both are exact
    // here: the extractor and the marker timeline are updated synchronously, so
    // they match render()'s output byte-for-byte. (The grid byte watermark was
    // snapshotted earlier, ahead of the xterm drain — see the top of flushNow.)
    const renderCursor = isTranscript ? this.oscTranscript.cursor() : null;
    const renderGridMarkerCount = this.gridMarkers.length;
    const text = this.composeFileContent(body, kind);
    try {
      await mkdir(dirname(this.txtPath), { recursive: true });
      // The atomic rename keeps the file from ever being torn / zero-length;
      // fsync makes the content itself durable across power loss. Periodic
      // flushes skip the fsync (a live session re-snapshots every few seconds —
      // fsync-ing each stalls the main process's libuv threadpool for durability
      // the log viewer doesn't need); the exit / close flushes pass `sync`.
      const tmp = `${this.txtPath}.tmp`;
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        if (sync) await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.txtPath);
      this.recordWrite(
        text,
        kind,
        headerLine,
        renderCursor,
        renderGridBytes,
        renderGridMarkerCount,
      );
    } catch (err) {
      process.stderr.write(`condash terminal-logger: write failed: ${(err as Error).message}\n`);
      // Bookkeeping may now be stale (a partial write, a failed rename): force a
      // full rewrite on the next flush to re-establish the file exactly.
      this.resetBookkeeping();
    }
  }

  /** Append a transcript delta onto the on-disk file, after a cheap check that
   *  the file still matches our length + tail watermark. Returns false (caller
   *  falls back to a full rewrite) on any mismatch or write error. The file is
   *  `header\n\n<body>\n` in-flight; extending `<body>` by `delta.appended`
   *  (which starts with `\n\n` — guaranteed by the caller's non-empty-body gate)
   *  appends exactly `delta.appended.slice(1) + '\n'`: the file's existing
   *  trailing `\n` doubles as the first `\n` of the new separator. */
  private async appendTranscriptDelta(delta: TranscriptDelta): Promise<boolean> {
    if (delta.appended.length === 0) {
      this.bodyCursor = delta.cursor; // nothing new to write; watermark still advances
      return true;
    }
    const deltaBytes = Buffer.from(`${delta.appended.slice(1)}\n`, 'utf8');
    try {
      if (!(await this.diskTailMatches())) return false;
      const fh = await open(this.txtPath, 'a');
      try {
        await fh.write(deltaBytes);
      } finally {
        await fh.close();
      }
      this.diskLen = (this.diskLen ?? 0) + deltaBytes.length;
      this.writtenTail = tailBytes(
        Buffer.concat([this.writtenTail, deltaBytes]),
        TAIL_SAMPLE_BYTES,
      );
      this.bodyCursor = delta.cursor;
      return true;
    } catch (err) {
      process.stderr.write(`condash terminal-logger: append failed: ${(err as Error).message}\n`);
      this.resetBookkeeping();
      return false;
    }
  }

  /** Cheap integrity check before an incremental append (the short-form
   *  replacement for the old whole-file `startsWith`): the file must still be
   *  exactly {@link diskLen} bytes and end with the {@link writtenTail} we last
   *  wrote. Reads only the trailing sample, never the whole file. */
  private async diskTailMatches(): Promise<boolean> {
    const fh = await open(this.txtPath, 'r');
    try {
      const st = await fh.stat();
      if (st.size !== this.diskLen) return false;
      const want = this.writtenTail;
      if (want.length === 0) return true;
      const got = Buffer.alloc(want.length);
      await fh.read(got, 0, want.length, st.size - want.length);
      return got.equals(want);
    } finally {
      await fh.close();
    }
  }

  /** Record the compact on-disk bookkeeping after a successful full rewrite. The
   *  watermarks are the ones captured at render time (before the write's async
   *  window) — NOT the extractor's current state, which output() may have
   *  advanced during the awaits (L1). */
  private recordWrite(
    text: string,
    kind: LogKind,
    headerLine: string,
    renderCursor: TranscriptCursor | null,
    renderGridBytes: number,
    renderGridMarkerCount: number,
  ): void {
    const bytes = Buffer.from(text, 'utf8');
    this.diskLen = bytes.length;
    this.writtenTail = tailBytes(bytes, TAIL_SAMPLE_BYTES);
    this.writtenKind = kind;
    this.writtenHeaderLine = headerLine;
    // The transcript cursor matches the body just rendered. Grid bodies aren't
    // append-tracked → null.
    this.bodyCursor = kind === 'transcript' ? renderCursor : null;
    if (kind === 'grid') {
      this.lastGridBytes = renderGridBytes;
      this.lastGridMarkerCount = renderGridMarkerCount;
    }
  }

  /** Drop all on-disk bookkeeping so the next flush does a full rewrite. */
  private resetBookkeeping(): void {
    this.diskLen = null;
    this.writtenTail = Buffer.alloc(0);
    this.writtenKind = null;
    this.writtenHeaderLine = null;
    this.bodyCursor = null;
    this.lastGridBytes = -1;
    this.lastGridMarkerCount = -1;
  }

  /** Emit a timestamp marker when the cadence interval has elapsed AND new
   * output arrived since the last marker. An idle session never schedules a
   * flush, so this is never reached for a stale terminal — the two gates
   * together give "a regular-interval marker, only when there is new content".
   * A transcript marker lands in the message stream; a grid marker appends to
   * the trailing timeline (a grid body is a repaint and can't host it inline).
   */
  private maybeEmitTimestampMarker(isTranscript: boolean): void {
    if (this.markerIntervalMs <= 0 || !this.contentSinceMarker) return;
    const now = this.now();
    if (now.getTime() - this.lastMarkerAt.getTime() < this.markerIntervalMs) return;
    const marker = timestampMarker(now);
    if (isTranscript) this.oscTranscript.pushTimestampMarker(marker);
    else this.gridMarkers.push(marker);
    this.contentSinceMarker = false;
    this.lastMarkerAt = now;
  }

  /** The `# condash: {…}` header line for `kind`. Single-sourced so the
   * incremental flush's header-change guard compares byte-identically against
   * what {@link composeFileContent} writes. */
  private composeHeaderLine(kind: LogKind): string {
    const header: HeaderMeta = {
      sid: this.ctx.sid,
      side: this.ctx.side,
      ...(this.ctx.repo ? { repo: this.ctx.repo } : {}),
      cwd: this.ctx.cwd,
      cmd: this.ctx.spawn.cmd,
      argv: this.ctx.spawn.argv,
      started: this.startedTs,
      kind,
    };
    return `${META_LINE_PREFIX}${JSON.stringify(header)}`;
  }

  /** Assemble the on-disk text: header line, blank, body, then (for a grid log
   * with markers) a trailing `<!-- timeline -->` block, then (if the session
   * has exited) blank + footer line. `kind` records whether `body` is the OSC
   * transcript or the grid snapshot, so readers needn't guess. */
  private composeFileContent(body: string, kind: LogKind): string {
    const lines: string[] = [this.composeHeaderLine(kind), ''];
    if (body.length > 0) lines.push(body);
    // Grid bodies are repaints, so the interval markers live here in a trailing
    // block instead of inline (transcripts carry theirs in the body already).
    if (kind === 'grid' && this.gridMarkers.length > 0) {
      lines.push('', '<!-- timeline -->', ...this.gridMarkers);
    }
    if (this.exitCode !== undefined && this.finishedTs !== undefined) {
      const footer: FooterMeta = {
        finished: this.finishedTs,
        exitCode: this.exitCode,
        ...(this.death ? { death: this.death } : {}),
      };
      lines.push('', `${META_LINE_PREFIX}${JSON.stringify(footer)}`);
    }
    return lines.join('\n') + '\n';
  }
}

/** The last `n` bytes of `buf` (the whole buffer when shorter). */
function tailBytes(buf: Buffer, n: number): Buffer {
  return buf.length <= n ? buf : buf.subarray(buf.length - n);
}
