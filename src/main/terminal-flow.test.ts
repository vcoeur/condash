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
 *  separately below. */
function makeFlow(over: TerminalFlowOptions = {}) {
  const sent: string[] = [];
  const pty = fakePty();
  const flow = new TerminalFlow(
    (data) => sent.push(data),
    () => pty,
    {
      highWatermark: 20,
      lowWatermark: 8,
      flushBytes: 10,
      flushMs: 12,
      ...over,
    },
  );
  return { flow, sent, pty };
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
      (d) => sent.push(d),
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

describe('TerminalFlow — production thresholds', () => {
  it('exports the documented watermark + batch constants', () => {
    expect(HIGH_WATERMARK_BYTES).toBe(256 * 1024);
    expect(LOW_WATERMARK_BYTES).toBe(64 * 1024);
    expect(BATCH_FLUSH_BYTES).toBe(64 * 1024);
    expect(BATCH_FLUSH_MS).toBe(12);
    // Hysteresis is real (high strictly above low) so pause/resume can't thrash.
    expect(HIGH_WATERMARK_BYTES).toBeGreaterThan(LOW_WATERMARK_BYTES);
  });
});
