import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { TermSide, TerminalLoggingPrefs } from '../shared/types';
import { condashLogsRoot } from './condash-dir';

/**
 * Single-session writer for the terminal capture stream. One instance per
 * pty spawn; lives from `open()` to `close()`. Owns one `WriteStream` for
 * the active file; rotates on size overflow.
 *
 * File path:
 *   `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.jsonl`
 *
 * Event shapes (one JSON object per line, newline-terminated):
 *
 *   spawn  { ts, sid, side, repo?, cwd, kind: 'spawn', cmd, argv }
 *   in     { ts, sid, side, kind: 'in', data, len }
 *   out    { ts, sid, side, kind: 'out', data, len }
 *   exit   { ts, sid, side, kind: 'exit', exitCode }
 *   close  { ts, sid, side, kind: 'close' }
 *   rotate { ts, sid, side, kind: 'rotate', from, to } — written into the
 *          new file after a size-driven roll.
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

const DEFAULT_PREFS: Required<TerminalLoggingPrefs> = {
  enabled: true,
  retentionDays: 14,
  maxDirMb: 500,
  maxFileMb: 50,
  ansiPolicy: 'raw',
};

/** Resolve the per-session log file path inside `conceptionPath`. Returns
 * absolute path, no side effects. */
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
  return join(condashLogsRoot(conceptionPath), yyyy, mm, dd, `${hh}${mi}${ss}-${sid}.jsonl`);
}

/** Apply `TerminalLoggingPrefs` patch on top of the defaults. Internal —
 * exported only for tests. */
export function resolveLoggingPrefs(patch?: TerminalLoggingPrefs): Required<TerminalLoggingPrefs> {
  if (!patch) return { ...DEFAULT_PREFS };
  return {
    enabled: patch.enabled ?? DEFAULT_PREFS.enabled,
    retentionDays: patch.retentionDays ?? DEFAULT_PREFS.retentionDays,
    maxDirMb: patch.maxDirMb ?? DEFAULT_PREFS.maxDirMb,
    maxFileMb: patch.maxFileMb ?? DEFAULT_PREFS.maxFileMb,
    ansiPolicy: patch.ansiPolicy ?? DEFAULT_PREFS.ansiPolicy,
  };
}

/** Strip ANSI / CSI / OSC escape sequences. Pulled out so unit tests can
 * verify the regex doesn't drop printable characters. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Coalesce policy. Interactive shells emit one `in` event per keystroke
 * and one `out` event echoing each character; without coalescing, typing
 * `echo A\r` yields ~14 records.
 *
 * The writer keeps **two independent buffers** — one for `in`, one for
 * `out` — each flushing on its own rules. The earlier "switching kind
 * flushes" rule looked sensible on paper but broke the dominant case:
 * the pty echoes every typed byte, so the kind alternated every byte
 * and the buffer was dumped between every keystroke and its echo. Typing
 * `ls -al<Enter>` produced 14 records instead of two. With independent
 * buffers, the `in` accumulates the whole command up to `\r` and the
 * `out` accumulates the whole echo + listing — one record each. Per-byte
 * chronology between `in` and `out` is intentionally not preserved at
 * record granularity; the `ts` of each record (first byte of the burst)
 * gives burst-level ordering, which is what the user actually wants.
 *
 * Flush rules per buffer:
 *
 *   1. **`in` flushes on line terminator** — a typed command up to Enter
 *      lands as one record (`data: "echo A\r"`).
 *   2. **`out` flushes on idle** (`OUTPUT_IDLE_MS`) — pty echo + the
 *      shell's prompt-redraw burst collapse into one or two records per
 *      command.
 *   3. **Either buffer flushes on cap, pause, spawn / exit / close** —
 *      every public method that ends a turn flushes both.
 *
 * `INPUT_IDLE_MS` is a fallback for keys that never produce a newline
 * (arrow keys, raw-mode TUI input, partial pastes). `MAX_BUFFER_BYTES`
 * caps each in-memory buffer so a streaming `tail -f` or `cargo build`
 * doesn't grow unbounded if it never idles long enough to trip the timer.
 */
const INPUT_IDLE_MS = 500;
const OUTPUT_IDLE_MS = 100;
const MAX_BUFFER_BYTES = 64 * 1024;

interface PendingBuffer {
  data: string;
  ts: string;
  timer: NodeJS.Timeout | null;
}

export class SessionLogger {
  private prefs: Required<TerminalLoggingPrefs>;
  private rotation = 1;
  private bytesWritten = 0;
  private stream: WriteStream | null = null;
  private currentPath: string | null = null;
  private closed = false;
  private paused = false;
  /** Spawn time, captured once. All rotation files inherit this HHMMSS
   * prefix so they sort together and share the same `<sid>` identity —
   * the rotation suffix differentiates them, not the timestamp. */
  private readonly spawnTime: Date;
  /** Two independent coalesce buffers — `in` and `out` accumulate
   * separately so the pty's per-byte echo doesn't churn the buffer into
   * single-byte records. Each carries its own idle timer; `data` empty
   * means the buffer is idle (timer cleared, ts cleared). */
  private pendingIn: PendingBuffer = { data: '', ts: '', timer: null };
  private pendingOut: PendingBuffer = { data: '', ts: '', timer: null };

  constructor(
    private readonly conceptionPath: string,
    private readonly ctx: SessionContext,
    prefs?: TerminalLoggingPrefs,
  ) {
    this.prefs = resolveLoggingPrefs(prefs);
    this.spawnTime = new Date();
  }

  /** True when no further writes should happen. Lets callers short-circuit
   * the per-event `JSON.stringify` cost when capture is off. */
  isEnabled(): boolean {
    return this.prefs.enabled && !this.closed && !this.paused;
  }

  setPaused(paused: boolean): void {
    // Entering pause is a hard boundary — seal whatever was buffered so a
    // resume after the pause starts a fresh record rather than splicing
    // pre- and post-pause data together.
    if (paused && !this.paused) this.flushAll();
    this.paused = paused;
  }

  spawn(): void {
    if (!this.isEnabled()) return;
    this.flushAll();
    this.write({
      kind: 'spawn',
      cmd: this.ctx.spawn.cmd,
      argv: this.ctx.spawn.argv,
      cwd: this.ctx.cwd,
    });
  }

  input(data: string): void {
    if (!this.isEnabled() || data.length === 0) return;
    this.coalesce('in', data);
  }

  output(data: string): void {
    if (!this.isEnabled() || data.length === 0) return;
    this.coalesce('out', data);
  }

  exit(exitCode: number): void {
    if (!this.isEnabled()) return;
    this.flushAll();
    this.write({ kind: 'exit', exitCode });
  }

  /** Idempotent. After close(), all further calls are no-ops. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.flushAll();
    // Nothing was ever written → nothing to close.
    if (this.stream === null) return Promise.resolve();
    // Write the close marker explicitly — `write()` is happy to run even
    // after `closed = true` (the closed flag only gates the public
    // spawn / in / out / exit methods through isEnabled()).
    this.write({ kind: 'close' });
    return new Promise<void>((resolve) => {
      if (this.stream === null) {
        resolve();
        return;
      }
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }

  /** Test hook — force both pending coalesce buffers to disk now.
   * Production callers rely on the timers; tests use this to avoid a
   * `setTimeout` wait. */
  flushForTests(): void {
    this.flushAll();
  }

  /** Absolute path of the currently-active file. Visible for tab indicator
   * tooltips. Returns null before the first write. */
  filePath(): string | null {
    return this.currentPath;
  }

  private encode(data: string): string {
    return this.prefs.ansiPolicy === 'stripped' ? stripAnsi(data) : data;
  }

  private coalesce(kind: 'in' | 'out', data: string): void {
    const buf = kind === 'in' ? this.pendingIn : this.pendingOut;
    if (buf.data.length === 0) {
      buf.ts = new Date().toISOString();
      buf.data = data;
    } else {
      buf.data += data;
    }
    // Input flushes at line boundaries: one Enter press closes the
    // record. Multi-line pastes that end in newline flush in one go.
    if (kind === 'in' && /[\r\n]$/.test(buf.data)) {
      this.flushBuffer(kind);
      return;
    }
    // Bound each buffer so a stream that never idles can't grow forever.
    if (buf.data.length >= MAX_BUFFER_BYTES) {
      this.flushBuffer(kind);
      return;
    }
    // Idle-based fallback. Resetting the timer on every byte means a
    // steady stream extends the same record until idle / cap / newline /
    // close — exactly what the user expects from "one burst, one entry".
    if (buf.timer !== null) clearTimeout(buf.timer);
    const idleMs = kind === 'in' ? INPUT_IDLE_MS : OUTPUT_IDLE_MS;
    buf.timer = setTimeout(() => this.flushBuffer(kind), idleMs);
    // Don't keep the event loop alive on the writer alone — close() and
    // exit() flush explicitly, so an orphaned timer would only delay
    // shutdown.
    buf.timer.unref?.();
  }

  private flushBuffer(kind: 'in' | 'out'): void {
    const buf = kind === 'in' ? this.pendingIn : this.pendingOut;
    if (buf.timer !== null) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    if (buf.data.length === 0) return;
    const data = buf.data;
    const ts = buf.ts;
    buf.data = '';
    buf.ts = '';
    const encoded = this.encode(data);
    this.write({ kind, data: encoded, len: data.length }, ts);
  }

  /** Flush both buffers; used by the lifecycle methods (`spawn` / `exit`
   * / `close` / pause). Order is `in` then `out` — same order interactive
   * sessions naturally produce, and the test expects it. */
  private flushAll(): void {
    this.flushBuffer('in');
    this.flushBuffer('out');
  }

  private write(event: Record<string, unknown>, ts?: string): void {
    try {
      const stream = this.openStream();
      if (stream === null) return;
      const line =
        JSON.stringify({
          ts: ts ?? new Date().toISOString(),
          sid: this.ctx.sid,
          side: this.ctx.side,
          ...(this.ctx.repo ? { repo: this.ctx.repo } : {}),
          ...event,
        }) + '\n';
      const buf = Buffer.from(line, 'utf8');
      stream.write(buf);
      this.bytesWritten += buf.byteLength;
      this.maybeRotate();
    } catch (err) {
      // Never let log-writer failures take down the terminal pipeline.
      process.stderr.write(`condash terminal-logger: ${(err as Error).message}\n`);
    }
  }

  private openStream(): WriteStream | null {
    if (this.stream !== null) return this.stream;
    const target = this.computeTargetPath();
    try {
      mkdirSync(join(target, '..'), { recursive: true });
    } catch (err) {
      process.stderr.write(`condash terminal-logger: mkdir failed: ${(err as Error).message}\n`);
      return null;
    }
    this.stream = createWriteStream(target, { flags: 'a' });
    this.stream.on('error', (err) => {
      process.stderr.write(`condash terminal-logger: stream error: ${err.message}\n`);
    });
    this.currentPath = target;
    return this.stream;
  }

  private computeTargetPath(): string {
    const base = sessionLogPath(this.conceptionPath, this.ctx.sid, this.spawnTime);
    if (this.rotation === 1) return base;
    // `HHMMSS-<sid>.jsonl` → `HHMMSS-<sid>.<rotation>.jsonl`
    return base.replace(/\.jsonl$/, `.${this.rotation}.jsonl`);
  }

  private maybeRotate(): void {
    if (this.bytesWritten < this.prefs.maxFileMb * 1024 * 1024) return;
    const from = this.currentPath;
    const oldStream = this.stream;
    this.rotation += 1;
    this.bytesWritten = 0;
    this.stream = null;
    this.currentPath = null;
    oldStream?.end();
    // Drop a rotate marker in the new file so a reader hitting the
    // continuation can find its predecessor.
    const stream = this.openStream();
    if (!stream) return;
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        sid: this.ctx.sid,
        side: this.ctx.side,
        kind: 'rotate',
        from,
        to: this.currentPath,
      }) + '\n';
    stream.write(Buffer.from(line, 'utf8'));
  }
}
