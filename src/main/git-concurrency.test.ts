/**
 * Tests for the read-only git-lookup cap (#475). The Code pane's repo scan
 * issues its git calls from several nested fan-outs, so what has to hold is a
 * ceiling on lookups *in flight*, not on any one `Promise.all`'s width. The
 * hand-off on release is the subtle half: a naive release (decrement, then wake
 * a waiter) leaves a window in which a fresh caller sees a free slot and
 * overshoots, which is exactly the burst the cap exists to prevent.
 */
import { describe, expect, it, vi } from 'vitest';
import { GIT_SLOT_LIMIT, withGitSlot } from './git-concurrency';

interface Deferred {
  promise: Promise<string>;
  resolve: (value: string) => void;
}

function deferred(): Deferred {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('withGitSlot', () => {
  it('never runs more than GIT_SLOT_LIMIT lookups at once', async () => {
    const total = GIT_SLOT_LIMIT * 4;
    const gates = Array.from({ length: total }, () => deferred());
    let live = 0;
    let peak = 0;
    let started = 0;

    const runs = gates.map((gate) =>
      withGitSlot(async () => {
        live++;
        started++;
        peak = Math.max(peak, live);
        try {
          return await gate.promise;
        } finally {
          live--;
        }
      }),
    );

    // Nothing has resolved yet, so the cap alone decides how many entered.
    await vi.waitFor(() => expect(started).toBe(GIT_SLOT_LIMIT));
    expect(peak).toBe(GIT_SLOT_LIMIT);

    // Release one at a time: each completion admits exactly one waiter, so the
    // ceiling holds all the way through the queue rather than only at the top.
    for (const gate of gates) gate.resolve('ok');
    await Promise.all(runs);

    expect(started).toBe(total);
    expect(peak).toBe(GIT_SLOT_LIMIT);
    expect(live).toBe(0);
  });

  it('releases the slot when the lookup rejects', async () => {
    const failures = Array.from({ length: GIT_SLOT_LIMIT }, () =>
      withGitSlot(() => Promise.reject(new Error('git exploded'))).catch(() => 'caught'),
    );
    expect(await Promise.all(failures)).toEqual(Array(GIT_SLOT_LIMIT).fill('caught'));
    // A leaked slot would leave the gate permanently full and hang this call.
    expect(await withGitSlot(() => Promise.resolve('after'))).toBe('after');
  });

  it('admits waiters in FIFO order', async () => {
    const blocker = deferred();
    const held = Array.from({ length: GIT_SLOT_LIMIT }, () => withGitSlot(() => blocker.promise));
    const order: number[] = [];
    const queued = [0, 1, 2].map((i) =>
      withGitSlot(async () => {
        order.push(i);
      }),
    );

    blocker.resolve('ok');
    await Promise.all([...held, ...queued]);
    expect(order).toEqual([0, 1, 2]);
  });
});
