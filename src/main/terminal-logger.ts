import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { TermSide, TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';

/**
 * Single-session writer. One instance per pty spawn; lives from `open()`
 * to `close()`. Owns a headless xterm `Terminal` + `SerializeAddon` and
 * mirrors the rendered buffer into `<conception>/.condash/logs/YYYY/MM/DD/`:
 *
 *   - `HHMMSS-<sid>.txt`       — the rendered terminal buffer at the
 *                                most recent flush. Format matches the
 *                                live pane's Save-buffer output (xterm
 *                                serialize: text + SGR codes, mode-set
 *                                escapes for buffer state). The Logs pane
 *                                renders this via ansi_up; external tools
 *                                can `cat` it directly.
 *   - `HHMMSS-<sid>.meta.json` — sidecar with `{ sid, side, repo?, cwd,
 *                                cmd, argv, started, exitCode?, finished? }`.
 *                                Written on `spawn`, rewritten on `exit`.
 *
 * Bytes flow: pty `output(data)` → `term.write(data)`. A debounced timer
 * (default 5 s) serialises the buffer and atomically renames a temp file
 * onto the `.txt` path. `exit()` and `close()` force an immediate flush.
 *
 * `input(data)` is intentionally a no-op — the pty echoes typed bytes
 * back through stdout, so feeding `in` into the headless xterm would
 * double-echo, and capturing keystrokes separately leaks a richer record
 * than `~/.bash_history`. Privacy win, no semantic loss for the logs
 * viewer use case.
 *
 * Buffer is bounded by xterm scrollback (default 10000 lines × 200 cols
 * ≈ 2 MB max). No rotation — the file size is self-capped by the same
 * mechanism that bounds the live terminal pane.
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
}

/** Sidecar `.meta.json` shape. Read by the Logs pane to populate the
 * session header (cmd / exit / repo) and the session-list metadata
 * (size, exit, started). */
export interface SessionMeta {
  sid: string;
  side: TermSide;
  repo?: string;
  cwd: string;
  cmd: string;
  argv: string[];
  started: string;
  exitCode?: number;
  finished?: string;
}

/** Default opt-OUT: a fresh install records nothing until the user flips
 * the "Record terminal sessions to disk" checkbox in settings. Past
 * default was `true`; flipped 2026-05-14. The pref is read once at
 * SessionLogger construction time, so a user flipping the toggle off
 * while a session is already running does NOT mid-session pause it — the
 * next spawn picks up the new value. */
const DEFAULT_PREFS: Required<TerminalLoggingPrefs> = {
  enabled: false,
  retentionDays: 14,
  maxDirMb: 500,
  scrollback: 10000,
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

/** Resolve the per-session log file path inside `conceptionPath`. Returns
 * the canonical `.txt` path, no side effects. */
export function sessionLogPath(
  conceptionPath: string,
  sid: string,
  when: Date = new Date(),
): string {
  const yyyy = String(when.getFullYear());
  const mm = String(when.getMonth() + 1).padStart(2, '0');
  const dd = String(when.getDate()).padStart(2, '0');
  const hh = String(when.getHours()).padStart(2, '0');
  const mi = String(when.getMinutes()).padStart(2, '0');
  const ss = String(when.getSeconds()).padStart(2, '0');
  return join(condashLogsRoot(conceptionPath), yyyy, mm, dd, `${hh}${mi}${ss}-${sid}.txt`);
}

/** Sidecar metadata path next to the `.txt` (or `.txt.gz`). Sidecar
 * files are not compressed — the janitor only gzips the body. */
export function sessionMetaPath(txtPath: string): string {
  return txtPath.replace(/\.txt(?:\.gz)?$/, '.meta.json');
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
  private serializeAddon: SerializeAddon;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly startedTs: string;
  private exitCode: number | undefined;
  private finishedTs: string | undefined;
  private readonly txtPath: string;
  private readonly metaPath: string;
  private closed = false;
  private paused = false;
  private dirty = false;
  private readonly flushMs: number;

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
    this.txtPath = sessionLogPath(conceptionPath, ctx.sid, new Date());
    this.metaPath = sessionMetaPath(this.txtPath);
    this.term = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: this.prefs.scrollback,
      allowProposedApi: true,
    });
    this.serializeAddon = new SerializeAddon();
    this.term.loadAddon(this.serializeAddon);
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
   * the Logs pane (empty `.txt`, populated `.meta.json`). */
  spawn(): void {
    if (!this.isEnabled()) return;
    this.writeMetaSync();
  }

  /** No-op. Pty echoes typed bytes back through stdout, so `output`
   * already covers what the user saw. Capturing `in` separately would
   * either double-echo (if we wrote `in` into xterm too) or leak raw
   * keystrokes (if we wrote a separate stream); neither serves the
   * logs-viewer use case. */
  input(_data: string): void {
    /* intentional no-op — see class doc */
  }

  output(data: string): void {
    if (!this.isEnabled() || data.length === 0) return;
    this.term.write(data);
    this.dirty = true;
    this.scheduleFlush();
  }

  exit(exitCode: number): void {
    if (!this.isEnabled()) return;
    this.exitCode = exitCode;
    this.finishedTs = new Date().toISOString();
    this.flushNowFireAndForget();
    this.writeMetaSync();
  }

  /** Idempotent. After close(), all further calls are no-ops. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.cancelFlush();
    // Drain the pending flush *before* flipping `closed` — the guard in
    // `flushNow` early-returns once `closed` is true, so we'd lose the
    // tail otherwise.
    if (this.dirty) await this.flushNow();
    this.closed = true;
    // No final meta write — spawn() / exit() are the only meta touch
    // points.
    this.term.dispose();
  }

  /** Test hook — force an immediate flush regardless of debounce. */
  async flushForTests(): Promise<void> {
    await this.flushNow();
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
    void this.flushNow().catch((err: Error) => {
      process.stderr.write(`condash terminal-logger: flush failed: ${err.message}\n`);
    });
  }

  private async flushNow(): Promise<void> {
    if (!this.dirty || this.closed) return;
    this.dirty = false;
    // Wait for any queued xterm parse to complete before serialising —
    // otherwise the buffer may not reflect the most recent `output` call.
    await new Promise<void>((resolve) => this.term.write('', () => resolve()));
    // The await above yielded the event loop; the session may have been
    // closed (and the term disposed) while we waited. Drop the
    // serialise / write attempt — its output would be stale anyway.
    if (this.closed) return;
    const text = this.serializeAddon.serialize();
    try {
      mkdirSync(dirname(this.txtPath), { recursive: true });
      const tmp = `${this.txtPath}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, this.txtPath);
    } catch (err) {
      process.stderr.write(`condash terminal-logger: write failed: ${(err as Error).message}\n`);
    }
  }

  /** Synchronous to avoid races between rapid spawn/exit/close calls.
   * Meta is a small JSON blob — sync write is negligible cost and
   * removes the .tmp-collision class of bug. */
  private writeMetaSync(): void {
    const meta: SessionMeta = {
      sid: this.ctx.sid,
      side: this.ctx.side,
      ...(this.ctx.repo ? { repo: this.ctx.repo } : {}),
      cwd: this.ctx.cwd,
      cmd: this.ctx.spawn.cmd,
      argv: this.ctx.spawn.argv,
      started: this.startedTs,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.finishedTs ? { finished: this.finishedTs } : {}),
    };
    try {
      mkdirSync(dirname(this.metaPath), { recursive: true });
      const tmp = `${this.metaPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.metaPath);
    } catch (err) {
      process.stderr.write(
        `condash terminal-logger: meta write failed: ${(err as Error).message}\n`,
      );
    }
  }
}
