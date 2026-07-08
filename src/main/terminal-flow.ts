// Per-session pty → renderer flow control + micro-batching (review findings
// T1 + T2). One `TerminalFlow` owns the tail of a session's `onData` path: it
// coalesces the many tiny chunks a TUI repaint emits into one `termData` send
// (fewer renderer wakeups / structured-clone copies) and tracks sent-but-unacked
// bytes so a fast agent can't outrun a slow renderer. When the backlog crosses
// the high watermark the pty is paused (OS-level backpressure onto the child);
// it resumes once the renderer has acked the backlog back below the low
// watermark. Deliberately free of any electron / node-pty import so the whole
// state machine is unit-testable against a plain stub.

/** Pause when this many sent-but-unacked bytes are outstanding for a session. */
export const HIGH_WATERMARK_BYTES = 256 * 1024;
/** Resume once the backlog falls back to (or below) this. The gap to the high
 *  watermark is the hysteresis that keeps pause/resume from thrashing. */
export const LOW_WATERMARK_BYTES = 64 * 1024;
/** Flush a pending batch immediately once it reaches this size, so a sustained
 *  fast stream sends in bounded units rather than growing the pending array. */
export const BATCH_FLUSH_BYTES = 64 * 1024;
/** Otherwise flush on this timer — the coalescing window that turns a burst of
 *  small repaint chunks into a single send. Short enough to stay imperceptible. */
export const BATCH_FLUSH_MS = 12;

/** The slice of `node-pty`'s `IPty` the flow controller drives. Structural so a
 *  test passes a `{ pause, resume }` stub and the live `IPty` satisfies it. */
export interface Pausable {
  pause(): void;
  resume(): void;
}

/** Tunable thresholds; every field defaults to the module constant. */
export interface TerminalFlowOptions {
  highWatermark?: number;
  lowWatermark?: number;
  flushBytes?: number;
  flushMs?: number;
}

/**
 * Micro-batch + backpressure state for one terminal session.
 *
 * @param send Emit one coalesced payload to the renderer (`safeSend(termData)`
 *   in production). Called with the concatenated pending chunks, byte order
 *   preserved.
 * @param getPty Read the session's live pty (or null once it has exited) — read
 *   lazily so pause/resume always target the current handle.
 * @param options Threshold overrides; omit for the module defaults.
 */
export class TerminalFlow {
  private pending: string[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private paused = false;
  private readonly high: number;
  private readonly low: number;
  private readonly flushBytesThreshold: number;
  private readonly flushMs: number;

  constructor(
    private readonly send: (data: string) => void,
    private readonly getPty: () => Pausable | null,
    options: TerminalFlowOptions = {},
  ) {
    this.high = options.highWatermark ?? HIGH_WATERMARK_BYTES;
    this.low = options.lowWatermark ?? LOW_WATERMARK_BYTES;
    this.flushBytesThreshold = options.flushBytes ?? BATCH_FLUSH_BYTES;
    this.flushMs = options.flushMs ?? BATCH_FLUSH_MS;
  }

  /** Queue one raw pty chunk for the renderer. Flushes at once when the pending
   *  batch reaches the size threshold, otherwise arms the coalescing timer. */
  enqueue(data: string): void {
    if (data.length === 0) return;
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (this.pendingBytes >= this.flushBytesThreshold) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  /** Concatenate and send the pending batch (if any), clear the timer, and fold
   *  the sent size into the in-flight counter — pausing the pty if that pushes
   *  the backlog to the high watermark. Also the flush-before-teardown entry
   *  point: safe to call with nothing pending (no-op) and leaves no armed timer. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingBytes === 0) return;
    const data = this.pending.length === 1 ? this.pending[0] : this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;
    this.inFlight += data.length;
    this.send(data);
    if (!this.paused && this.inFlight >= this.high) {
      this.paused = true;
      try {
        this.getPty()?.pause();
      } catch {
        /* pty exited between the check and the call */
      }
    }
  }

  /** Credit the bytes the renderer reports consumed and resume the pty once the
   *  backlog drops back to the low watermark. Tolerates over-acking (clamped at
   *  zero) so a stale ack after a reset can't drive the counter negative. */
  ack(bytes: number): void {
    if (bytes <= 0) return;
    this.inFlight = Math.max(0, this.inFlight - bytes);
    if (this.paused && this.inFlight <= this.low) {
      this.paused = false;
      try {
        this.getPty()?.resume();
      } catch {
        /* pty exited between the check and the call */
      }
    }
  }

  /** Drop the pending batch (without sending) and zero the in-flight backlog,
   *  resuming the pty if it was paused. Used on renderer re-attach: the fresh
   *  renderer replays the buffer tail (which already contains any pending bytes)
   *  and will never ack what the destroyed renderer was sent, so re-sending would
   *  double-write and the stale in-flight count would pin the pty paused. */
  reset(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.inFlight = 0;
    if (this.paused) {
      this.paused = false;
      try {
        this.getPty()?.resume();
      } catch {
        /* pty exited between the check and the call */
      }
    }
  }

  /** Sent-but-unacked byte count. Test seam / introspection only. */
  get inFlightBytes(): number {
    return this.inFlight;
  }

  /** Whether the pty is currently held paused. Test seam / introspection only. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Bytes buffered awaiting the next flush. Test seam / introspection only. */
  get pendingByteCount(): number {
    return this.pendingBytes;
  }
}
