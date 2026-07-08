/**
 * Unit tests for `TerminalFlow` — the per-session pty → renderer micro-batch
 * (T2) and backpressure (T1) state machine. No electron / node-pty runtime is
 * involved: the pty is a `{ pause, resume }` stub and the renderer send is a
 * spy, so every threshold and the exact coalesced payloads are asserted
 * deterministically (fake timers drive the coalescing window).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_FLUSH_BYTES,
  BATCH_FLUSH_MS,
  HIGH_WATERMARK_BYTES,
  LOW_WATERMARK_BYTES,
  PAUSE_WATCHDOG_MS,
  TerminalFlow,
  type Pausable,
  type TerminalFlowOptions,
} from './terminal-flow';

/** A pty stub that records pause/resume calls. */
function fakePty(): Pausable & {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
} {
  return { pause: vi.fn(), resume: vi.fn() };
}

/** Build a flow controller with a send spy and a live pty stub. Small
 *  thresholds keep the assertions readable; the production defaults are pinned
 *  separately below. `delivered` mimics safeSend's return — flip it off to
 *  simulate a gone frame. */
function makeFlow(over: TerminalFlowOptions = {}) {
  const sent: string[] = [];
  const epochs: number[] = [];
  const pty = fakePty();
  let delivered = true;
  const flow = new TerminalFlow(
    (data, epoch) => {
      if (!delivered) return false;
      sent.push(data);
      epochs.push(epoch);
      return true;
    },
    () => pty,
    {
      highWatermark: 20,
      lowWatermark: 8,
      flushBytes: 10,
      flushMs: 12,
      ...over,
    },
  );
  return {
    flow,
    sent,
    epochs,
    pty,
    setDelivered(value: boolean) {
      delivered = value;
    },
  };
}

describe('TerminalFlow — micro-batching (T2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces sub-threshold chunks into one timer-flushed send, order preserved', () => {
    const { flow, sent } = makeFlow();
    flow.enqueue('AB');
    flow.enqueue('CD');
    // Nothing sent yet — still inside the coalescing window.
    expect(sent).toEqual([]);
    expect(flow.pendingByteCount).toBe(4);
    vi.advanceTimersByTime(12);
    expect(sent).toEqual(['ABCD']);
    expect(flow.pendingByteCount).toBe(0);
  });

  it('flushes immediately at the byte threshold, including earlier pending', () => {
    const { flow, sent } = makeFlow();
    flow.enqueue('AB'); // 2
    flow.enqueue('CDEFGHIJKL'); // +10 = 12 ≥ flushBytes(10)
    expect(sent).toEqual(['ABCDEFGHIJKL']);
    expect(flow.pendingByteCount).toBe(0);
    // The size-trigger flush also disarms the timer, so no empty second send.
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(['ABCDEFGHIJKL']);
  });

  it('ignores empty chunks and never arms a timer for them', () => {
    const { flow, sent } = makeFlow();
    flow.enqueue('');
    expect(flow.pendingByteCount).toBe(0);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([]);
  });

  it('preserves byte order across many coalesced flushes', () => {
    const { flow, sent } = makeFlow({ flushBytes: 1000, flushMs: 12 });
    let expected = '';
    for (let i = 0; i < 50; i++) {
      const chunk = String.fromCharCode(65 + (i % 26));
      expected += chunk;
      flow.enqueue(chunk);
      if (i % 7 === 0) vi.advanceTimersByTime(12); // flush at irregular points
    }
    vi.advanceTimersByTime(12);
    expect(sent.join('')).toBe(expected);
  });
});

describe('TerminalFlow — backpressure (T1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pauses the pty once in-flight reaches the high watermark', () => {
    const { flow, pty } = makeFlow(); // high 20, flushBytes 10
    flow.enqueue('0123456789'); // 10 → send, in-flight 10 < 20
    expect(pty.pause).not.toHaveBeenCalled();
    expect(flow.inFlightBytes).toBe(10);
    flow.enqueue('0123456789'); // +10 → in-flight 20 ≥ 20
    expect(pty.pause).toHaveBeenCalledTimes(1);
    expect(flow.isPaused).toBe(true);
  });

  it('resumes only once the backlog drains to the low watermark', () => {
    const { flow, pty } = makeFlow();
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // in-flight 20 → paused
    expect(flow.isPaused).toBe(true);
    flow.ack(5); // 20 → 15, still > low(8)
    expect(pty.resume).not.toHaveBeenCalled();
    expect(flow.isPaused).toBe(true);
    flow.ack(8); // 15 → 7 ≤ low(8)
    expect(pty.resume).toHaveBeenCalledTimes(1);
    expect(flow.isPaused).toBe(false);
    expect(flow.inFlightBytes).toBe(7);
  });

  it('does not resume when it was never paused, and clamps over-acking at zero', () => {
    const { flow, pty } = makeFlow();
    flow.enqueue('0123456789'); // in-flight 10, not paused
    flow.ack(1000); // over-ack
    expect(flow.inFlightBytes).toBe(0);
    expect(pty.resume).not.toHaveBeenCalled();
  });

  it('ack is a no-op for non-positive byte counts', () => {
    const { flow } = makeFlow();
    flow.enqueue('0123456789');
    flow.ack(0);
    flow.ack(-5);
    expect(flow.inFlightBytes).toBe(10);
  });

  it('stays paused until drained, then resumes — the flood-then-catch-up path', () => {
    const { flow, pty } = makeFlow({ highWatermark: 64, lowWatermark: 16, flushBytes: 16 });
    // Flood well past the high watermark.
    for (let i = 0; i < 8; i++) flow.enqueue('0123456789ABCDEF'); // 16 bytes each → 128 total
    expect(pty.pause).toHaveBeenCalledTimes(1);
    expect(flow.inFlightBytes).toBe(128);
    // Renderer acks each 16-byte payload back; resume must fire exactly once,
    // when the backlog first reaches the low watermark.
    for (let i = 0; i < 8; i++) flow.ack(16);
    expect(pty.resume).toHaveBeenCalledTimes(1);
    expect(flow.inFlightBytes).toBe(0);
    expect(flow.isPaused).toBe(false);
  });
});

describe('TerminalFlow — teardown + re-attach', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flush() delivers the pending batch and disarms the timer (no post-exit fire)', () => {
    const { flow, sent } = makeFlow();
    flow.enqueue('tail'); // sub-threshold, timer armed
    flow.flush();
    expect(sent).toEqual(['tail']);
    // Timer was cleared by flush — advancing must not double-send.
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(['tail']);
  });

  it('flush() with nothing pending is a no-op', () => {
    const { flow, sent } = makeFlow();
    flow.flush();
    expect(sent).toEqual([]);
  });

  it('reset() drops the pending batch, zeroes in-flight, and resumes if paused', () => {
    const { flow, sent, pty } = makeFlow();
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // paused, in-flight 20
    flow.enqueue('unsent'); // sub-threshold pending
    expect(flow.pendingByteCount).toBe(6);
    flow.reset();
    expect(flow.pendingByteCount).toBe(0);
    expect(flow.inFlightBytes).toBe(0);
    expect(pty.resume).toHaveBeenCalledTimes(1);
    // The dropped pending is never sent (the fresh renderer replays the buffer
    // tail instead), and the disarmed timer never fires.
    vi.advanceTimersByTime(100);
    expect(sent).toEqual(['0123456789', '0123456789']);
  });

  it('reads the pty lazily so pause/resume target the live handle after re-attach', () => {
    const sent: string[] = [];
    let live: Pausable | null = fakePty();
    const first = live;
    const flow = new TerminalFlow(
      (d) => {
        sent.push(d);
        return true;
      },
      () => live,
      {
        highWatermark: 20,
        lowWatermark: 8,
        flushBytes: 10,
      },
    );
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // pause on `first`
    expect((first as ReturnType<typeof fakePty>).pause).toHaveBeenCalledTimes(1);
    // Simulate the pty being swapped (e.g. exit → null); resume must not throw.
    live = null;
    expect(() => flow.ack(20)).not.toThrow();
  });
});

describe('TerminalFlow — undelivered sends are not counted (L3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not count bytes the send dropped, so an un-ackable backlog never pauses', () => {
    const { flow, sent, pty, setDelivered } = makeFlow();
    setDelivered(false); // frame gone: safeSend drops every payload
    for (let i = 0; i < 5; i++) flow.enqueue('0123456789'); // 50 bytes ≫ high(20)
    expect(sent).toEqual([]);
    expect(flow.inFlightBytes).toBe(0);
    expect(pty.pause).not.toHaveBeenCalled();
    expect(flow.isPaused).toBe(false);
  });

  it('resumes counting once delivery recovers', () => {
    const { flow, pty, setDelivered } = makeFlow();
    setDelivered(false);
    flow.enqueue('0123456789'); // dropped, not counted
    setDelivered(true);
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // 20 delivered ≥ high(20)
    expect(flow.inFlightBytes).toBe(20);
    expect(pty.pause).toHaveBeenCalledTimes(1);
  });
});

describe('TerminalFlow — pause watchdog (L3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resumes a pty stuck paused once the watchdog window elapses with no acks', () => {
    const { flow, pty } = makeFlow({ watchdogMs: 500 });
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // in-flight 20 → paused
    expect(flow.isPaused).toBe(true);
    vi.advanceTimersByTime(499);
    expect(pty.resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pty.resume).toHaveBeenCalledTimes(1);
    expect(flow.isPaused).toBe(false);
  });

  it('an ack-driven resume disarms the watchdog (no second resume later)', () => {
    const { flow, pty } = makeFlow({ watchdogMs: 500 });
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // paused
    flow.ack(20); // drains below low(8) → resume + disarm
    expect(pty.resume).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(pty.resume).toHaveBeenCalledTimes(1);
  });

  it('reset() disarms the watchdog along with everything else', () => {
    const { flow, pty } = makeFlow({ watchdogMs: 500 });
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // paused
    flow.reset(); // resumes + disarms
    expect(pty.resume).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(pty.resume).toHaveBeenCalledTimes(1);
  });

  it('a re-pause after a watchdog resume re-arms the watchdog', () => {
    const { flow, pty } = makeFlow({ watchdogMs: 500 });
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // paused (in-flight 20)
    vi.advanceTimersByTime(500); // watchdog resume
    expect(pty.resume).toHaveBeenCalledTimes(1);
    flow.enqueue('0123456789'); // in-flight 30 ≥ high again → re-pause
    expect(pty.pause).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(pty.resume).toHaveBeenCalledTimes(2);
  });
});

describe('TerminalFlow — ack epochs (L4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stamps every send with the current epoch and bumps it on reset', () => {
    const { flow, epochs } = makeFlow();
    flow.enqueue('0123456789');
    flow.reset();
    flow.enqueue('0123456789');
    expect(epochs.length).toBe(2);
    expect(epochs[1]).toBe(epochs[0] + 1);
  });

  it('ignores an ack carrying a stale epoch (pre-reset straggler)', () => {
    const { flow, epochs, pty } = makeFlow();
    flow.enqueue('0123456789'); // epoch e0, in-flight 10
    const stale = epochs[0];
    flow.reset(); // epoch e1, in-flight 0
    flow.enqueue('0123456789');
    flow.enqueue('0123456789'); // in-flight 20 → paused
    expect(flow.isPaused).toBe(true);
    // The old renderer's ack for the pre-reset payload arrives late: it must
    // not debit the new epoch's backlog (nor resume the pty).
    flow.ack(10, stale);
    expect(flow.inFlightBytes).toBe(20);
    expect(flow.isPaused).toBe(true);
    // A current-epoch ack works as usual (the only resume — reset ran unpaused).
    flow.ack(20, epochs[1]);
    expect(flow.inFlightBytes).toBe(0);
    expect(pty.resume).toHaveBeenCalledTimes(1);
    expect(flow.isPaused).toBe(false);
  });

  it('an epoch-less ack (malformed / legacy) still credits the current epoch', () => {
    const { flow } = makeFlow();
    flow.enqueue('0123456789');
    flow.ack(10);
    expect(flow.inFlightBytes).toBe(0);
  });
});

describe('TerminalFlow — production thresholds', () => {
  it('exports the documented watermark + batch constants', () => {
    expect(HIGH_WATERMARK_BYTES).toBe(256 * 1024);
    expect(LOW_WATERMARK_BYTES).toBe(64 * 1024);
    expect(BATCH_FLUSH_BYTES).toBe(64 * 1024);
    expect(BATCH_FLUSH_MS).toBe(12);
    // Hysteresis is real (high strictly above low) so pause/resume can't thrash.
    expect(HIGH_WATERMARK_BYTES).toBeGreaterThan(LOW_WATERMARK_BYTES);
    // The pause backstop is far above any healthy renderer's drain time yet
    // bounded, so a stalled frame can't hold a pty paused into node-pty's
    // exit-drain window (L3).
    expect(PAUSE_WATCHDOG_MS).toBeGreaterThan(0);
  });
});
