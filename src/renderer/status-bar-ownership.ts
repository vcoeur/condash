/**
 * Single-flight/trailing ownership for the status-bar snapshots (auto-sync
 * + shipped skills). One owner per snapshot; the two never share state.
 *
 * The contract, per the race-safe freshness plan:
 *
 *   - At most one request per snapshot is in flight. A trigger (push,
 *     poll, popover open, install follow-up) that lands during a flight
 *     coalesces into exactly one trailing read after it settles — changes
 *     during the trailing read open one further dirty period.
 *   - Every request captures the context generation. A conception switch
 *     bumps the generation and permanently invalidates every in-flight
 *     response from the prior context, even when an old read resolves
 *     after the new context's reads.
 *   - A failed read retains the last applied snapshot (the caller simply
 *     never applies) and does not retry on its own; a queued trailing read
 *     still runs, since the trigger it services has not been answered.
 *   - `dispose` suppresses applies and trailing scheduling; it is
 *     idempotent, so repeated cleanup is tolerated.
 *
 * Deliberately not a shared framework: this exists only for the two
 * status-bar snapshots and is unit-tested in
 * `status-bar-ownership.test.ts`.
 */

export interface SnapshotOwner {
  /** Request a fresh snapshot for the current context. */
  refresh(): Promise<void>;
  /** The context changed (conception switch): invalidate every in-flight
   *  response permanently and start a fresh read. */
  recontext(): Promise<void>;
  /** Stop applying and stop scheduling; idempotent. */
  dispose(): void;
}

export function createSnapshotOwner<T>(deps: {
  fetch: () => Promise<T>;
  apply: (value: T) => void;
}): SnapshotOwner {
  let disposed = false;
  /** Bumped on every context switch; in-flight responses from a prior
   *  generation never apply, whatever order they resolve in. */
  let generation = 0;
  /** Reads started and not settled for the current generation. */
  let inFlight = 0;
  /** A trigger landed during a flight: one trailing read is owed. */
  let trailingOwed = false;
  /** The most recent read's settlement, returned to coalesced callers. */
  let settled: Promise<void> = Promise.resolve();

  const maybeTrail = (readGeneration: number): void => {
    if (disposed || readGeneration !== generation) return;
    if (trailingOwed && inFlight === 0) {
      trailingOwed = false;
      settled = pump();
    }
  };

  const pump = (): Promise<void> => {
    const readGeneration = generation;
    inFlight += 1;
    const request = deps.fetch().then(
      (value) => {
        inFlight -= 1;
        if (!disposed && readGeneration === generation) deps.apply(value);
        maybeTrail(readGeneration);
      },
      () => {
        // Failure retains the last applied snapshot; only a trigger that
        // arrived during this read still owes its trailing read.
        inFlight -= 1;
        maybeTrail(readGeneration);
      },
    );
    settled = request;
    return request;
  };

  return {
    refresh: () => {
      if (disposed) return Promise.resolve();
      if (inFlight > 0) {
        trailingOwed = true;
        return settled;
      }
      return pump();
    },
    recontext: () => {
      generation += 1;
      trailingOwed = false;
      if (disposed) return Promise.resolve();
      return pump();
    },
    dispose: () => {
      disposed = true;
      trailingOwed = false;
    },
  };
}
