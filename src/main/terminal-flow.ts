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
/** Resume a paused pty this long after it was paused, even if the renderer has
 *  not acked the backlog down to the low watermark (L3). A healthy renderer
 *  under load acks continuously and drains well within this window, so the
 *  watchdog only fires when acks have stalled entirely — a gone / crashed /
 *  wedged frame — where a still-paused pty can never reach EOF and its final
 *  bytes would be lost. See `onWatchdog` for the bounding argument. */
export const PAUSE_WATCHDOG_MS = 3000;

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
  watchdogMs?: number;
}

/**
 * Micro-batch + backpressure state for one terminal session.
 *
 * @param send Emit one coalesced payload to the renderer (`safeSend(termData)`
 *   in production). Called with the concatenated pending chunks (byte order
 *   preserved) and the current flow epoch; returns whether the payload was
 *   actually delivered — `false` means the target frame was gone, so those bytes
 *   are never counted as in-flight (no ack will ever come for them).
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
  /** Backstop timer that resumes a pty stuck paused (L3). Armed on pause,
   *  cleared on any resume/reset. */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic epoch, bumped by every reset(). Sent alongside each payload and
   *  echoed back in the ack, so an ack minted before a reset (still in the IPC
   *  queue after a live re-attach) is ignored rather than debiting the fresh
   *  epoch's backlog (L4). */
  private epoch = 0;
  private readonly high: number;
  private readonly low: number;
  private readonly flushBytesThreshold: number;
  private readonly flushMs: number;
  private readonly watchdogMs: number;

  constructor(
    private readonly send: (data: string, epoch: number) => boolean,
    private readonly getPty: () => Pausable | null,
    options: TerminalFlowOptions = {},
  ) {
    this.high = options.highWatermark ?? HIGH_WATERMARK_BYTES;
    this.low = options.lowWatermark ?? LOW_WATERMARK_BYTES;
    this.flushBytesThreshold = options.flushBytes ?? BATCH_FLUSH_BYTES;
    this.flushMs = options.flushMs ?? BATCH_FLUSH_MS;
    this.watchdogMs = options.watchdogMs ?? PAUSE_WATCHDOG_MS;
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
    const delivered = this.send(data, this.epoch);
    // A frame that's gone (crashed / disposed) receives nothing. Those bytes are
    // preserved in the main-side rolling buffer and replayed when the frame
    // reattaches, and no ack will ever arrive for them — so don't count them as
    // in-flight, or the pty would stay paused forever on an un-ackable backlog
    // (a chatty code-side session across a reload gap, L2/L3).
    if (!delivered) return;
    this.inFlight += data.length;
    if (!this.paused && this.inFlight >= this.high) {
      this.paused = true;
      try {
        this.getPty()?.pause();
      } catch {
        /* pty exited between the check and the call */
      }
      this.armWatchdog();
    }
  }

  /** Credit the bytes the renderer reports consumed and resume the pty once the
   *  backlog drops back to the low watermark. Tolerates over-acking (clamped at
   *  zero) so a stale ack after a reset can't drive the counter negative. An
   *  `epoch` older than the current one is a cross-reset straggler and is
   *  dropped whole (L4). */
  ack(bytes: number, epoch?: number): void {
    if (bytes <= 0) return;
    if (epoch !== undefined && epoch !== this.epoch) return;
    this.inFlight = Math.max(0, this.inFlight - bytes);
    if (this.paused && this.inFlight <= this.low) this.resumePty();
  }

  /** Drop the pending batch (without sending) and zero the in-flight backlog,
   *  resuming the pty if it was paused. Used on renderer re-attach: the fresh
   *  renderer replays the buffer tail (which already contains any pending bytes)
   *  and will never ack what the destroyed renderer was sent, so re-sending would
   *  double-write and the stale in-flight count would pin the pty paused. The
   *  epoch bump makes any still-queued ack for the pre-reset bytes a no-op (L4). */
  reset(): void {
    this.epoch++;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.inFlight = 0;
    if (this.paused) this.resumePty();
    else this.clearWatchdog();
  }

  /** Resume the pty and drop the pause backstop. Idempotent w.r.t. the timer. */
  private resumePty(): void {
    this.paused = false;
    this.clearWatchdog();
    try {
      this.getPty()?.resume();
    } catch {
      /* pty exited between the check and the call */
    }
  }

  /** Arm the pause backstop (no-op if disabled or already armed). */
  private armWatchdog(): void {
    if (this.watchdogMs <= 0 || this.watchdogTimer !== null) return;
    const timer = setTimeout(() => this.onWatchdog(), this.watchdogMs);
    timer.unref?.();
    this.watchdogTimer = timer;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Pause backstop fired: the pty has been paused for the whole watchdog window
   *  without the renderer acking below the low watermark. A healthy renderer
   *  under load acks continuously and drains well within that window, so a fired
   *  watchdog means acks have stalled entirely — the frame is gone, crashed, or
   *  wedged — and a still-paused pty can never reach EOF (pause() is
   *  socket.pause(), so a child that exits while paused never delivers its final
   *  bytes; node-pty then destroys the socket after its short drain timeout and
   *  the log / buffer lose the tail — L3). Resume regardless.
   *
   *  Bounding argument (must not reintroduce the T1 unbounded-queue regression):
   *  main's own consumers — the rolling buffer, the OSC transcript, and the disk
   *  logger — read every chunk synchronously in the pty `onData` handler, and the
   *  buffer is a fixed-size rolling tail, so the resumed bytes are captured
   *  regardless of renderer speed. The renderer send itself stays bounded: a gone
   *  frame drops the payload (`safeSend` returns false → the bytes aren't even
   *  counted, and it replays from the capped buffer on reattach), and a live
   *  renderer that has merely fallen behind re-crosses the high watermark on the
   *  next flush and is re-paused — so the renderer IPC queue grows by at most one
   *  coalesced batch per watchdog window, never without bound. */
  private onWatchdog(): void {
    this.watchdogTimer = null;
    if (!this.paused) return;
    this.resumePty();
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
