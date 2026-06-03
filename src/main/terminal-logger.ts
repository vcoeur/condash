import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Terminal } from '@xterm/headless';
import type { TaskRunContext, TermSide, TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';
import { META_LINE_PREFIX, type LogKind } from './logs-format';
import { OscTranscriptExtractor } from './osc-transcript';
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
 * (default 5 s) re-renders the buffer + header (+ footer if exited) and
 * atomically renames a temp file onto the `.txt` path. `exit()` and
 * `close()` force an immediate flush.
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
  private paused = false;
  private dirty = false;
  private readonly flushMs: number;
  /** Pulls any in-band "agent transcript over OSC" frames out of the pty
   * stream. Harness-blind: it knows the generic protocol, not the program.
   * When a session speaks it, the log body becomes the clean transcript
   * instead of the grid snapshot. */
  private readonly oscTranscript = new OscTranscriptExtractor();

  constructor(
    conceptionPath: string,
    private readonly ctx: SessionContext,
    prefs?: TerminalLoggingPrefs,
    /** Test hook — override the debounce window. */
    flushMs: number = DEFAULT_FLUSH_MS,
  ) {
    this.prefs = resolveLoggingPrefs(prefs);
    this.flushMs = flushMs;
    this.startedTs = new Date().toISOString();
    this.txtPath = sessionLogPath(conceptionPath, ctx.sid, new Date(), ctx.taskContext);
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
    this.scheduleFlush();
  }

  exit(exitCode: number): void {
    if (!this.isEnabled()) return;
    this.exitCode = exitCode;
    this.finishedTs = new Date().toISOString();
    this.dirty = true;
    this.flushNowFireAndForget();
  }

  /** Idempotent. After close(), all further calls are no-ops. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.cancelFlush();
    // Drain any pending flushes — they're serialised through
    // `flushChain`, so awaiting the tail waits for all of them.
    if (this.dirty) this.flushNowFireAndForget();
    await this.flushChain;
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

  private flushNowFireAndForget(): void {
    // Append onto the serialised chain — never run two flushes
    // concurrently against the same `.txt.tmp`.
    this.flushChain = this.flushChain
      .then(() => this.flushNow())
      .catch((err: Error) => {
        process.stderr.write(`condash terminal-logger: flush failed: ${err.message}\n`);
      });
  }

  private async flushNow(): Promise<void> {
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    // Wait for any queued xterm parse to complete before rendering —
    // otherwise the buffer may not reflect the most recent `output` call.
    await new Promise<void>((resolve) => this.term.write('', () => resolve()));
    if (this.closed) return;
    // A session that emitted an in-band transcript gets the clean transcript
    // as its body; everything else falls back to the rendered grid.
    const isTranscript = this.oscTranscript.hasTranscript();
    const body = isTranscript ? this.oscTranscript.render() : renderBufferAsPlainText(this.term);
    const text = this.composeFileContent(body, isTranscript ? 'transcript' : 'grid');
    try {
      await mkdir(dirname(this.txtPath), { recursive: true });
      const tmp = `${this.txtPath}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, this.txtPath);
    } catch (err) {
      process.stderr.write(`condash terminal-logger: write failed: ${(err as Error).message}\n`);
    }
  }

  /** Assemble the on-disk text: header line, blank, body, then (if the
   * session has exited) blank + footer line. `kind` records whether `body` is
   * the OSC transcript or the grid snapshot, so readers needn't guess. */
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
