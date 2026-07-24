// Per-session holding buffer for pty output that arrives mid-transition.
//
// A tab switch is an async serialize/hydrate round-trip: for the duration, a
// session has no destination — its worker Terminal has been serialized away and
// its DOM Terminal does not exist yet. `onTermData` parks those chunks here and
// the controller flushes them once the winning side exists (internals
// §terminal-worker).
//
// The one rule that makes this safe: a buffer is dropped only when its bytes
// have somewhere to go. The flush used to delete first and write through an
// optional chain, so a flush that found no DOM Terminal — `mountForSession`
// bailed on its race guard, or its dynamic import threw — discarded the chunks
// silently. That is a *data* loss, not a display one: main keeps only a 64 KB
// pty tail, so no amount of Refresh brings those bytes back.
//
// Retaining on a failed flush trades a bounded loss for an unbounded one unless
// the buffer is capped: a session whose mount never lands (the throw above, with
// the reconcile chain swallowing it) has nothing scheduled to flush it again, so
// a chatty pty would grow the buffer for the app's lifetime. Hence the cap
// below, evicting oldest-first.
//
// Free of any Solid / xterm / DOM import so it unit-tests under the node vitest
// env, mirroring the nudge-machine / visibility-plan split.

/** How many characters a single session may park before the oldest chunks are
 *  evicted. Main itself only retains a 64 KB pty tail per session, so anything
 *  beyond a few multiples of that could never have been replayed anyway; the
 *  cap exists so a session that never regains a destination cannot grow without
 *  bound. Eviction is oldest-first because a terminal shows the newest output. */
const MAX_BUFFERED_CHARS = 256 * 1024;

/** Holding buffers for sessions with no live destination, keyed by session id. */
export interface TransitionBuffers {
  /** Park a chunk for `id`, in arrival order, evicting the oldest chunks when
   *  the session is over {@link MAX_BUFFERED_CHARS}. */
  buffer(id: string, chunk: string): void;
  /** Whether `id` has parked bytes waiting — the caller must not write past
   *  them, or the newer chunk lands ahead of the older ones. */
  pending(id: string): boolean;
  /** Put bytes back at the FRONT — the mirror of {@link take}, for a caller that
   *  took a replay and then failed to mount the terminal it was for. They
   *  predate anything parked since, so they go first. */
  restore(id: string, data: string): void;
  /**
   * Hand `id`'s parked bytes to `write`, dropping them only if it delivered.
   *
   * @param id The session.
   * @param write Sink for the joined chunks; returns whether it took them.
   */
  flush(id: string, write: (data: string) => boolean): void;
  /** Take `id`'s parked bytes and clear them — the replay path, where the caller
   *  owns the bytes from here on (they are written into a fresh Terminal). */
  take(id: string): string;
  /** Discard `id`'s parked bytes (the session is gone, or they are already part
   *  of a replay the caller has in hand). */
  drop(id: string): void;
  /** Discard every buffer (controller teardown). */
  clear(): void;
}

/** One session's parked output plus its running length, so a push is O(1) rather
 *  than re-measuring the whole buffer. */
interface Parked {
  chunks: string[];
  length: number;
}

/** Build an empty {@link TransitionBuffers}. */
export function createTransitionBuffers(): TransitionBuffers {
  const buffers = new Map<string, Parked>();
  /** Drop oldest-first until the session is back under the cap. Never evicts the
   *  only chunk: a single oversized chunk is one write, and losing it whole is
   *  worse than briefly exceeding the cap. */
  const evict = (parked: Parked): void => {
    while (parked.length > MAX_BUFFERED_CHARS && parked.chunks.length > 1) {
      parked.length -= parked.chunks.shift()!.length;
    }
  };
  return {
    buffer: (id, chunk) => {
      const parked = buffers.get(id) ?? { chunks: [], length: 0 };
      parked.chunks.push(chunk);
      parked.length += chunk.length;
      evict(parked);
      buffers.set(id, parked);
    },
    pending: (id) => (buffers.get(id)?.chunks.length ?? 0) > 0,
    restore: (id, data) => {
      if (data === '') return;
      const parked = buffers.get(id) ?? { chunks: [], length: 0 };
      parked.chunks.unshift(data);
      parked.length += data.length;
      evict(parked);
      buffers.set(id, parked);
    },
    flush: (id, write) => {
      const parked = buffers.get(id);
      if (!parked || parked.chunks.length === 0) return;
      // Keep the chunks parked unless the sink took them: a flush with no
      // destination must leave the bytes recoverable by the next flush.
      if (!write(parked.chunks.join(''))) return;
      buffers.delete(id);
    },
    take: (id) => {
      const parked = buffers.get(id);
      buffers.delete(id);
      return parked?.chunks.join('') ?? '';
    },
    drop: (id) => {
      buffers.delete(id);
    },
    clear: () => buffers.clear(),
  };
}
