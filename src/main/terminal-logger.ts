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
    this.paused = paused;
  }

  spawn(): void {
    if (!this.isEnabled()) return;
    this.write({
      kind: 'spawn',
      cmd: this.ctx.spawn.cmd,
      argv: this.ctx.spawn.argv,
      cwd: this.ctx.cwd,
    });
  }

  input(data: string): void {
    if (!this.isEnabled() || data.length === 0) return;
    this.write({ kind: 'in', data: this.encode(data), len: data.length });
  }

  output(data: string): void {
    if (!this.isEnabled() || data.length === 0) return;
    this.write({ kind: 'out', data: this.encode(data), len: data.length });
  }

  exit(exitCode: number): void {
    if (!this.isEnabled()) return;
    this.write({ kind: 'exit', exitCode });
  }

  /** Idempotent. After close(), all further calls are no-ops. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
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

  /** Absolute path of the currently-active file. Visible for tab indicator
   * tooltips. Returns null before the first write. */
  filePath(): string | null {
    return this.currentPath;
  }

  private encode(data: string): string {
    return this.prefs.ansiPolicy === 'stripped' ? stripAnsi(data) : data;
  }

  private write(event: Record<string, unknown>): void {
    try {
      const stream = this.openStream();
      if (stream === null) return;
      const line =
        JSON.stringify({
          ts: new Date().toISOString(),
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
