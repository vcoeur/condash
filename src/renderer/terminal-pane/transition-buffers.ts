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
// Free of any Solid / xterm / DOM import so it unit-tests under the node vitest
// env, mirroring the nudge-machine / visibility-plan split.

/** Holding buffers for sessions with no live destination, keyed by session id. */
export interface TransitionBuffers {
  /** Park a chunk for `id`, in arrival order. */
  buffer(id: string, chunk: string): void;
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

/** Build an empty {@link TransitionBuffers}. */
export function createTransitionBuffers(): TransitionBuffers {
  const buffers = new Map<string, string[]>();
  return {
    buffer: (id, chunk) => {
      const chunks = buffers.get(id);
      if (chunks) chunks.push(chunk);
      else buffers.set(id, [chunk]);
    },
    flush: (id, write) => {
      const chunks = buffers.get(id);
      if (!chunks || chunks.length === 0) return;
      // Keep the chunks parked unless the sink took them: a flush with no
      // destination must leave the bytes recoverable by the next flush.
      if (!write(chunks.join(''))) return;
      buffers.delete(id);
    },
    take: (id) => {
      const chunks = buffers.get(id);
      buffers.delete(id);
      return chunks?.join('') ?? '';
    },
    drop: (id) => {
      buffers.delete(id);
    },
    clear: () => buffers.clear(),
  };
}
