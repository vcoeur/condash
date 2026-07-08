/**
 * Unit tests for the TerminalWorkerManager RPC watchdog (R1). A round-trip RPC
 * whose reply never arrives (crashed / wedged worker thread) must reject after
 * the timeout so the controller's `transitioning` `finally` runs — rather than
 * pinning that tab (and, pre-fix, every tab's focus-promotion) forever. A normal
 * reply resolves and clears the watchdog so no late rejection fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalWorkerManager } from './terminal-worker-manager';

type WorkerMessageHandler = (ev: unknown) => void;

let lastWorker: FakeWorker | null = null;

/** A Worker stand-in that never replies unless the test drives `onmessage`. */
class FakeWorker {
  onmessage: WorkerMessageHandler | null = null;
  onerror: WorkerMessageHandler | null = null;
  constructor() {
    lastWorker = this;
  }
  postMessage(): void {
    /* swallow — the test decides whether/when a reply arrives */
  }
  terminate(): void {}
}

beforeEach(() => {
  vi.useFakeTimers();
  lastWorker = null;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe('TerminalWorkerManager RPC watchdog', () => {
  it('rejects a round-trip RPC when no reply arrives before the timeout', async () => {
    const mgr = new TerminalWorkerManager();
    const pending = mgr.serialize('s1');
    // Guard against an unhandled-rejection warning before the assertion runs.
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('resolves and clears the watchdog when the worker replies', async () => {
    const mgr = new TerminalWorkerManager();
    const pending = mgr.serialize('s1'); // rid 0
    // Simulate the worker answering rid 0.
    lastWorker?.onmessage?.({ data: { type: 'serialize', rid: 0, data: 'snapshot' } });
    await expect(pending).resolves.toBe('snapshot');
    // Advancing past the timeout must NOT reject — the watchdog was cleared.
    await vi.advanceTimersByTimeAsync(20_000);
  });

  it('does not arm a watchdog for fire-and-forget writes', async () => {
    const mgr = new TerminalWorkerManager();
    // write() is one-way (no rid, no pending entry); advancing timers must not
    // throw or reject anything.
    mgr.write('s1', 'data');
    await vi.advanceTimersByTimeAsync(20_000);
  });
});
