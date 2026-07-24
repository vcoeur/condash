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
 * output, not the retained size. **Both bodies are append-only:**
 *   - Transcript sessions **append only the lines added since the last write**
 *     — a per-flush watermark ({@link bodyCursor}) into the extractor, plus a
 *     byte-length + short tail sample of what's on disk — instead of re-joining
 *     the whole (multi-MB) transcript and prefix-comparing the whole file.
 *   - Grid sessions **append the rows that froze since the last write** and
 *     rewrite only the ≤ `ROWS`-row live tail ({@link GridBodyRenderer}). Rows
 *     above the viewport can never change again, so the file grows past them
 *     once and the flush never touches the retained buffer at all. A flush is
 *     skipped outright when no new bytes reached the term since the last write.
 * Any inconsistency (a byte-cap trim dropped written lines, the header `kind`
 * flipped, the on-disk length/tail no longer matches, a prior write error) falls
 * back to the atomic tmp → (fsync) → rename full rewrite, which re-establishes
 * the file and the bookkeeping exactly — for a grid body that means the history
 * before the live buffer is dropped, exactly as the pre-append-only writer
 * always did. Neither body retains the file text in memory: the transcript path
 * keeps a compact watermark, the grid path a byte offset and one xterm marker.
 * The periodic flushes do NOT `fsync` — only the terminal flushes (exit /
 * close) do; the atomic rename already keeps the file from ever being torn,
 * appends never truncate committed content, and fsync-ing every few-second
 * flush stalls the main process for durability a log viewer doesn't need.
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
 * The headless buffer is bounded by xterm scrollback (default 5000 lines ×
 * 200 cols ≈ 1 MB), but the FILE is not — an appended grid body keeps output
 * the buffer has since evicted. {@link MAX_GRID_BODY_BYTES} caps it, mirroring
 * the transcript's `MAX_TRANSCRIPT_BYTES`; past the cap the oldest half of the
 * appended history is dropped in one atomic rewrite. No rotation.
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

/**
 * The four numbers that decide how much work a grid flush is: the geometry, the
 * default scrollback, and the flush period.
 *
 * Exported because `scripts/perf-load.mjs` mirrors them to report which side of
 * the `scrollback + rows` buffer a load profile lands on, and that report is the
 * only thing telling an operator whether a run can measure the incremental
 * renderer at all. The harness is plain ESM run by bare `node` and cannot import
 * this module, so it keeps its own copy — and `terminal-logger-harness-mirror.
 * test.ts` compares the two, so a change here fails the suite instead of
 * silently invalidating every figure the harness prints.
 */
export const LOGGER_GRID_GEOMETRY = {
  cols: COLS,
  rows: ROWS,
  scrollback: DEFAULT_PREFS.scrollback,
  flushMs: DEFAULT_FLUSH_MS,
} as const;

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

/** Byte cap on a grid log's appended body, mirroring `MAX_TRANSCRIPT_BYTES`.
 *
 * A repainted grid body was self-capped at `scrollback × cols` (~1 MB) because
 * it only ever held what the headless buffer still had. An APPENDED one keeps
 * everything the session ever printed, so it needs a cap of its own — without
 * one a single noisy tab would push the janitor's `maxDirMb` sweep into evicting
 * every other session's log. Past the cap the oldest half of the appended
 * history is dropped, in one atomic rewrite, at the next flush. */
export const MAX_GRID_BODY_BYTES = 8 * 1024 * 1024;

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

/** One flush's worth of grid body, split at the line the file can be appended
 *  past. Produced by {@link GridBodyRenderer.renderDelta}. */
export interface GridBodyDelta {
  /** Rows that froze since the last committed delta. They are appended to the
   *  file once and never rewritten. Never ends with a blank row — see
   *  {@link GridBodyRenderer.renderDelta}. */
  frozen: string[];
  /** Rows the cursor can still reach (plus any blank rows held back from
   *  `frozen`), with the trailing run of blanks dropped. This is the region the
   *  writer truncates and rewrites on every flush. */
  tail: string[];
}

/**
 * Append-only grid-body renderer — one per {@link SessionLogger}.
 *
 * Buffer rows `[0, baseY)` have scrolled out of the cursor's reach and can
 * never change again. That invariant is what lets the grid body be *appended*
 * rather than repainted: each flush hands the writer the rows that froze since
 * the last one — written once, at the end of the file — plus the ≤ `ROWS`-row
 * live tail, which is the only region the writer rewrites.
 *
 * The history before that goes on the previous flush's version. Two prior
 * reviews (v4.40.1, v4.65.3) rejected an append-only grid body, and both were
 * right about what they judged: appending the *whole* body is unsafe because a
 * repaint is not append-shaped. The **partial** append is a different claim,
 * and it rests on the frozen-prefix invariant that only arrived with the
 * incremental renderer in v4.97.1.
 *
 * What this removes from a flush: the `rows.join('\n')` over the retained
 * buffer, the second full copy in `composeFileContent`, the duplicate
 * `Buffer.from` encode, and the O(retained) file rewrite — all of which the
 * v4.97.1 incremental *row walk* left in place and which measured as the whole
 * remaining cost. The frozen-row text cache goes with them (~1.5 MB per logged
 * session), because a row that is on disk never needs to be held in memory.
 *
 * Two consequences, both documented in `docs/guides/terminal.md`:
 *
 *   - The body is no longer capped by xterm scrollback. It is a *superset* of
 *     what the repaint wrote — every flush's file still ENDS with exactly the
 *     buffer snapshot the old renderer would have produced — but it also keeps
 *     the output that has since scrolled away, which the old writer silently
 *     dropped. Growth is bounded by {@link MAX_GRID_BODY_BYTES} instead.
 *   - Output that scrolls past the whole scrollback *between two flushes*
 *     (> `scrollback` rows in one 5 s window) is still lost, exactly as before,
 *     and the file carries no marker where it happened.
 *
 * The append watermark is anchored to an xterm **marker** pinned at the last
 * appended row, not to an absolute index: eviction renumbers every row, and
 * xterm moves a marker down by each evicted line and disposes it once its own
 * line is evicted.
 *
 * The marker is pinned inside the frozen region, never at `baseY`. `CSI L`
 * (insert lines) with the cursor on the viewport's top row inserts at index
 * `baseY`, and xterm shifts any marker at or below an insert's index — so a
 * marker pinned at `baseY` slides one row INTO the viewport, and a later
 * eviction cancels the sign of that slide so the guard below no longer rejects
 * it, yielding a body off by one row. Pinned above, every insert / delete lands
 * strictly below the marker (they are all bounded by the scroll region, which
 * starts at `baseY` at the earliest) and only an eviction can move it.
 *
 * Buffer swaps are all handled by one rule — a marker at or past `baseY` is not
 * in the frozen region, so nothing of the buffer being rendered is on disk yet:
 *
 *   - **alternate screen**: `baseY` is 0 there, so the whole alt screen lands
 *     in the rewritable tail and the normal buffer's watermark is left alone,
 *     ready for the switch back. Verified: a marker registered on the normal
 *     buffer survives an alt-screen round trip with its `line` unchanged.
 *   - **`RIS`**: installs brand new buffer objects, so the marker points into a
 *     buffer nobody renders — and xterm does NOT dispose it. Caught in
 *     `onBufferChange`, where the fresh buffer still has `baseY === 0`; a
 *     render-time check alone would be too late, because output arriving before
 *     the next flush pushes `baseY` past the stale line and makes it look
 *     plausible again.
 *   - **`CSI 3J`** (erase scrollback) disposes the marker outright.
 */
export class GridBodyRenderer {
  /** Marker pinned at the last buffer row already appended to the file. Null
   *  when nothing of the buffer being rendered is on disk yet. */
  private appended: IMarker | null = null;
  /** Marker pinned at the last row of the delta the caller has not committed
   *  yet — adopted by {@link commit}, dropped by {@link abandon}. Held apart
   *  from {@link appended} so a failed write leaves the watermark describing
   *  what is actually on disk. */
  private pending: IMarker | null = null;

  /** Takes the term at construction rather than per render so the buffer-swap
   *  subscription below cannot be forgotten by a caller — noticing a `RIS` is a
   *  correctness requirement, not a tuning knob. */
  constructor(private readonly term: Terminal) {
    this.term.buffer.onBufferChange(() => this.onBufferSwap());
  }

  /** Forget the append watermark: the next delta re-renders every row of the
   *  buffer into `frozen` + `tail`, which is what a full file rewrite needs. */
  reset(): void {
    this.abandon();
    this.appended?.dispose();
    this.appended = null;
  }

  /**
   * Translate the rows that are not on disk yet and split them at the frozen
   * boundary. `translateToString(true)` trims trailing blanks per row, which
   * keeps the file from carrying the wide xterm grid's empty cells.
   *
   * The trailing run of blank rows inside the newly-frozen part is held back
   * into `tail`: the writer drops the body's trailing blanks, and a run that is
   * blank now (a cleared screen leaves the tail of scrollback empty) may sit
   * above real output two flushes later. Keeping it rewritable is what lets the
   * appended region stay byte-stable — it always ends on a non-blank row.
   */
  renderDelta(): GridBodyDelta {
    this.abandon();
    const buffer = this.term.buffer.active;
    const start = this.appendedRows(buffer);
    const rows: string[] = [];
    for (let y = start; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      rows.push(line ? line.translateToString(true) : '');
    }
    let frozenCount = Math.max(0, Math.min(buffer.baseY, buffer.length) - start);
    while (frozenCount > 0 && rows[frozenCount - 1] === '') frozenCount--;
    let frozen: string[] = [];
    let tail = rows;
    if (frozenCount > 0) {
      // `registerMarker` takes an offset from the cursor, which sits at
      // `baseY + cursorY`. Returns undefined on the alternate buffer — which
      // has `baseY === 0` and so never gets here — and a delta whose rows could
      // not be anchored must stay rewritable, or the next flush appends them a
      // second time.
      const lastFrozen = start + frozenCount - 1;
      const marker = this.term.registerMarker(lastFrozen - buffer.baseY - buffer.cursorY);
      if (marker) {
        this.pending = marker;
        frozen = rows.slice(0, frozenCount);
        tail = rows.slice(frozenCount);
      }
    }
    // Drop the trailing run of empty rows — terminal buffers are usually padded
    // with blanks all the way to the viewport bottom.
    while (tail.length > 0 && tail[tail.length - 1] === '') tail.pop();
    return { frozen, tail };
  }

  /** Move the append watermark onto the delta just written. The previous marker
   *  is disposed: xterm walks every live marker on every evicted line, so
   *  leaking one per flush would make eviction cost grow without bound. */
  commit(): void {
    if (!this.pending) return;
    this.appended?.dispose();
    this.appended = this.pending;
    this.pending = null;
  }

  /** Drop the uncommitted delta's marker — the write did not land, so the
   *  watermark must keep describing the file as it stands. */
  abandon(): void {
    this.pending?.dispose();
    this.pending = null;
  }

  /** How many rows of the buffer being rendered are already on disk. */
  private appendedRows(buffer: Terminal['buffer']['active']): number {
    const marker = this.appended;
    if (!marker || marker.isDisposed) return 0;
    // `marker.line` is the appended row's CURRENT index — xterm decremented it
    // once per evicted line. At or past `baseY` it is not in the frozen region
    // any more (alternate buffer, `RIS`, a cleared scrollback), so nothing of
    // this buffer has been appended.
    if (marker.line < 0 || marker.line >= buffer.baseY) return 0;
    return marker.line + 1;
  }

  /** `RIS` swapped in a buffer this marker never belonged to. Entering the
   *  alternate screen is not that: the normal buffer and its marker are
   *  untouched, and the alt screen has nothing frozen to append anyway. */
  private onBufferSwap(): void {
    const buffer = this.term.buffer.active;
    if (buffer.type !== 'normal') return;
    const marker = this.appended;
    if (!marker || marker.isDisposed) return;
    if (marker.line >= buffer.baseY) this.reset();
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
  /** Byte offset where the grid body's **appended** (immutable) region ends —
   * everything before it is frozen rows the writer never touches again, and a
   * grid flush truncates and rewrites from exactly here. Null when the on-disk
   * body is not an appended grid snapshot. */
  private gridFrozenEnd: number | null = null;
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
  /** Splits the grid body into the rows that just froze (appended once) and the
   *  live tail (rewritten each flush), so a flush costs O(new rows) rather than
   *  O(retained size) — see {@link GridBodyRenderer}. Built with the term in
   *  {@link ensureTerm}, so null for as long as it is. */
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
    /** Test hook — shrink {@link MAX_GRID_BODY_BYTES} so the trim path is
     *  reachable without pushing megabytes through a headless xterm. */
    private readonly maxGridBodyBytes: number = MAX_GRID_BODY_BYTES,
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
        // APIs {@link GridBodyRenderer} renders through — and for
        // `registerMarker`, which anchors its row cache. Safe to leave enabled —
        // the flag only unlocks stable APIs not yet promoted to default.
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
    this.gridBody?.reset();
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

    // Grid render-skip: when no new bytes reached the term and no new marker is
    // pending since the last grid write, the body is byte-identical to what's on
    // disk. Skip the render and the write. `sync` flushes fall through so the
    // footer lands.
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

    if (!isTranscript) {
      await this.flushGridBody(sync, headerLine, renderGridBytes);
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

    // Full atomic rewrite: first write, header/kind flip, a cap trim, a guard
    // mismatch, or any terminal (sync) flush.
    const body = this.oscTranscript.render();
    // Snapshot the transcript watermark that describes *this* body at render
    // time, BEFORE the async write window below. Pty output() runs synchronously
    // during the awaits (mkdir/open/writeFile/rename); reading it in
    // recordWrite() afterwards would fold those raced lines into the on-disk
    // bookkeeping though the just-written file lacks them — a permanent silent
    // hole the next incremental append starts past (L1). It is exact here: the
    // extractor is updated synchronously, so it matches render()'s output
    // byte-for-byte.
    const renderCursor = this.oscTranscript.cursor();
    const text = this.composeFileContent(body, kind);
    if (await this.writeFileAtomically(text, sync)) {
      this.recordWrite(
        text,
        kind,
        headerLine,
        renderCursor,
        renderGridBytes,
        this.gridMarkers.length,
      );
    }
  }

  /**
   * Write the whole file through the atomic tmp → (fsync) → rename dance.
   * Returns false on any error, with the bookkeeping already reset so the next
   * flush re-establishes the file exactly.
   *
   * The rename keeps the file from ever being torn / zero-length; fsync makes
   * the content itself durable across power loss. Periodic flushes skip the
   * fsync (a live session re-snapshots every few seconds — fsync-ing each stalls
   * the main process's libuv threadpool for durability the log viewer doesn't
   * need); the exit / close flushes pass `sync`.
   */
  private async writeFileAtomically(text: string, sync: boolean): Promise<boolean> {
    try {
      await mkdir(dirname(this.txtPath), { recursive: true });
      const tmp = `${this.txtPath}.tmp`;
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        if (sync) await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.txtPath);
      return true;
    } catch (err) {
      process.stderr.write(`condash terminal-logger: write failed: ${(err as Error).message}\n`);
      // Bookkeeping may now be stale (a partial write, a failed rename): force a
      // full rewrite on the next flush to re-establish the file exactly.
      this.resetBookkeeping();
      return false;
    }
  }

  /**
   * Write a grid body: append the rows that just froze, then truncate and
   * rewrite the live tail. Falls back to a full atomic rewrite whenever the
   * appended region cannot be continued — the first write, a header/kind flip,
   * an integrity-guard mismatch, or the byte cap.
   *
   * Every flush's file still ENDS with exactly the buffer snapshot a full
   * repaint would have written; what the append adds is the output that has
   * since scrolled out of the buffer, which the repaint silently dropped.
   */
  private async flushGridBody(
    sync: boolean,
    headerLine: string,
    renderGridBytes: number,
  ): Promise<void> {
    const headerBytes = Buffer.byteLength(headerLine, 'utf8') + 2;
    const appendable =
      this.diskLen !== null &&
      this.writtenKind === 'grid' &&
      this.writtenHeaderLine === headerLine &&
      this.gridFrozenEnd !== null &&
      this.gridFrozenEnd >= headerBytes;
    // Past the cap the history is trimmed, which is a rewrite either way.
    const overCap = appendable && this.gridFrozenEnd! - headerBytes > this.maxGridBodyBytes;
    if (!appendable) this.gridBody?.reset();

    // Timed the way the repaint used to be, so the production series stays
    // comparable: the body-building work of one grid flush, and nothing else.
    const gridStart = perfLog.isEnabled() ? process.hrtime.bigint() : 0n;
    let delta = this.gridBody ? this.gridBody.renderDelta() : EMPTY_GRID_DELTA;
    if (gridStart !== 0n) {
      perfLog.recordGridRender(this.ctx.sid, process.hrtime.bigint() - gridStart);
    }
    // Snapshot the marker timeline that describes *this* body before the async
    // write window, for the same L1 reason as the transcript cursor above.
    const renderGridMarkerCount = this.gridMarkers.length;

    if (appendable && !overCap) {
      if (await this.appendGridDelta(delta, sync, headerBytes)) {
        this.gridBody?.commit();
        this.recordGridWrite(headerLine, renderGridBytes, renderGridMarkerCount);
        return;
      }
      // The guard failed or the write errored: the watermark must keep
      // describing the file, and the rewrite below starts from row 0.
      this.gridBody?.abandon();
      this.gridBody?.reset();
      delta = this.gridBody ? this.gridBody.renderDelta() : EMPTY_GRID_DELTA;
    }

    // Trim first, so the rewrite lands the newest half of the history plus the
    // whole live buffer rather than dropping everything the file already held.
    const kept = overCap ? await this.readTrimmedGridHistory(headerBytes) : '';
    const frozenText = joinBodyParts([kept, delta.frozen.join('\n')]);
    const text = this.composeFileContent(
      joinBodyParts([frozenText, delta.tail.join('\n')]),
      'grid',
    );
    if (await this.writeFileAtomically(text, sync)) {
      this.recordWrite(text, 'grid', headerLine, null, renderGridBytes, renderGridMarkerCount);
      this.gridFrozenEnd = headerBytes + Buffer.byteLength(frozenText, 'utf8');
      this.gridBody?.commit();
    } else {
      this.gridBody?.abandon();
      this.gridBody?.reset();
    }
  }

  /**
   * Append `delta.frozen` past the immutable watermark and rewrite the tail in
   * place. Returns false (caller falls back to a full rewrite) when the file no
   * longer matches the length + tail watermark, when the write errors, or when
   * the body would be empty — that last shape is `header\n\n` exactly, which
   * only {@link composeFileContent} knows how to spell.
   *
   * The suffix is written BEFORE the truncate, so a crash inside the window
   * leaves stale trailing bytes rather than a hole: the committed history is
   * never at risk, and the live tail is at most one flush behind.
   */
  private async appendGridDelta(
    delta: GridBodyDelta,
    sync: boolean,
    headerBytes: number,
  ): Promise<boolean> {
    const frozenEnd = this.gridFrozenEnd!;
    const hasPriorRows = frozenEnd > headerBytes;
    const frozenChunk = delta.frozen.join('\n');
    const tailChunk = delta.tail.join('\n');
    const bodyHasRows = hasPriorRows || frozenChunk.length > 0;
    if (!bodyHasRows && tailChunk.length === 0 && this.composeTrailer('grid', true).length === 0) {
      return false;
    }
    const frozenSuffix = (hasPriorRows && frozenChunk.length > 0 ? '\n' : '') + frozenChunk;
    const tailSuffix = (bodyHasRows && tailChunk.length > 0 ? '\n' : '') + tailChunk;
    const bodyEmpty = !bodyHasRows && tailChunk.length === 0;
    const suffix = Buffer.from(
      `${frozenSuffix}${tailSuffix}${this.composeTrailer('grid', bodyEmpty)}\n`,
      'utf8',
    );
    try {
      if (!(await this.diskTailMatches())) return false;
      const fh = await open(this.txtPath, 'r+');
      try {
        await fh.write(suffix, 0, suffix.length, frozenEnd);
        await fh.truncate(frozenEnd + suffix.length);
        if (sync) await fh.sync();
        // Read the watermark back off the file just written rather than deriving
        // it — the derivation is where an off-by-one silently disables every
        // later append, and a 64-byte pread costs nothing.
        const size = frozenEnd + suffix.length;
        const sample = Buffer.alloc(Math.min(TAIL_SAMPLE_BYTES, size));
        if (sample.length > 0) await fh.read(sample, 0, sample.length, size - sample.length);
        this.diskLen = size;
        this.writtenTail = sample;
      } finally {
        await fh.close();
      }
      this.gridFrozenEnd = frozenEnd + Buffer.byteLength(frozenSuffix, 'utf8');
      return true;
    } catch (err) {
      // A vanished file (the Logs pane's delete button, an external sweep) is a
      // routine miss, not a fault — the caller's full rewrite re-establishes it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(
          `condash terminal-logger: grid append failed: ${(err as Error).message}\n`,
        );
      }
      this.resetBookkeeping();
      return false;
    }
  }

  /** Read the appended grid history back and keep the newest half, cut at a row
   *  boundary. Bounded by {@link maxGridBodyBytes} and reached once per that
   *  many bytes of output, so it is rare — but it is the one grid operation that
   *  is O(file), which is why the cap exists rather than a per-flush trim. */
  private async readTrimmedGridHistory(headerBytes: number): Promise<string> {
    const frozenEnd = this.gridFrozenEnd;
    if (frozenEnd === null || frozenEnd <= headerBytes) return '';
    try {
      const fh = await open(this.txtPath, 'r');
      try {
        const length = frozenEnd - headerBytes;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, headerBytes);
        const cut = buf.indexOf(0x0a, Math.max(0, length - Math.floor(this.maxGridBodyBytes / 2)));
        return cut < 0 ? '' : buf.subarray(cut + 1).toString('utf8');
      } finally {
        await fh.close();
      }
    } catch (err) {
      process.stderr.write(
        `condash terminal-logger: grid trim failed: ${(err as Error).message}\n`,
      );
      return '';
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
    // `Buffer.byteLength` + a tail slice, never a whole-file `Buffer.from`:
    // `writeFile(text, 'utf8')` has already encoded this string once, and
    // encoding a second megabyte-scale copy purely to read a length and 64
    // trailing bytes was pure waste on the main thread.
    this.diskLen = Buffer.byteLength(text, 'utf8');
    this.writtenTail = utf8Tail(text, TAIL_SAMPLE_BYTES);
    this.writtenKind = kind;
    this.writtenHeaderLine = headerLine;
    // The transcript cursor matches the body just rendered. A grid body tracks
    // its own append watermark instead (see recordGridWrite / gridFrozenEnd).
    this.bodyCursor = kind === 'transcript' ? renderCursor : null;
    this.gridFrozenEnd = null;
    if (kind === 'grid') {
      this.lastGridBytes = renderGridBytes;
      this.lastGridMarkerCount = renderGridMarkerCount;
    }
  }

  /** Record the bookkeeping an incremental grid append leaves behind. The
   *  length + tail watermark were read back off the file inside the write; only
   *  the render-skip watermarks are set here, and from the render-time snapshots
   *  rather than the live counters (L1). */
  private recordGridWrite(
    headerLine: string,
    renderGridBytes: number,
    renderGridMarkerCount: number,
  ): void {
    this.writtenKind = 'grid';
    this.writtenHeaderLine = headerLine;
    this.bodyCursor = null;
    this.lastGridBytes = renderGridBytes;
    this.lastGridMarkerCount = renderGridMarkerCount;
  }

  /** Drop all on-disk bookkeeping so the next flush does a full rewrite. */
  private resetBookkeeping(): void {
    this.diskLen = null;
    this.writtenTail = Buffer.alloc(0);
    this.writtenKind = null;
    this.writtenHeaderLine = null;
    this.bodyCursor = null;
    this.gridFrozenEnd = null;
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

  /** Everything the file carries after the body: for a grid log with markers a
   * `<!-- timeline -->` block, then (once the session has exited) the footer
   * line — each preceded by a blank line. Split out of
   * {@link composeFileContent} because the grid append path writes the same
   * bytes without ever holding the body. */
  private composeTrailer(kind: LogKind, bodyEmpty: boolean): string {
    const lines: string[] = [];
    // Grid bodies repaint their live tail, so the interval markers live here in
    // a trailing block instead of inline (transcripts carry theirs in the body).
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
    if (lines.length === 0) return '';
    // With a body present the trailer starts a new line; with none, the blank
    // line the header already wrote doubles as the separator.
    return (bodyEmpty ? '' : '\n') + lines.join('\n');
  }

  /** Assemble the on-disk text: header line, blank, body, trailer. `kind`
   * records whether `body` is the OSC transcript or the grid snapshot, so
   * readers needn't guess. */
  private composeFileContent(body: string, kind: LogKind): string {
    const trailer = this.composeTrailer(kind, body.length === 0);
    const head = `${this.composeHeaderLine(kind)}\n\n`;
    // A session with nothing to say is the header line and its blank, full stop.
    if (body.length === 0 && trailer.length === 0) return head;
    return `${head}${body}${trailer}\n`;
  }
}

/** The last `n` bytes of `buf` (the whole buffer when shorter). */
function tailBytes(buf: Buffer, n: number): Buffer {
  return buf.length <= n ? buf : buf.subarray(buf.length - n);
}

/** The last `n` UTF-8 bytes of `text`, without encoding the whole string — the
 *  A6 half of the append-only work. Every JS char encodes to at least one byte,
 *  so the last `n` chars always cover at least `n` bytes; the start is nudged
 *  off a low surrogate so the slice can't manufacture a U+FFFD the file does not
 *  contain. */
function utf8Tail(text: string, n: number): Buffer {
  let start = Math.max(0, text.length - n);
  const code = text.charCodeAt(start);
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start--;
  return tailBytes(Buffer.from(text.slice(start), 'utf8'), n);
}

/** Join the non-empty pieces of a grid body with `\n`. A rendered row list joins
 *  to '' only when it is empty — a trailing blank row is never kept — so this is
 *  exactly `rows.join('\n')` over the concatenated lists. */
function joinBodyParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('\n');
}

/** Stand-in for a session whose headless term was never constructed. */
const EMPTY_GRID_DELTA: GridBodyDelta = { frozen: [], tail: [] };
