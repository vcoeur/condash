import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Terminal } from '@xterm/headless';
import type { TaskRunContext, TermSide, TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';
import { META_LINE_PREFIX, type LogKind } from './logs-format';
import { OscTranscriptExtractor, timestampMarker } from './osc-transcript';
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
 * Bytes flow: pty `output(data)` → `term.write(data)`. A debounced timer
 * (default 5 s) re-renders the buffer + header (+ footer if exited) and writes
 * the `.txt`. When the composed text is a pure prefix-extension of what's
 * already on disk — the common case for a growing transcript — the periodic
 * flush **appends only the delta** rather than rewriting the whole (possibly
 * multi-MB) file each cycle. Any non-append change (a grid repaint, a
 * byte-cap trim) and the durable `exit()` / `close()` flushes take the atomic
 * tmp → (fsync) → rename full rewrite instead. `writtenText` tracks the on-disk
 * content across both paths. The periodic flushes do NOT `fsync` — only the
 * terminal flushes (exit / close) do; the atomic rename already keeps the file
 * from ever being torn, appends never truncate existing content, and fsync-ing
 * every few-second flush stalls the main process for durability a log viewer
 * doesn't need.
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

/** Footer-line JSON shape, appended on `exit()`. */
interface FooterMeta {
  finished: string;
  exitCode: number;
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

export class SessionLogger {
  private prefs: Required<TerminalLoggingPrefs>;
  private term: Terminal;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Tail of the serialised flush chain. Each new flush appends; close
   * awaits the tail so all writes drain before the term is disposed. */
  private flushChain: Promise<void> = Promise.resolve();
  private readonly startedTs: string;
  private exitCode: number | undefined;
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
  /** Exact text last written to `txtPath`, or null when the next flush must do a
   * full rewrite (nothing on disk yet, or a prior write failed). When the newly
   * composed text is a pure prefix-extension of this, a periodic flush appends
   * only the delta instead of rewriting the whole file (the G9 fix). */
  private writtenText: string | null = null;
  private readonly flushMs: number;
  /** Pulls any in-band "agent transcript over OSC" frames out of the pty
   * stream. Harness-blind: it knows the generic protocol, not the program.
   * When a session speaks it, the log body becomes the clean transcript
   * instead of the grid snapshot. */
  private readonly oscTranscript = new OscTranscriptExtractor();
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
    this.term = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: this.prefs.scrollback,
      // Required since xterm.js 5.4 for `ILinkProvider` and the buffer-line
      // APIs used by `renderBufferAsPlainText`. Safe to leave enabled — the
      // flag only unlocks stable APIs that haven't been promoted to default.
      allowProposedApi: true,
    });
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

  output(data: string): void {
    if (!this.isEnabled() || data.length === 0) return;
    // Strip any in-band transcript OSC out of the stream first, so the grid
    // render never carries it; feed only the remainder to xterm.
    const clean = this.oscTranscript.feed(data);
    if (clean.length > 0) this.term.write(clean);
    this.dirty = true;
    // Any chunk is new content — even a transcript-only chunk (clean empty,
    // its message captured via feed()). Opens the marker's content gate.
    this.contentSinceMarker = true;
    this.scheduleFlush();
  }

  exit(exitCode: number): void {
    if (!this.isEnabled()) return;
    this.exitCode = exitCode;
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
    this.term.dispose();
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

  /** Render the buffer and atomically write it to the `.txt`. `sync` forces an
   *  fsync before the rename for durability — set only on the terminal flushes
   *  (exit / close), not the periodic ones (see the class doc). */
  private async flushNow(sync = false): Promise<void> {
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    // Wait for any queued xterm parse to complete before rendering —
    // otherwise the buffer may not reflect the most recent `output` call.
    await new Promise<void>((resolve) => this.term.write('', () => resolve()));
    if (this.closed) return;
    // A session that emitted an in-band transcript gets the clean transcript
    // as its body; everything else falls back to the rendered grid.
    const isTranscript = this.oscTranscript.hasTranscript();
    this.maybeEmitTimestampMarker(isTranscript);
    const body = isTranscript ? this.oscTranscript.render() : renderBufferAsPlainText(this.term);
    const text = this.composeFileContent(body, isTranscript ? 'transcript' : 'grid');
    try {
      await mkdir(dirname(this.txtPath), { recursive: true });
      if (!sync && this.writtenText !== null && text.startsWith(this.writtenText)) {
        // Append-only fast path (periodic flushes only). The file body only
        // grew — a transcript gains whole messages/markers at the end, the
        // footer appends after the body — so append just the delta instead of
        // rewriting the entire (possibly multi-MB) transcript every few seconds
        // (the G9 write-amplification). A grid repaint or a byte-cap trim is not
        // a prefix-extension, so it falls through to the full rewrite below; the
        // durable exit/close flushes (`sync`) always take the full path too.
        const delta = text.slice(this.writtenText.length);
        if (delta.length > 0) {
          const fh = await open(this.txtPath, 'a');
          try {
            await fh.write(delta);
          } finally {
            await fh.close();
          }
        }
        this.writtenText = text;
        return;
      }
      // Full rewrite: tmp → (fsync) → rename. The atomic rename keeps the file
      // from ever being torn / zero-length; fsync makes the content itself
      // durable across power loss. Periodic flushes skip the fsync (a live
      // session re-snapshots its buffer every few seconds — fsync-ing each one
      // stalls the main process's libuv threadpool for durability the log viewer
      // doesn't need); the exit / close flushes pass `sync: true`.
      const tmp = `${this.txtPath}.tmp`;
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        if (sync) await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.txtPath);
      this.writtenText = text;
    } catch (err) {
      process.stderr.write(`condash terminal-logger: write failed: ${(err as Error).message}\n`);
      // Offset bookkeeping may now be stale (a partial append, a failed rename):
      // force a full rewrite on the next flush to re-establish the file exactly.
      this.writtenText = null;
    }
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

  /** Assemble the on-disk text: header line, blank, body, then (for a grid log
   * with markers) a trailing `<!-- timeline -->` block, then (if the session
   * has exited) blank + footer line. `kind` records whether `body` is the OSC
   * transcript or the grid snapshot, so readers needn't guess. */
  private composeFileContent(body: string, kind: LogKind): string {
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
    const lines: string[] = [`${META_LINE_PREFIX}${JSON.stringify(header)}`, ''];
    if (body.length > 0) lines.push(body);
    // Grid bodies are repaints, so the interval markers live here in a trailing
    // block instead of inline (transcripts carry theirs in the body already).
    if (kind === 'grid' && this.gridMarkers.length > 0) {
      lines.push('', '<!-- timeline -->', ...this.gridMarkers);
    }
    if (this.exitCode !== undefined && this.finishedTs !== undefined) {
      const footer: FooterMeta = { finished: this.finishedTs, exitCode: this.exitCode };
      lines.push('', `${META_LINE_PREFIX}${JSON.stringify(footer)}`);
    }
    return lines.join('\n') + '\n';
  }
}

/** Read every populated row of the headless xterm buffer (scrollback +
 * viewport) as plain UTF-8 text. `translateToString(true)` trims trailing
 * blanks per row, which keeps the file from carrying the wide xterm
 * grid's empty cells. Rows are joined with `\n`. */
function renderBufferAsPlainText(term: Terminal): string {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    rows.push(line ? line.translateToString(true) : '');
  }
  // Drop the trailing run of empty rows — terminal buffers are usually
  // padded with blanks all the way to the viewport bottom.
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}
